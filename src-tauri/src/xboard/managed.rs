use super::{Error, MANAGED_UID, Result, XboardSubscription};
use crate::{
    config::{Config, PrfOption, profiles::{PROFILE_WRITE_LOCK, activate_selected_nodes}},
    core::{CoreManager, handle::Handle, validate::CoreConfigValidator},
    utils::{dirs, retry::{RetryError, RetryPolicy, retry}},
};
use serde_yaml_ng::{Mapping, Value};
use std::{num::NonZeroUsize, time::{Duration, SystemTime, UNIX_EPOCH}};
use tokio::fs;

pub const FILE_PREFIX: &str = "xboard-account-";
static PENDING_STOP: parking_lot::Mutex<Option<StopTarget>> = parking_lot::Mutex::new(None);

#[derive(Clone, Copy)]
struct StopTarget {
    generation: Option<u64>,
    managed_current: bool,
}

impl StopTarget {
    fn still_owned(self, generation: Option<u64>, current: Option<&str>) -> bool {
        if self.managed_current {
            current == Some(MANAGED_UID)
        } else {
            current.is_none() && self.generation == generation
        }
    }
}

pub fn revoked_configuration(text: &str) -> Result<bool> {
    let mapping: Mapping = serde_yaml_ng::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|_| Error::new("XBOARD_INVALID_PROFILE", "The subscription is not a valid configuration."))?;
    let empty = |key: &str| match mapping.get(key) {
        None | Some(Value::Null) => true,
        Some(Value::Sequence(sequence)) => sequence.is_empty(),
        Some(Value::Mapping(mapping)) => mapping.is_empty(),
        _ => false,
    };
    let reject = mapping.get("rules").and_then(Value::as_sequence)
        .is_some_and(|rules| rules.len() == 1 && rules[0].as_str() == Some("MATCH,REJECT"));
    if empty("proxies") && empty("proxy-providers") && empty("proxy-groups") && reject {
        return Ok(true);
    }
    if empty("proxies") && empty("proxy-providers") {
        return Err(Error::new("XBOARD_INVALID_PROFILE", "The subscription contains no usable nodes."));
    }
    Ok(false)
}

pub async fn exists() -> bool {
    Config::profiles().await.latest_arc().get_item(MANAGED_UID).is_ok()
}

async fn cleanup_files(keep: Option<&std::path::Path>) -> Result<()> {
    let directory = dirs::app_profiles_dir().map_err(|_| Error::storage())?;
    let mut entries = fs::read_dir(directory).await.map_err(|_| Error::storage())?;
    while let Some(entry) = entries.next_entry().await.map_err(|_| Error::storage())? {
        let path = entry.path();
        if keep == Some(path.as_path()) || !entry.file_name().to_string_lossy().starts_with(FILE_PREFIX) {
            continue;
        }
        if !entry.file_type().await.map_err(|_| Error::storage())?.is_file() { continue; }
        match fs::remove_file(path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(Error::storage()),
        }
    }
    Ok(())
}

pub async fn install(text: &str, subscription: &XboardSubscription, activate: bool) -> Result<()> {
    retry_pending_stop().await?;
    if revoked_configuration(text)? { return Err(Error::unavailable()); }
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| Error::storage())?.as_nanos();
    let filename = format!("{FILE_PREFIX}{stamp}.yaml");
    let directory = dirs::app_profiles_dir().map_err(|_| Error::storage())?;
    let path = directory.join(&filename);
    fs::write(&path, text).await.map_err(|_| Error::storage())?;
    let validation = CoreConfigValidator::validate_config_file_outcome(&path.to_string_lossy(), Some(false)).await;
    if !validation.is_ok_and(|outcome| outcome.is_valid()) {
        let _ = fs::remove_file(&path).await;
        return Err(Error::new("XBOARD_INVALID_PROFILE", "The new subscription failed core validation. The previous configuration was kept."));
    }
    let _write = PROFILE_WRITE_LOCK.lock().await;
    let profiles = Config::profiles().await;
    let result = profiles.with_data_modify(|mut candidate| async move {
        let original = candidate.clone();
        let previous = candidate.get_item(MANAGED_UID).ok().cloned();
        let mut item = previous.unwrap_or_default();
        item.uid = Some(MANAGED_UID.into());
        item.itype = Some("local".into());
        item.name = Some("IKUN subscription".into());
        item.desc = Some("Managed by your IKUN account".into());
        item.file = Some(filename);
        item.url = None;
        item.option = Some(PrfOption { allow_auto_update: Some(false), ..Default::default() });
        item.updated = Some(super::now() as usize);
        item.extra = Some(crate::config::PrfExtra {
            upload: subscription.upload,
            download: subscription.download,
            total: subscription.total,
            expire: subscription.expired_at.unwrap_or(0),
        });
        let items = candidate.items.get_or_insert_with(Vec::new);
        if let Some(existing) = items.iter_mut().find(|item| item.uid.as_deref() == Some(MANAGED_UID)) {
            *existing = item;
        } else {
            items.push(item);
        }
        if activate || candidate.current.is_none() { candidate.current = Some(MANAGED_UID.into()); }
        let guard = if candidate.current.as_deref() == Some(MANAGED_UID) {
            match CoreManager::global().update_config_forced_with_profiles(&candidate, &original).await? {
                Ok(guard) => Some(guard),
                Err(_) => anyhow::bail!("Managed subscription runtime validation failed"),
            }
        } else {
            candidate.save_file().await?;
            None
        };
        Ok((candidate, guard))
    }).await;
    match result {
        Ok(guard) => {
            if guard.is_some() { activate_selected_nodes(); }
            drop(guard);
            Handle::notify_profile_changed(&MANAGED_UID.into());
            Handle::refresh_clash();
            cleanup_files(Some(&path)).await?;
            Ok(())
        }
        Err(_) => {
            // A failed rollback may still reference this candidate; retain both versions for recovery.
            Err(Error::new("XBOARD_PROFILE_APPLY_FAILED", "The subscription could not be confirmed. The previous configuration files were retained."))
        }
    }
}

pub async fn remove() -> Result<()> {
    retry_pending_stop().await?;
    let _write = PROFILE_WRITE_LOCK.lock().await;
    let profiles = Config::profiles().await;
    let result = profiles.with_data_modify(|mut candidate| async move {
        let original = candidate.clone();
        let active = candidate.current.as_deref() == Some(MANAGED_UID);
        if let Some(items) = candidate.items.as_mut() { items.retain(|item| item.uid.as_deref() != Some(MANAGED_UID)); }
        if active { candidate.current = None; }
        let guard = if active {
            match CoreManager::global().update_config_forced_with_profiles(&candidate, &original).await? {
                Ok(guard) => Some(guard),
                Err(_) => anyhow::bail!("Managed subscription removal was not applied"),
            }
        } else {
            candidate.save_file().await?;
            None
        };
        // Configuration is committed even if stopping the OS proxy subsequently fails.
        let stopped = if active { stop_owned(false).await } else { true };
        Ok((candidate, (guard, stopped)))
    }).await;
    let result = match result {
        Ok(result) => result,
        Err(_) => {
            drop(_write);
            stop_failed_removal().await?;
            return Err(Error::new("XBOARD_PROFILE_REMOVE_FAILED", "The account proxy was stopped, but its configuration could not be removed. Please retry."));
        }
    };
    let (guard, stopped) = result;
    drop(guard);
    Handle::notify_profile_changed(&MANAGED_UID.into());
    Handle::refresh_clash();
    cleanup_files(None).await?;
    if !stopped {
        return Err(Error::new("XBOARD_PROXY_STOP_FAILED", "The account configuration was removed, but the proxy could not be stopped. Please disable the system proxy."));
    }
    Ok(())
}

async fn stop_failed_removal() -> Result<()> {
    *PENDING_STOP.lock() = Some(StopTarget {
        generation: CoreManager::global().current_core_readiness_generation(),
        managed_current: true,
    });
    retry_pending_stop().await
}

async fn stop_owned(managed_current: bool) -> bool {
    let manager = CoreManager::global();
    let target = StopTarget { generation: manager.current_core_readiness_generation(), managed_current };
    let _ = Handle::mihomo().close_all_connections().await;
    let stopped = retry(
        RetryPolicy::fixed(NonZeroUsize::MIN.saturating_add(2), Duration::from_millis(250)),
        |_| async { manager.stop_core().await.map_err(RetryError::Retry) },
    ).await.is_ok();
    *PENDING_STOP.lock() = if stopped { None } else { Some(target) };
    stopped
}

pub async fn retry_pending_stop() -> Result<()> {
    let target = *PENDING_STOP.lock();
    let Some(target) = target else { return Ok(()); };
    let manager = CoreManager::global();
    let result = retry(
        RetryPolicy::fixed(NonZeroUsize::MIN.saturating_add(19), Duration::from_millis(250)),
        |_| async {
            let config_write = tokio::time::timeout(Duration::from_millis(500), Config::lock_config_write())
                .await.map_err(|_| RetryError::Retry(anyhow::anyhow!("Configuration ownership is busy")))?;
            let update = manager.claim_config_update(&config_write).map_err(RetryError::Retry)?;
            let profiles = Config::profiles().await.latest_arc();
            let owned = target.still_owned(manager.current_core_readiness_generation(), profiles.current.as_deref());
            drop(profiles);
            if !owned {
                *PENDING_STOP.lock() = None;
            } else if !stop_owned(target.managed_current).await {
                return Err(RetryError::Stop(anyhow::anyhow!("Account proxy stop failed")));
            }
            drop(update);
            Ok(())
        },
    ).await;
    if result.is_err() {
        return Err(Error::new("XBOARD_PROXY_STOP_FAILED", "The account proxy could not be confirmed stopped. Please disable the system proxy and retry sign-out."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_reject_snapshot_revokes_old_nodes_but_bad_yaml_does_not() -> anyhow::Result<()> {
        assert!(revoked_configuration("proxies: []\nproxy-groups: []\nrules: [MATCH,REJECT]").is_err());
        assert!(revoked_configuration("proxies: []\nproxy-groups: []\nrules: ['MATCH,REJECT']")?);
        assert!(!revoked_configuration("proxies: [{name: test}]\nrules: ['MATCH,REJECT']")?);
        assert!(revoked_configuration("proxies: [").is_err());
        assert!(revoked_configuration("proxies: []\nrules: ['MATCH,DIRECT']").is_err());
        Ok(())
    }

    #[test]
    fn pending_stop_does_not_target_a_new_manual_runtime() {
        let removed = StopTarget { generation: Some(7), managed_current: false };
        assert!(removed.still_owned(Some(7), None));
        assert!(!removed.still_owned(Some(8), None));
        assert!(!removed.still_owned(Some(7), Some("manual")));
        let blocked_removal = StopTarget { generation: Some(7), managed_current: true };
        assert!(blocked_removal.still_owned(Some(8), Some(MANAGED_UID)));
        assert!(!blocked_removal.still_owned(Some(7), Some("manual")));
        assert!(!blocked_removal.still_owned(Some(7), None));
    }
}
