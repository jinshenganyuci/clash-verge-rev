use super::{Error, MANAGED_UID, Result, XboardSubscription};
use crate::{
    config::{Config, PrfItem, PrfOption, profiles::PROFILE_WRITE_LOCK},
    core::{CoreManager, handle::Handle, validate::CoreConfigValidator},
    utils::dirs,
};
use serde_yaml_ng::{Mapping, Value};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs;

pub const FILE_PREFIX: &str = "xboard-account-";

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

pub async fn install(text: &str, subscription: &XboardSubscription, activate: bool) -> Result<()> {
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
        let old_file = previous.as_ref().and_then(|item| item.file.clone());
        let mut item = previous.unwrap_or_default();
        item.uid = Some(MANAGED_UID.into());
        item.itype = Some("local".into());
        item.name = Some("IKUN subscription".into());
        item.desc = Some("Managed by your IKUN account".into());
        item.file = Some(filename.into());
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
        Ok((candidate, (old_file, guard)))
    }).await;
    match result {
        Ok((old_file, guard)) => {
            drop(guard);
            if let Some(file) = old_file { let _ = fs::remove_file(directory.join(file.as_str())).await; }
            Handle::notify_profile_changed(&MANAGED_UID.into());
            Handle::refresh_clash();
            Ok(())
        }
        Err(_) => {
            let _ = fs::remove_file(path).await;
            Err(Error::new("XBOARD_PROFILE_APPLY_FAILED", "The subscription could not be applied. The previous configuration was kept."))
        }
    }
}

pub async fn remove() -> Result<()> {
    let _write = PROFILE_WRITE_LOCK.lock().await;
    let profiles = Config::profiles().await;
    let result = profiles.with_data_modify(|mut candidate| async move {
        let original = candidate.clone();
        let old_file = candidate.get_item(MANAGED_UID).ok().and_then(|item| item.file.clone());
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
        let stopped = if active { CoreManager::global().stop_core().await.is_ok() } else { true };
        Ok((candidate, (old_file, guard, stopped)))
    }).await.map_err(|_| Error::new("XBOARD_PROFILE_REMOVE_FAILED", "The account configuration could not be removed. Please retry."))?;
    let (old_file, guard, stopped) = result;
    drop(guard);
    if let Some(file) = old_file {
        let directory = dirs::app_profiles_dir().map_err(|_| Error::storage())?;
        fs::remove_file(directory.join(file.as_str())).await.map_err(|_| Error::storage())?;
    }
    Handle::notify_profile_changed(&MANAGED_UID.into());
    Handle::refresh_clash();
    if !stopped {
        return Err(Error::new("XBOARD_PROXY_STOP_FAILED", "The account configuration was removed, but the proxy could not be stopped. Please disable the system proxy."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_reject_snapshot_revokes_old_nodes_but_bad_yaml_does_not() {
        assert!(revoked_configuration("proxies: []\nproxy-groups: []\nrules: [MATCH,REJECT]").is_err());
        assert!(revoked_configuration("proxies: []\nproxy-groups: []\nrules: ['MATCH,REJECT']").unwrap());
        assert!(!revoked_configuration("proxies: [{name: test}]\nrules: ['MATCH,REJECT']").unwrap());
        assert!(revoked_configuration("proxies: [").is_err());
        assert!(revoked_configuration("proxies: []\nrules: ['MATCH,DIRECT']").is_err());
    }
}
