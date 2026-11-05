use crate::config::{Config, IVerge};
use anyhow::Result;
use clash_verge_draft::SharedDraft;
use serde_yaml_ng::Mapping;
use tokio::sync::MutexGuard;

pub async fn patch_clash(patch: &Mapping) -> Result<()> {
    if patch.contains_key("mode")
        && let Err(error) = crate::xboard::guide::manual_override().await
    {
        clash_verge_logging::logging!(
            warn,
            clash_verge_logging::Type::Config,
            "Could not persist the dismissed connection guide: {error}"
        );
    }
    let config_write = Config::try_lock_config_write()?;
    apply_clash_patch_locked(&config_write, patch).await
}

pub(crate) async fn apply_clash_patch_locked(config_write: &MutexGuard<'_, ()>, patch: &Mapping) -> Result<()> {
    super::executor::apply(
        config_write,
        super::executor::Patch::Clash(patch),
        super::effects::clash_effects(patch),
    )
    .await
}

/// Apply a patch, then reconcile TUN when its setting changes.
///
/// TUN patches do not always produce a Run State transition, so reconciliation is explicit.
pub async fn patch_verge(patch: &IVerge, not_save_file: bool) -> Result<()> {
    if (patch.enable_tun_mode.is_some() || patch.enable_system_proxy.is_some())
        && let Err(error) = crate::xboard::guide::manual_override().await
    {
        clash_verge_logging::logging!(
            warn,
            clash_verge_logging::Type::Config,
            "Could not persist the dismissed connection guide: {error}"
        );
    }
    apply_verge_patch(patch, not_save_file).await?;
    if patch.enable_tun_mode.is_some() {
        super::reconcile_tun_availability().await;
    }
    Ok(())
}

/// Apply a patch without post-update reconciliation.
pub(super) async fn apply_verge_patch(patch: &IVerge, not_save_file: bool) -> Result<()> {
    let config_write = Config::lock_config_write().await;
    apply_verge_patch_locked(&config_write, patch, not_save_file).await
}

/// Apply a patch with the shared configuration write lock already held.
/// Callers must pass the guard returned by [`Config::lock_config_write`].
pub(crate) async fn apply_verge_patch_locked(
    _config_write: &MutexGuard<'_, ()>,
    patch: &IVerge,
    not_save_file: bool,
) -> Result<()> {
    super::executor::apply(
        _config_write,
        super::executor::Patch::Verge {
            patch,
            persist: !not_save_file,
        },
        super::effects::verge_effects(patch),
    )
    .await
}

pub async fn fetch_verge_config() -> Result<SharedDraft<IVerge>> {
    let draft = Config::verge().await;
    let data = draft.data_arc();
    Ok(data)
}
