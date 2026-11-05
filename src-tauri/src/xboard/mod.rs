mod api;
mod managed;
mod store;

pub use api::XboardOperation;
pub use managed::FILE_PREFIX as MANAGED_FILE_PREFIX;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fmt,
    sync::{
        LazyLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri_plugin_clipboard_manager::ClipboardExt as _;
use tokio::sync::Mutex;

pub const MANAGED_UID: &str = "xboard-account";
static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| Mutex::new(State::default()));
static STARTED: AtomicBool = AtomicBool::new(false);
type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub struct Error {
    pub code: &'static str,
    message: &'static str,
}

impl Error {
    const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
    const fn network() -> Self {
        Self::new(
            "XBOARD_NETWORK_FAILED",
            "The account service could not be reached. Please try again.",
        )
    }
    const fn storage() -> Self {
        Self::new(
            "XBOARD_STORAGE_FAILED",
            "The encrypted account data could not be read or saved on this Windows account.",
        )
    }
    const fn invalid_response() -> Self {
        Self::new(
            "XBOARD_INVALID_RESPONSE",
            "The account service returned an invalid response.",
        )
    }
    const fn session_expired() -> Self {
        Self::new("XBOARD_SESSION_EXPIRED", "Your session expired. Please sign in again.")
    }
    const fn unavailable() -> Self {
        Self::new(
            "XBOARD_SUBSCRIPTION_UNAVAILABLE",
            "No subscription nodes are currently available.",
        )
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}
impl std::error::Error for Error {}

#[derive(Clone, Deserialize, Serialize, specta::Type)]
pub struct XboardSubscription {
    pub plan_id: Option<u64>,
    pub plan_name: Option<String>,
    pub expired_at: Option<u64>,
    pub upload: u64,
    pub download: u64,
    pub total: u64,
}

#[derive(Clone, Deserialize, Serialize)]
struct SubscriptionRecord {
    summary: XboardSubscription,
    url: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct Binding {
    email: String,
    bearer: String,
    subscription: Option<SubscriptionRecord>,
    profile_uid: Option<String>,
    last_sync: Option<u64>,
}

#[derive(Serialize, specta::Type)]
pub struct XboardSnapshot {
    pub onboarding_complete: bool,
    pub signed_in: bool,
    pub email: Option<String>,
    pub profile_uid: Option<String>,
    pub last_sync: Option<u64>,
    pub subscription: Option<XboardSubscription>,
    pub error: Option<String>,
}

#[derive(Deserialize, specta::Type)]
pub struct XboardRegisterInput {
    pub email: String,
    pub password: String,
    pub email_code: Option<String>,
    pub invite_code: Option<String>,
}

#[derive(Serialize, specta::Type)]
pub struct XboardRegistrationPolicy {
    pub email_verification_required: bool,
    pub invite_required: bool,
    pub captcha_required: bool,
    pub email_domains: Vec<String>,
    pub terms_url: Option<String>,
}

// Follow the shared IPC JSON representation rather than exporting serde_json's internal type graph.
#[derive(Deserialize, specta::Type)]
#[serde(transparent)]
pub struct XboardRequestParams(
    #[specta(type = std::collections::HashMap<String, crate::ipc::JsonValue>)] pub Value,
);

#[derive(Serialize, specta::Type)]
pub struct XboardBusinessResponse {
    #[specta(type = crate::ipc::JsonValue)]
    pub data: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_page: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_page: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per_page: Option<u64>,
}

impl XboardBusinessResponse {
    fn from_value(value: Value) -> Self {
        Self {
            data: value["data"].clone(),
            total: number(&value["total"]),
            current_page: number(&value["current_page"]),
            last_page: number(&value["last_page"]),
            per_page: number(&value["per_page"]),
        }
    }
}

#[derive(Default)]
struct State {
    loaded: bool,
    onboarding_complete: bool,
    binding: Option<Binding>,
    last_checked: Option<std::time::Instant>,
    error: Option<String>,
    pending_secret_clear: bool,
}

fn now() -> u64 {
    chrono::Utc::now().timestamp().max(0) as u64
}

impl State {
    async fn load(&mut self) -> Result<()> {
        if !self.loaded {
            self.onboarding_complete = store::onboarding_complete().await?;
            match store::read().await {
                Ok(binding) => self.binding = binding,
                Err(error) => {
                    self.error = Some(error.to_string());
                }
            }
            self.loaded = true;
            if self.binding.is_none()
                && managed::exists().await
                && let Err(error) = managed::remove().await
            {
                self.error = Some(error.to_string());
            }
        }
        Ok(())
    }

    fn snapshot(&self) -> XboardSnapshot {
        XboardSnapshot {
            onboarding_complete: self.onboarding_complete,
            signed_in: self.binding.is_some(),
            email: self.binding.as_ref().map(|binding| binding.email.clone()),
            profile_uid: self.binding.as_ref().and_then(|binding| binding.profile_uid.clone()),
            last_sync: self.binding.as_ref().and_then(|binding| binding.last_sync),
            subscription: self
                .binding
                .as_ref()
                .and_then(|binding| binding.subscription.as_ref().map(|record| record.summary.clone())),
            error: self.error.clone(),
        }
    }

    async fn clear(&mut self) -> Result<()> {
        self.binding = None;
        self.last_checked = None;
        let persisted = store::clear().await;
        self.pending_secret_clear = persisted.is_err();
        let removal = managed::remove().await;
        let result = removal.and(persisted);
        self.error = result.as_ref().err().map(ToString::to_string);
        result
    }

    async fn fetch_subscription(&mut self) -> Result<SubscriptionRecord> {
        let bearer = self.binding.as_ref().ok_or_else(Error::session_expired)?.bearer.clone();
        match api::subscription(&bearer).await {
            Ok(value) => parse_subscription(&value),
            Err(error) if error.code == "XBOARD_SESSION_EXPIRED" => {
                self.clear().await?;
                Err(error)
            }
            Err(error) => Err(error),
        }
    }

    async fn sync(&mut self, force: bool, activate: bool) -> Result<()> {
        let result = self.sync_inner(force, activate).await;
        if result.is_err() && self.binding.is_some() {
            let exists = managed::exists().await;
            if let Some(binding) = self.binding.as_mut() {
                binding.profile_uid = exists.then(|| MANAGED_UID.into());
                if !exists {
                    binding.last_sync = None;
                }
            }
        }
        result
    }

    async fn sync_inner(&mut self, force: bool, activate: bool) -> Result<()> {
        managed::retry_pending_stop().await?;
        if self.binding.is_none() {
            let persisted = if self.pending_secret_clear {
                store::clear().await
            } else {
                Ok(())
            };
            self.pending_secret_clear = persisted.is_err();
            let removal = if managed::exists().await {
                managed::remove().await
            } else {
                Ok(())
            };
            removal.and(persisted)?;
            self.error = None;
            return Ok(());
        }
        if !force
            && self
                .last_checked
                .is_some_and(|last| last.elapsed() < Duration::from_secs(300))
        {
            return Ok(());
        }
        self.last_checked = Some(std::time::Instant::now());
        let subscription = self.fetch_subscription().await?;
        let mut binding = self.binding.clone().ok_or_else(Error::session_expired)?;
        let previous = binding.subscription.as_ref();
        let changed = previous.is_none_or(|previous| {
            previous.url != subscription.url
                || previous.summary.plan_id != subscription.summary.plan_id
                || previous.summary.expired_at != subscription.summary.expired_at
        });
        binding.subscription = Some(subscription.clone());
        self.binding = Some(binding.clone());
        store::save(&binding).await?;
        let mut subscription_error = None;
        let available = subscription.summary.plan_id.is_some()
            && subscription.summary.expired_at.is_none_or(|expiry| expiry > now());
        if !available {
            managed::remove().await?;
            binding.profile_uid = None;
            binding.last_sync = None;
        } else if force
            || changed
            || !managed::exists().await
            || binding.last_sync.is_none_or(|last| now().saturating_sub(last) >= 3600)
        {
            let result = match api::download(&subscription.url).await {
                Ok(text) => managed::install(&text, &subscription.summary, activate).await,
                Err(error) => Err(error),
            };
            match result {
                Ok(()) => {
                    binding.profile_uid = Some(MANAGED_UID.into());
                    binding.last_sync = Some(now());
                }
                Err(error) if error.code == "XBOARD_SUBSCRIPTION_UNAVAILABLE" => {
                    managed::remove().await?;
                    binding.profile_uid = None;
                    binding.last_sync = None;
                    subscription_error = Some(error.to_string());
                }
                Err(error) => return Err(error),
            }
        }
        // The profile transaction has committed independently of the encrypted account cache.
        self.binding = Some(binding.clone());
        store::save(&binding).await?;
        self.error = subscription_error;
        Ok(())
    }
}

fn number(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
}

fn parse_subscription(value: &Value) -> Result<SubscriptionRecord> {
    if value.get("plan_id").is_none() || value.get("expired_at").is_none() {
        return Err(Error::invalid_response());
    }
    let raw_url = value["subscribe_url"].as_str().ok_or_else(Error::invalid_response)?;
    api::subscription_url(raw_url)?;
    Ok(SubscriptionRecord {
        summary: XboardSubscription {
            plan_id: if value["plan_id"].is_null() {
                None
            } else {
                Some(number(&value["plan_id"]).ok_or_else(Error::invalid_response)?)
            },
            plan_name: value["plan"]["name"].as_str().map(str::to_owned),
            expired_at: if value["expired_at"].is_null() {
                None
            } else {
                Some(number(&value["expired_at"]).ok_or_else(Error::invalid_response)?)
            },
            upload: number(&value["u"]).ok_or_else(Error::invalid_response)?,
            download: number(&value["d"]).ok_or_else(Error::invalid_response)?,
            total: number(&value["transfer_enable"]).ok_or_else(Error::invalid_response)?,
        },
        url: raw_url.into(),
    })
}

pub async fn snapshot() -> Result<XboardSnapshot> {
    let mut state = STATE.lock().await;
    state.load().await?;
    Ok(state.snapshot())
}

async fn sign_in(email: String, password: String, registration: Option<(String, String)>) -> Result<XboardSnapshot> {
    // One owner spans authentication, persistence and profile effects; logout cannot be undone by an older response.
    let mut state = STATE.lock().await;
    state.load().await?;
    let email = email.trim().to_lowercase();
    let bearer = api::authenticate(
        &email,
        &password,
        registration
            .as_ref()
            .map(|(code, invite)| (code.as_str(), invite.as_str())),
    )
    .await?;
    let binding = match state.binding.as_ref() {
        Some(old) if old.email.eq_ignore_ascii_case(&email) => Binding { bearer, ..old.clone() },
        _ => {
            managed::remove().await?;
            Binding {
                email,
                bearer,
                subscription: None,
                profile_uid: None,
                last_sync: None,
            }
        }
    };
    store::save(&binding).await.map_err(|error| {
        if registration.is_some() {
            Error::new("XBOARD_REGISTRATION_SESSION_FAILED", "Your account was created, but the session could not be saved. Please sign in instead of registering again.")
        } else { error }
    })?;
    state.binding = Some(binding);
    state.pending_secret_clear = false;
    store::complete_onboarding().await?;
    state.onboarding_complete = true;
    if let Err(error) = state.sync(true, true).await {
        state.error = Some(error.to_string());
    }
    Ok(state.snapshot())
}

pub async fn login(email: String, password: String) -> Result<XboardSnapshot> {
    sign_in(email, password, None).await
}

pub async fn register(input: XboardRegisterInput) -> Result<XboardSnapshot> {
    sign_in(
        input.email,
        input.password,
        Some((
            input.email_code.unwrap_or_default(),
            input.invite_code.unwrap_or_default(),
        )),
    )
    .await
}

pub async fn refresh(force: bool) -> Result<XboardSnapshot> {
    let mut state = STATE.lock().await;
    state.load().await?;
    if let Err(error) = state.sync(force, false).await {
        state.error = Some(error.to_string());
        return Err(error);
    }
    Ok(state.snapshot())
}

pub async fn logout() -> Result<XboardSnapshot> {
    let mut state = STATE.lock().await;
    state.load().await?;
    state.clear().await?;
    Ok(state.snapshot())
}

pub async fn complete_onboarding() -> Result<XboardSnapshot> {
    let mut state = STATE.lock().await;
    state.load().await?;
    store::complete_onboarding().await?;
    state.onboarding_complete = true;
    Ok(state.snapshot())
}

pub async fn request(operation: XboardOperation, params: Value) -> Result<XboardBusinessResponse> {
    let mut state = STATE.lock().await;
    state.load().await?;
    let bearer = if operation.authenticated() {
        Some(
            state
                .binding
                .as_ref()
                .ok_or_else(Error::session_expired)?
                .bearer
                .clone(),
        )
    } else {
        None
    };
    let response = api::operation(operation, bearer.as_deref(), params).await;
    let mut response = match response {
        Ok(value) => value,
        Err(error) if error.code == "XBOARD_SESSION_EXPIRED" => {
            state.clear().await?;
            return Err(error);
        }
        Err(error) => return Err(error),
    };
    if matches!(operation, XboardOperation::ResetSecurity) {
        // This endpoint returns a signed URL. Publish only success and obtain the new URL privately.
        state.sync(true, false).await?;
        return Ok(XboardBusinessResponse::from_value(json!({"data":true})));
    }
    api::redact(&mut response);
    Ok(XboardBusinessResponse::from_value(response))
}

fn policy_flag(value: &Value) -> Result<bool> {
    match value {
        Value::Bool(value) => Ok(*value),
        Value::Number(value) if value.as_u64() == Some(1) => Ok(true),
        Value::Number(value) if value.as_u64() == Some(0) => Ok(false),
        Value::String(value) if value == "true" || value == "1" => Ok(true),
        Value::String(value) if value == "false" || value == "0" => Ok(false),
        _ => Err(Error::invalid_response()),
    }
}

fn parse_registration_policy(value: &Value) -> Result<XboardRegistrationPolicy> {
    let terms_url = value["tos_url"]
        .as_str()
        .filter(|url| !url.trim().is_empty())
        .and_then(|raw| {
            let base = tauri::Url::parse("https://ikun.iil.im/").ok()?;
            let url = base.join(raw).ok()?;
            (url.scheme() == "https"
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none())
            .then(|| url.to_string())
        });
    Ok(XboardRegistrationPolicy {
        email_verification_required: policy_flag(&value["is_email_verify"])?,
        invite_required: policy_flag(&value["is_invite_force"])?,
        captcha_required: policy_flag(value.get("is_captcha").unwrap_or(&value["is_recaptcha"]))?,
        email_domains: value["email_whitelist_suffix"]
            .as_array()
            .map(|domains| {
                domains
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|domain| domain.trim().to_lowercase())
                    .filter(|domain| !domain.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
        terms_url,
    })
}

pub async fn registration_policy() -> Result<XboardRegistrationPolicy> {
    let response = api::operation(XboardOperation::RegistrationPolicy, None, json!({})).await?;
    parse_registration_policy(&response["data"])
}

pub async fn copy_subscription(telegram: bool) -> Result<()> {
    let mut state = STATE.lock().await;
    state.load().await?;
    let record = state.fetch_subscription().await?;
    if record.summary.plan_id.is_none() || record.summary.expired_at.is_some_and(|expiry| expiry <= now()) {
        return Err(Error::unavailable());
    }
    let text = if telegram {
        format!("/bind {}", record.url)
    } else {
        record.url
    };
    crate::core::handle::Handle::app_handle()
        .clipboard()
        .write_text(text)
        .map_err(|_| Error::new("XBOARD_CLIPBOARD_FAILED", "The subscription could not be copied."))
}

pub fn start_background() {
    if STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    crate::process::AsyncHandler::spawn(|| async {
        tokio::time::sleep(Duration::from_secs(15)).await;
        loop {
            if crate::core::handle::Handle::global().is_exiting() {
                break;
            }
            let _ = refresh(false).await;
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

pub fn protect_managed(uid: &str) -> crate::cmd::CmdResult {
    if uid == MANAGED_UID {
        return Err(crate::cmd::coded_error(
            "XBOARD_MANAGED_PROFILE",
            "Manage this subscription from the account page.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_does_not_expose_credentials_and_zero_traffic_is_not_expiry() -> anyhow::Result<()> {
        let record = parse_subscription(
            &json!({"plan_id":1,"expired_at":null,"u":0,"d":0,"transfer_enable":0,"subscribe_url":"https://example.com/s/private"}),
        )?;
        assert!(record.summary.plan_id.is_some());
        assert!(record.summary.expired_at.is_none());
        let state = State {
            binding: Some(Binding {
                email: "user@example.com".into(),
                bearer: "Bearer secret".into(),
                subscription: Some(record),
                profile_uid: None,
                last_sync: None,
            }),
            ..Default::default()
        };
        let wire = serde_json::to_string(&state.snapshot())?;
        assert!(!wire.contains("Bearer"));
        assert!(!wire.contains("/s/private"));
        Ok(())
    }

    #[test]
    fn registration_policy_normalizes_flags_and_rejects_unknown_policy() -> anyhow::Result<()> {
        let policy = parse_registration_policy(&json!({
            "is_email_verify":"1", "is_invite_force":0, "is_captcha":true,
            "email_whitelist_suffix":[" EXAMPLE.COM ","mail.test"], "tos_url":"/terms"
        }))?;
        assert!(policy.email_verification_required);
        assert!(!policy.invite_required);
        assert!(policy.captcha_required);
        assert_eq!(policy.email_domains, vec!["example.com", "mail.test"]);
        assert_eq!(policy.terms_url.as_deref(), Some("https://ikun.iil.im/terms"));
        let legacy = parse_registration_policy(&json!({
            "is_email_verify":false, "is_invite_force":"false", "is_recaptcha":"0",
            "email_whitelist_suffix":0, "tos_url":"javascript:alert(1)"
        }))?;
        assert!(!legacy.captcha_required);
        assert!(legacy.email_domains.is_empty());
        assert!(legacy.terms_url.is_none());
        assert!(parse_registration_policy(&json!({"is_email_verify":"unknown"})).is_err());
        Ok(())
    }

    #[test]
    fn business_envelope_preserves_pagination_without_leaking_tokens() -> anyhow::Result<()> {
        let mut response = json!({
            "data":[{"email":"member@example.com","token":"secret","auth_data":"Bearer secret","nested":{"subscribe_url":"https://example.com/s/secret"}}],
            "total":31,"current_page":2,"last_page":4,"per_page":10
        });
        api::redact(&mut response);
        let envelope = XboardBusinessResponse::from_value(response);
        assert_eq!(envelope.total, Some(31));
        assert_eq!(envelope.current_page, Some(2));
        assert_eq!(envelope.last_page, Some(4));
        assert_eq!(envelope.per_page, Some(10));
        let wire = serde_json::to_string(&envelope)?;
        assert!(!wire.contains("secret"));
        assert!(wire.contains("member@example.com"));
        Ok(())
    }

    #[test]
    fn malformed_subscription_metadata_cannot_revoke_a_working_profile() {
        let malformed =
            json!({"expired_at":null,"u":0,"d":0,"transfer_enable":0,"subscribe_url":"https://example.com/s/private"});
        assert!(parse_subscription(&malformed).is_err());
    }
}
