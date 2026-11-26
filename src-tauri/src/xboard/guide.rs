use super::{Error, MANAGED_UID, Result, STATE, api, managed, parse_subscription, store};
use crate::{
    config::{
        Config, IVerge,
        profiles::{PROFILE_WRITE_LOCK, record_selected_node, supersede_selected_activation},
        runtime::IRuntime,
    },
    core::{
        CoreManager,
        handle::Handle,
        notify::{Refresh, announce},
    },
};
use futures::{StreamExt as _, stream};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    future::Future,
    sync::{Arc, LazyLock},
    time::Duration,
};
use tauri_plugin_mihomo::models::{Proxies, ProxyType};
use tokio::sync::Mutex;

const TEST_URL: &str = "https://www.gstatic.com/generate_204";
const MAIN_GROUP: &str = "🚀节点选择";
const AUTO_POLICY: &str = "自动选择";
const FAILOVER_POLICY: &str = "故障转移";
const MAX_CANDIDATES: usize = 128;
const CHECK_TIMEOUT: Duration = Duration::from_secs(45);
static GUIDE: LazyLock<parking_lot::Mutex<Guide>> = LazyLock::new(|| parking_lot::Mutex::new(Guide::default()));
static EFFECTS: Mutex<()> = Mutex::const_new(());

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum XboardGuidePhase {
    #[default]
    Idle,
    Syncing,
    Testing,
    Ready,
    Connecting,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum XboardGuideMode {
    Tun,
    #[default]
    System,
}

#[derive(Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum XboardGuideFailureStage {
    Prepare,
    Connect,
}

#[derive(Clone, Default, Serialize, specta::Type)]
pub struct XboardGuideSnapshot {
    pub attempt_id: u64,
    pub phase: XboardGuidePhase,
    pub mode: XboardGuideMode,
    pub group_name: Option<String>,
    pub node_name: Option<String>,
    pub latency_ms: Option<u32>,
    pub error: Option<String>,
    pub error_stage: Option<XboardGuideFailureStage>,
    pub tested: u32,
    pub total: u32,
}

#[derive(Default)]
struct Guide {
    eligible: bool,
    pending: bool,
    snapshot: XboardGuideSnapshot,
    prepared: Option<Prepared>,
}

impl Guide {
    const fn is_current(&self, id: u64) -> bool {
        self.pending && self.snapshot.attempt_id == id
    }

    const fn can_connect(&self, id: u64) -> bool {
        self.is_current(id)
            && self.prepared.is_some()
            && matches!(self.snapshot.phase, XboardGuidePhase::Ready | XboardGuidePhase::Failed)
    }

    fn invalidate(&mut self) -> bool {
        if !self.pending {
            return false;
        }
        self.pending = false;
        self.snapshot.attempt_id = self.snapshot.attempt_id.wrapping_add(1);
        self.snapshot.phase = XboardGuidePhase::Cancelled;
        self.prepared = None;
        true
    }
}

#[derive(Clone)]
struct Identity {
    email: String,
    bearer: String,
}

#[derive(Clone)]
struct Configuration {
    #[expect(
        clippy::redundant_allocation,
        reason = "Config::runtime stores Box<IRuntime>; keep its outer Arc identity to detect replacement."
    )]
    runtime: Arc<Box<IRuntime>>,
    generation: Option<u64>,
    profile: Option<String>,
    file: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Selection {
    group: String,
    node: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Candidate {
    probe: String,
    path: Vec<Selection>,
    automatic: bool,
}

#[derive(Clone)]
struct Prepared {
    identity: Identity,
    configuration: Configuration,
    candidate: Candidate,
}

const fn changed() -> Error {
    Error::new(
        "XBOARD_GUIDE_CHANGED",
        "The connection setup changed. Retry the connection check.",
    )
}

const fn unavailable() -> Error {
    Error::new(
        "XBOARD_GUIDE_NO_ROUTE",
        "No usable proxy route was found. Retry the connection check.",
    )
}

pub fn pending() -> bool {
    GUIDE.lock().pending
}

pub fn snapshot() -> XboardGuideSnapshot {
    GUIDE.lock().snapshot.clone()
}

fn current(id: u64) -> bool {
    GUIDE.lock().is_current(id)
}

fn check(id: u64) -> Result<()> {
    if current(id) { Ok(()) } else { Err(changed()) }
}

pub(super) async fn initialize(legacy_account: bool) -> Result<()> {
    let marker = store::guide_state().await?;
    let eligible = eligible_install(marker.as_deref(), legacy_account);
    // An interrupted attempt never starts network selection or proxy activation on a later launch.
    if !eligible && marker.as_deref() != Some("complete") && marker.as_deref() != Some("skipped") {
        store::save_guide_state("skipped").await?;
    }
    GUIDE.lock().eligible = eligible;
    Ok(())
}

const fn eligible_install(marker: Option<&str>, legacy_account: bool) -> bool {
    marker.is_none() && !legacy_account
}

pub(super) async fn begin_first_login() -> Result<bool> {
    if !GUIDE.lock().eligible {
        return Ok(false);
    }
    if !interception_disabled().await {
        store::save_guide_state("skipped").await?;
        GUIDE.lock().eligible = false;
        return Ok(false);
    }
    store::save_guide_state("pending").await?;
    let mut guide = GUIDE.lock();
    guide.eligible = false;
    guide.pending = true;
    guide.snapshot = XboardGuideSnapshot::default();
    drop(guide);
    Ok(true)
}

fn invalidate() -> bool {
    GUIDE.lock().invalidate()
}

pub(super) async fn retire_session() {
    if invalidate() {
        let _ = store::save_guide_state("skipped").await;
    }
}

pub async fn manual_override() -> Result<()> {
    let invalidated = invalidate();
    // Invalidate immediately, then let an already-started transaction settle before a manual write.
    let effects = EFFECTS.lock().await;
    let result = if invalidated {
        store::save_guide_state("skipped").await
    } else {
        Ok(())
    };
    drop(effects);
    result
}

pub async fn cancel() -> Result<XboardGuideSnapshot> {
    manual_override().await?;
    Ok(snapshot())
}

pub async fn complete(id: u64) -> Result<XboardGuideSnapshot> {
    let effects = EFFECTS.lock().await;
    check(id)?;
    if snapshot().phase != XboardGuidePhase::Succeeded {
        return Err(changed());
    }
    store::save_guide_state("complete").await?;
    {
        let mut guide = GUIDE.lock();
        if guide.snapshot.attempt_id == id {
            guide.pending = false;
            guide.prepared = None;
        }
    }
    drop(effects);
    Ok(snapshot())
}

async fn cancellable<T: Send>(id: u64, future: impl Future<Output = Result<T>> + Send) -> Result<T> {
    check(id)?;
    tokio::select! {
        result = future => { check(id)?; result }
        _ = async { while current(id) { tokio::time::sleep(Duration::from_millis(50)).await; } } => Err(changed()),
    }
}

fn fail(id: u64, stage: XboardGuideFailureStage, error: &Error) {
    let mut guide = GUIDE.lock();
    if guide.pending && guide.snapshot.attempt_id == id {
        guide.snapshot.phase = XboardGuidePhase::Failed;
        guide.snapshot.error = Some(error.to_string());
        if matches!(error.code, "XBOARD_GUIDE_CHANGED" | "XBOARD_GUIDE_NO_ROUTE") {
            guide.snapshot.error_stage = Some(XboardGuideFailureStage::Prepare);
            guide.prepared = None;
        } else {
            guide.snapshot.error_stage = Some(stage);
        }
    }
}

pub fn prepare() -> Result<XboardGuideSnapshot> {
    let id = {
        let mut guide = GUIDE.lock();
        if !guide.pending {
            return Err(changed());
        }
        if matches!(
            guide.snapshot.phase,
            XboardGuidePhase::Syncing | XboardGuidePhase::Testing | XboardGuidePhase::Connecting
        ) {
            return Ok(guide.snapshot.clone());
        }
        let id = guide.snapshot.attempt_id.wrapping_add(1);
        guide.snapshot = XboardGuideSnapshot {
            attempt_id: id,
            phase: XboardGuidePhase::Syncing,
            ..Default::default()
        };
        guide.prepared = None;
        drop(guide);
        id
    };
    crate::process::AsyncHandler::spawn(move || async move {
        if let Err(error) = prepare_inner(id).await {
            fail(id, XboardGuideFailureStage::Prepare, &error);
        }
    });
    Ok(snapshot())
}

async fn configuration() -> Configuration {
    let profiles = Config::profiles().await.latest_arc();
    let profile = profiles.current.as_ref().map(ToString::to_string);
    let file = profiles
        .current
        .as_deref()
        .and_then(|uid| profiles.get_item(uid).ok())
        .and_then(|item| item.file.as_ref().map(ToString::to_string));
    drop(profiles);
    Configuration {
        runtime: Config::runtime().await.latest_arc(),
        generation: CoreManager::global().current_core_readiness_generation(),
        profile,
        file,
    }
}

async fn configuration_matches(expected: &Configuration) -> bool {
    let actual = configuration().await;
    Arc::ptr_eq(&expected.runtime, &actual.runtime)
        && expected.generation == actual.generation
        && expected.profile == actual.profile
        && expected.file == actual.file
}

fn identity_matches(identity: &Identity, state: &super::State) -> bool {
    state
        .binding
        .as_ref()
        .is_some_and(|binding| binding.email == identity.email && binding.bearer == identity.bearer)
}

async fn interception_disabled() -> bool {
    let verge = Config::verge().await.latest_arc();
    !verge.enable_tun_mode.unwrap_or(false) && !verge.enable_system_proxy.unwrap_or(false)
}

async fn fetch_subscription(id: u64, identity: &Identity) -> Result<super::SubscriptionRecord> {
    let metadata = match cancellable(id, api::subscription(&identity.bearer)).await {
        Err(error) if error.code == "XBOARD_SESSION_EXPIRED" => {
            let effects = EFFECTS.lock().await;
            let mut state = STATE.lock().await;
            if current(id) && identity_matches(identity, &state) {
                state.clear().await?;
            }
            drop(state);
            drop(effects);
            return Err(error);
        }
        result => result?,
    };
    let subscription = parse_subscription(&metadata)?;
    if subscription.summary.plan_id.is_none()
        || subscription
            .summary
            .expired_at
            .is_some_and(|expiry| expiry <= super::now())
    {
        return Err(Error::unavailable());
    }
    Ok(subscription)
}

async fn prepare_inner(id: u64) -> Result<()> {
    let identity = {
        let state = STATE.lock().await;
        let binding = state.binding.as_ref().ok_or_else(Error::session_expired)?;
        let identity = Identity {
            email: binding.email.clone(),
            bearer: binding.bearer.clone(),
        };
        drop(state);
        identity
    };
    let initial = configuration().await;
    if !interception_disabled().await {
        return Err(changed());
    }
    let subscription = fetch_subscription(id, &identity).await?;
    let content = cancellable(id, api::download(&subscription.url)).await?;
    let effects = EFFECTS.lock().await;
    let mut state = STATE.lock().await;
    check(id)?;
    if !identity_matches(&identity, &state) || !configuration_matches(&initial).await || !interception_disabled().await
    {
        return Err(changed());
    }
    // Cancellation waits for this existing profile transaction; downloaded bytes alone never commit.
    managed::install(&content, &subscription.summary, true).await?;
    if let Some(binding) = state.binding.as_mut() {
        binding.subscription = Some(subscription);
        binding.profile_uid = Some(MANAGED_UID.into());
        binding.last_sync = Some(super::now());
        store::save(binding).await?;
    }
    state.error = None;
    drop(state);
    let configuration = configuration().await;
    drop(effects);
    check(id)?;
    if configuration.profile.as_deref() != Some(MANAGED_UID) {
        return Err(changed());
    }
    let proxies = cancellable(id, async {
        tokio::time::timeout(Duration::from_secs(8), Handle::mihomo().get_proxies())
            .await
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())
    })
    .await?;
    let candidates = candidates(&proxies);
    if candidates.is_empty() {
        return Err(unavailable());
    }
    {
        let mut guide = GUIDE.lock();
        if guide.snapshot.attempt_id == id {
            guide.snapshot.phase = XboardGuidePhase::Testing;
            guide.snapshot.total = candidates.len() as u32;
        }
    }
    let (candidate, latency) = probe_routes(id, &identity, &configuration, candidates).await?;
    let prepared = Prepared {
        identity,
        configuration,
        candidate,
    };
    apply_selection(id, &prepared).await?;
    let mut guide = GUIDE.lock();
    if guide.pending && guide.snapshot.attempt_id == id {
        guide.snapshot.phase = XboardGuidePhase::Ready;
        guide.snapshot.group_name = prepared.candidate.path.first().map(|selection| selection.group.clone());
        guide.snapshot.node_name = Some(prepared.candidate.probe.clone());
        guide.snapshot.latency_ms = Some(latency);
        guide.prepared = Some(prepared);
    }
    drop(guide);
    Ok(())
}

fn candidates(proxies: &Proxies) -> Vec<Candidate> {
    let mut seen = HashSet::new();
    proxies
        .proxies
        .get(MAIN_GROUP)
        .filter(|group| group.proxy_type == ProxyType::Selector)
        .and_then(|group| group.all.as_ref())
        .into_iter()
        .flatten()
        .filter_map(|name| {
            let proxy = proxies.proxies.get(name)?;
            let automatic = match (name.as_str(), &proxy.proxy_type) {
                (AUTO_POLICY, ProxyType::URLTest) | (FAILOVER_POLICY, ProxyType::Fallback) => true,
                (
                    _,
                    ProxyType::Selector
                    | ProxyType::URLTest
                    | ProxyType::Fallback
                    | ProxyType::LoadBalance
                    | ProxyType::Relay
                    | ProxyType::Direct
                    | ProxyType::Reject
                    | ProxyType::RejectDrop
                    | ProxyType::Compatible
                    | ProxyType::Pass
                    | ProxyType::PassRule
                    | ProxyType::Dns,
                ) => return None,
                _ if proxy.all.is_none() => false,
                _ => return None,
            };
            seen.insert(name).then(|| Candidate {
                probe: name.clone(),
                path: vec![Selection {
                    group: MAIN_GROUP.into(),
                    node: name.clone(),
                }],
                automatic,
            })
        })
        .take(MAX_CANDIDATES)
        .collect()
}

fn candidate_batches(mut candidates: Vec<Candidate>) -> Vec<Vec<Candidate>> {
    let mut batches = Vec::new();
    for policy in [AUTO_POLICY, FAILOVER_POLICY] {
        if let Some(index) = candidates
            .iter()
            .position(|candidate| candidate.automatic && candidate.probe == policy)
        {
            batches.push(vec![candidates.remove(index)]);
        }
    }
    if !candidates.is_empty() {
        batches.push(candidates);
    }
    batches
}

async fn probe_routes(
    id: u64,
    identity: &Identity,
    configuration: &Configuration,
    candidates: Vec<Candidate>,
) -> Result<(Candidate, u32)> {
    let deadline = tokio::time::Instant::now() + CHECK_TIMEOUT;
    for mut batch in candidate_batches(candidates) {
        refresh_automatic_groups(id, identity, configuration, &batch, deadline).await?;
        let proxies = within(deadline, Duration::from_secs(3), Handle::mihomo().get_proxies())
            .await?
            .map_err(|_| unavailable())?;
        batch.retain(|candidate| proxy_route(&proxies, &candidate.probe));
        if let Some(winner) = probe_candidates(id, batch, deadline).await? {
            return Ok(winner);
        }
    }
    Err(unavailable())
}

fn proxy_route(proxies: &Proxies, name: &str) -> bool {
    resolve_proxy_route(proxies, name, &mut HashSet::new())
}

fn resolve_proxy_route(proxies: &Proxies, name: &str, visited: &mut HashSet<String>) -> bool {
    if visited.len() >= 16 || !visited.insert(name.to_owned()) {
        return false;
    }
    let valid = proxies.proxies.get(name).is_some_and(|proxy| match &proxy.proxy_type {
        ProxyType::Direct
        | ProxyType::Reject
        | ProxyType::RejectDrop
        | ProxyType::Compatible
        | ProxyType::Pass
        | ProxyType::PassRule
        | ProxyType::Dns => false,
        ProxyType::Selector | ProxyType::URLTest | ProxyType::Fallback => proxy
            .now
            .as_deref()
            .is_some_and(|selected| resolve_proxy_route(proxies, selected, visited)),
        ProxyType::LoadBalance | ProxyType::Relay => proxy.all.as_deref().is_some_and(|members| {
            !members.is_empty()
                && members
                    .iter()
                    .all(|member| resolve_proxy_route(proxies, member, visited))
        }),
        _ => proxy.all.is_none(),
    });
    visited.remove(name);
    valid
}

async fn within<T: Send>(
    deadline: tokio::time::Instant,
    budget: Duration,
    future: impl Future<Output = T> + Send,
) -> Result<T> {
    tokio::time::timeout_at(deadline.min(tokio::time::Instant::now() + budget), future)
        .await
        .map_err(|_| unavailable())
}

async fn refresh_automatic_groups(
    id: u64,
    identity: &Identity,
    configuration: &Configuration,
    candidates: &[Candidate],
    deadline: tokio::time::Instant,
) -> Result<()> {
    for candidate in candidates.iter().filter(|candidate| candidate.automatic) {
        if deadline.saturating_duration_since(tokio::time::Instant::now()) < Duration::from_secs(10) {
            break;
        }
        let effects = within(deadline, CHECK_TIMEOUT, EFFECTS.lock()).await?;
        let state = within(deadline, CHECK_TIMEOUT, STATE.lock()).await?;
        let config_write = within(deadline, CHECK_TIMEOUT, Config::lock_config_write()).await?;
        check(id)?;
        if !identity_matches(identity, &state) || !configuration_matches(configuration).await {
            return Err(changed());
        }
        let update = CoreManager::global()
            .claim_config_update(&config_write)
            .map_err(|_| changed())?;
        let group = within(
            deadline,
            Duration::from_secs(3),
            Handle::mihomo().get_proxy_by_name(&candidate.probe),
        )
        .await
        .ok()
        .and_then(std::result::Result::ok);
        if let Some(group) = group.filter(|group| group.fixed.as_deref().is_none_or(str::is_empty)) {
            // Mihomo clears fixed selection before its bounded health check. Keep manual writers outside this request.
            let url = group
                .test_url
                .as_deref()
                .filter(|url| !url.is_empty())
                .unwrap_or(TEST_URL);
            let _ = within(
                deadline,
                Duration::from_secs(6),
                Handle::mihomo().delay_group(&candidate.probe, url, 4000),
            )
            .await;
        }
        drop(update);
        drop(config_write);
        drop(state);
        drop(effects);
        check(id)?;
    }
    Ok(())
}

async fn probe_candidates(
    id: u64,
    candidates: Vec<Candidate>,
    deadline: tokio::time::Instant,
) -> Result<Option<(Candidate, u32)>> {
    let operation = async {
        let mut probes = stream::iter(candidates)
            .map(|candidate| async move {
                let measured = tokio::time::timeout(
                    Duration::from_secs(6),
                    Handle::mihomo().delay_proxy_by_name(&candidate.probe, TEST_URL, 4000),
                )
                .await;
                let mut latency = measured
                    .ok()
                    .and_then(std::result::Result::ok)
                    .map(|delay| delay.delay)
                    .filter(|delay| *delay > 0 && *delay <= 4000);
                if candidate.automatic && latency.is_some() {
                    let current = within(deadline, Duration::from_secs(3), Handle::mihomo().get_proxies()).await;
                    if !current.is_ok_and(|result| result.is_ok_and(|proxies| proxy_route(&proxies, &candidate.probe)))
                    {
                        latency = None;
                    }
                }
                (candidate, latency)
            })
            .buffer_unordered(4);
        let mut best: Option<(Candidate, u32)> = None;
        while let Ok(Some((candidate, latency))) = tokio::time::timeout_at(deadline, probes.next()).await {
            check(id)?;
            {
                let mut guide = GUIDE.lock();
                if guide.snapshot.attempt_id == id {
                    guide.snapshot.tested += 1;
                }
            }
            keep_fastest(&mut best, candidate, latency);
        }
        Ok(best)
    };
    cancellable(id, operation).await
}

fn keep_fastest(best: &mut Option<(Candidate, u32)>, candidate: Candidate, latency: Option<u32>) {
    if let Some(latency) = latency.filter(|latency| *latency > 0)
        && best.as_ref().is_none_or(|(_, previous)| latency < *previous)
    {
        *best = Some((candidate, latency));
    }
}

async fn apply_selection(id: u64, prepared: &Prepared) -> Result<()> {
    let effects = EFFECTS.lock().await;
    let state = STATE.lock().await;
    let profile_write = PROFILE_WRITE_LOCK.lock().await;
    let config_write = Config::lock_config_write().await;
    check(id)?;
    if !identity_matches(&prepared.identity, &state)
        || !configuration_matches(&prepared.configuration).await
        || !interception_disabled().await
    {
        return Err(changed());
    }
    let update = CoreManager::global()
        .claim_config_update(&config_write)
        .map_err(|_| changed())?;
    supersede_selected_activation();
    for selection in prepared.candidate.path.iter().rev() {
        check(id)?;
        tokio::time::timeout(
            Duration::from_secs(10),
            Handle::mihomo().select_node_for_group(&selection.group, &selection.node),
        )
        .await
        .map_err(|_| unavailable())?
        .map_err(|_| unavailable())?;
        check(id)?;
        record_selected_node(&selection.group, &selection.node)
            .await
            .map_err(|_| Error::storage())?;
    }
    drop(update);
    drop(config_write);
    drop(profile_write);
    drop(state);
    drop(effects);
    announce(Refresh::Proxies);
    Ok(())
}

pub fn connect(id: u64, mode: XboardGuideMode) -> Result<XboardGuideSnapshot> {
    let prepared = {
        let mut guide = GUIDE.lock();
        if !guide.pending || guide.snapshot.attempt_id != id {
            return Err(changed());
        }
        if guide.snapshot.phase == XboardGuidePhase::Connecting {
            return Ok(guide.snapshot.clone());
        }
        if !guide.can_connect(id) {
            return Err(changed());
        }
        let prepared = guide.prepared.clone().ok_or_else(changed)?;
        guide.snapshot.phase = XboardGuidePhase::Connecting;
        guide.snapshot.mode = mode;
        guide.snapshot.error = None;
        guide.snapshot.error_stage = None;
        drop(guide);
        prepared
    };
    crate::process::AsyncHandler::spawn(move || async move {
        if let Err(error) = connect_inner(id, mode, prepared).await {
            fail(id, XboardGuideFailureStage::Connect, &error);
        }
    });
    Ok(snapshot())
}

const fn connection_error(mode: XboardGuideMode) -> Error {
    match mode {
        XboardGuideMode::Tun => Error::new(
            "XBOARD_GUIDE_TUN_FAILED",
            "TUN could not be enabled. Retry or choose system proxy.",
        ),
        XboardGuideMode::System => Error::new(
            "XBOARD_GUIDE_SYSTEM_FAILED",
            "The system proxy could not be enabled. Retry the connection.",
        ),
    }
}

async fn verify_connection(id: u64, mode: XboardGuideMode, candidate: &Candidate) -> Result<()> {
    check(id)?;
    let verge = Config::verge().await.latest_arc();
    if verge.enable_tun_mode.unwrap_or(false) != (mode == XboardGuideMode::Tun)
        || verge.enable_system_proxy.unwrap_or(false) != (mode == XboardGuideMode::System)
    {
        return Err(connection_error(mode));
    }
    drop(verge);
    let core = tokio::time::timeout(Duration::from_secs(10), Handle::mihomo().get_base_config())
        .await
        .map_err(|_| connection_error(mode))?
        .map_err(|_| connection_error(mode))?;
    if core.tun.enable != (mode == XboardGuideMode::Tun) {
        return Err(connection_error(mode));
    }
    if mode == XboardGuideMode::System {
        let system = sysproxy::Sysproxy::get_system_proxy().map_err(|_| connection_error(mode))?;
        if !system.enable || system.port != core.mixed_port {
            return Err(connection_error(mode));
        }
    }
    let proxies = tokio::time::timeout(Duration::from_secs(10), Handle::mihomo().get_proxies())
        .await
        .map_err(|_| unavailable())?
        .map_err(|_| unavailable())?;
    if !proxy_route(&proxies, &candidate.probe)
        || candidate.path.iter().any(|selection| {
            proxies
                .proxies
                .get(&selection.group)
                .is_none_or(|group| group.now.as_deref() != Some(selection.node.as_str()))
        })
    {
        return Err(changed());
    }
    check(id)
}

async fn connect_inner(id: u64, mode: XboardGuideMode, mut prepared: Prepared) -> Result<()> {
    let effects = EFFECTS.lock().await;
    let state = STATE.lock().await;
    let profile_write = PROFILE_WRITE_LOCK.lock().await;
    let config_write = Config::lock_config_write().await;
    check(id)?;
    if !identity_matches(&prepared.identity, &state)
        || !configuration_matches(&prepared.configuration).await
        || !interception_disabled().await
    {
        return Err(changed());
    }
    let error = || connection_error(mode);
    if mode == XboardGuideMode::Tun && !crate::core::runstate::RUN_STATE.state().tun_capable() {
        return Err(error());
    }
    let patch = IVerge {
        enable_tun_mode: Some(mode == XboardGuideMode::Tun),
        enable_system_proxy: Some(mode == XboardGuideMode::System),
        ..Default::default()
    };
    let mut result = async {
        let mut rule_mode = serde_yaml_ng::Mapping::new();
        rule_mode.insert("mode".into(), "rule".into());
        crate::feat::apply_clash_patch_locked(&config_write, &rule_mode)
            .await
            .map_err(|_| error())?;
        check(id)?;
        crate::feat::apply_verge_patch_locked(&config_write, &patch, false)
            .await
            .map_err(|_| error())?;
        check(id)?;
        Ok(())
    }
    .await;
    drop(config_write);
    crate::feat::reconcile_tun_availability().await;
    let config_write = Config::lock_config_write().await;
    if result.is_ok() {
        result = verify_connection(id, mode, &prepared.candidate).await;
    }
    prepared.configuration = configuration().await;
    {
        let mut guide = GUIDE.lock();
        if result.is_ok() {
            if guide.pending && guide.snapshot.attempt_id == id {
                guide.snapshot.phase = XboardGuidePhase::Succeeded;
                guide.prepared = Some(prepared.clone());
            } else {
                result = Err(changed());
            }
        }
        drop(guide);
    }
    if result.is_err() {
        // Only this guide owns the write lock; disable a partially applied attempt before allowing retry/manual changes.
        let disabled = IVerge {
            enable_tun_mode: Some(false),
            enable_system_proxy: Some(false),
            ..Default::default()
        };
        let cleanup = crate::feat::apply_verge_patch_locked(&config_write, &disabled, false).await;
        if cleanup.is_err() {
            let _ = Handle::mihomo().close_all_connections().await;
            let _ = CoreManager::global().stop_core().await;
        }
    }
    prepared.configuration = configuration().await;
    drop(config_write);
    drop(profile_write);
    drop(state);
    {
        let mut guide = GUIDE.lock();
        if guide.pending && guide.snapshot.attempt_id == id {
            guide.prepared = Some(prepared);
        }
    }
    drop(effects);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn network() -> anyhow::Result<Proxies> {
        Ok(serde_json::from_value(json!({"proxies": {
            "🚀节点选择":{"name":"🚀节点选择","type":"Selector","all":["自动选择","故障转移","Fast","Slow","Claude分流","DIRECT"]},
            "自动选择":{"name":"自动选择","type":"URLTest","all":["Fast","Slow"],"now":"Slow"},
            "故障转移":{"name":"故障转移","type":"Fallback","all":["Slow","Fast"],"now":"Slow"},
            "Claude分流":{"name":"Claude分流","type":"Selector","all":["OnlyClaude"],"now":"OnlyClaude"},
            "Fast":{"name":"Fast","type":"Shadowsocks"},
            "Slow":{"name":"Slow","type":"Vmess"},
            "OnlyClaude":{"name":"OnlyClaude","type":"Shadowsocks"},
            "DIRECT":{"name":"DIRECT","type":"Direct"}
        }}))?)
    }

    #[test]
    fn an_existing_or_interrupted_install_never_reopens_the_first_connection_guide() {
        assert!(eligible_install(None, false));
        assert!(!eligible_install(None, true));
        for marker in ["pending", "complete", "skipped"] {
            assert!(!eligible_install(Some(marker), false));
        }
    }

    #[test]
    fn cancellation_retires_the_attempt_without_consuming_an_unauthenticated_install() {
        let mut guide = Guide {
            eligible: true,
            ..Default::default()
        };
        assert!(!guide.invalidate());
        assert!(guide.eligible);
        guide.pending = true;
        guide.snapshot.attempt_id = 7;
        assert!(guide.is_current(7));
        assert!(!guide.is_current(6));
        assert!(guide.invalidate());
        assert!(!guide.is_current(7));
        guide.pending = true;
        assert!(!guide.is_current(7));
    }

    #[test]
    fn first_login_candidates_only_change_the_main_selector() -> anyhow::Result<()> {
        let proxies = network()?;
        let choices = candidates(&proxies);
        let probes = choices
            .iter()
            .map(|choice| (choice.probe.as_str(), choice.automatic))
            .collect::<Vec<_>>();
        assert_eq!(
            probes,
            [("自动选择", true), ("故障转移", true), ("Fast", false), ("Slow", false)]
        );
        for choice in choices {
            assert_eq!(
                choice.path,
                [Selection {
                    group: "🚀节点选择".into(),
                    node: choice.probe,
                }]
            );
        }
        Ok(())
    }

    #[test]
    fn missing_or_invalid_main_selector_does_not_fall_back_to_a_service_group() -> anyhow::Result<()> {
        let mut proxies = network()?;
        let main = proxies
            .proxies
            .get_mut("🚀节点选择")
            .ok_or_else(|| anyhow::anyhow!("missing main selector"))?;
        main.proxy_type = ProxyType::URLTest;
        assert!(candidates(&proxies).is_empty());
        proxies.proxies.remove("🚀节点选择");
        assert!(candidates(&proxies).is_empty());
        Ok(())
    }

    #[test]
    fn automatic_selection_and_failover_each_have_priority_over_individual_nodes() -> anyhow::Result<()> {
        let proxies = network()?;
        let mut choices = candidates(&proxies);
        choices.reverse();
        let probes = candidate_batches(choices)
            .into_iter()
            .map(|batch| batch.into_iter().map(|choice| choice.probe).collect::<Vec<_>>())
            .collect::<Vec<_>>();
        assert_eq!(probes, [vec!["自动选择"], vec!["故障转移"], vec!["Slow", "Fast"]]);
        Ok(())
    }

    #[test]
    fn failed_or_zero_latency_checks_cannot_replace_a_success_before_the_deadline() {
        let node = |name: &str| Candidate {
            probe: name.into(),
            path: Vec::new(),
            automatic: false,
        };
        let mut best = None;
        keep_fastest(&mut best, node("timeout"), None);
        keep_fastest(&mut best, node("zero"), Some(0));
        assert!(best.is_none());
        keep_fastest(&mut best, node("working"), Some(120));
        keep_fastest(&mut best, node("timeout"), None);
        keep_fastest(&mut best, node("slower"), Some(200));
        assert_eq!(best, Some((node("working"), 120)));
    }

    #[test]
    fn activation_requires_the_same_prepared_attempt_and_an_available_route() {
        let mut guide = Guide {
            pending: true,
            ..Default::default()
        };
        guide.snapshot.attempt_id = 3;
        guide.snapshot.phase = XboardGuidePhase::Failed;
        assert!(!guide.can_connect(3));
        guide.prepared = Some(Prepared {
            identity: Identity {
                email: "test@example.com".into(),
                bearer: "test".into(),
            },
            configuration: Configuration {
                runtime: Arc::new(Box::default()),
                generation: Some(1),
                profile: Some(MANAGED_UID.into()),
                file: Some("profile.yaml".into()),
            },
            candidate: Candidate {
                probe: "working".into(),
                path: Vec::new(),
                automatic: false,
            },
        });
        for phase in [
            XboardGuidePhase::Idle,
            XboardGuidePhase::Syncing,
            XboardGuidePhase::Testing,
            XboardGuidePhase::Connecting,
            XboardGuidePhase::Cancelled,
        ] {
            guide.snapshot.phase = phase;
            assert!(!guide.can_connect(3));
        }
        guide.snapshot.phase = XboardGuidePhase::Ready;
        assert!(guide.can_connect(3));
        assert!(!guide.can_connect(2));
        guide.invalidate();
        assert!(!guide.can_connect(3));
    }

    #[test]
    fn automatic_current_outbounds_must_resolve_to_a_real_proxy() -> anyhow::Result<()> {
        let mut proxies = network()?;
        assert!(proxy_route(&proxies, "自动选择"));
        for selected in ["DIRECT", "missing", "自动选择"] {
            proxies
                .proxies
                .get_mut("自动选择")
                .ok_or_else(|| anyhow::anyhow!("missing group"))?
                .now = Some(selected.into());
            assert!(!proxy_route(&proxies, "自动选择"));
        }
        proxies
            .proxies
            .get_mut("自动选择")
            .ok_or_else(|| anyhow::anyhow!("missing group"))?
            .now = Some("Claude分流".into());
        assert!(proxy_route(&proxies, "自动选择"));
        proxies
            .proxies
            .get_mut("Claude分流")
            .ok_or_else(|| anyhow::anyhow!("missing group"))?
            .now = Some("DIRECT".into());
        assert!(!proxy_route(&proxies, "自动选择"));
        Ok(())
    }

    #[test]
    fn load_balance_with_a_direct_branch_cannot_pass_from_one_lucky_probe() -> anyhow::Result<()> {
        let mut proxies = network()?;
        let group = proxies
            .proxies
            .get_mut("自动选择")
            .ok_or_else(|| anyhow::anyhow!("missing group"))?;
        group.proxy_type = ProxyType::LoadBalance;
        group.all = Some(vec!["Fast".into(), "DIRECT".into()]);
        group.now = Some("Fast".into());
        assert!(!proxy_route(&proxies, "自动选择"));
        proxies
            .proxies
            .get_mut("自动选择")
            .ok_or_else(|| anyhow::anyhow!("missing group"))?
            .all = Some(vec!["Fast".into(), "Slow".into()]);
        assert!(proxy_route(&proxies, "自动选择"));
        Ok(())
    }

    #[tokio::test]
    async fn the_shared_deadline_covers_waiting_and_releases_the_effect_guard() {
        let effects = Mutex::new(());
        let deadline = tokio::time::Instant::now() + Duration::from_millis(5);
        let result = within(deadline, Duration::from_secs(60), async {
            let guard = effects.lock().await;
            std::future::pending::<()>().await;
            drop(guard);
        })
        .await;
        assert!(result.is_err());
        assert!(effects.try_lock().is_ok());
    }
}
