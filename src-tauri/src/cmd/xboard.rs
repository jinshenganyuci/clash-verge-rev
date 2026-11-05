use super::{CmdResult, coded_error};
use crate::xboard::guide::{XboardGuideMode, XboardGuideSnapshot};
use crate::xboard::{
    self, XboardBusinessResponse, XboardOperation, XboardRegisterInput, XboardRegistrationPolicy, XboardRequestParams,
    XboardSnapshot,
};

fn failure(error: xboard::Error) -> super::CommandFailure {
    coded_error(error.code, error)
}

#[tauri::command]
#[specta::specta]
pub async fn xboard_snapshot() -> CmdResult<XboardSnapshot> {
    xboard::snapshot().await.map_err(failure)
}

#[tauri::command]
#[specta::specta]
pub async fn xboard_login(email: String, password: String) -> CmdResult<XboardSnapshot> {
    xboard::login(email, password).await.map_err(failure)
}

#[tauri::command]
#[specta::specta]
pub async fn xboard_register(input: XboardRegisterInput) -> CmdResult<XboardSnapshot> {
    xboard::register(input).await.map_err(failure)
}

#[tauri::command]
#[specta::specta]
pub async fn xboard_logout() -> CmdResult<XboardSnapshot> {
    xboard::logout().await.map_err(failure)
}

#[tauri::command]
#[specta::specta]
pub async fn xboard_refresh(force: bool) -> CmdResult<XboardSnapshot> {
    xboard::refresh(force).await.map_err(failure)
}

#[tauri::command]
#[specta::specta]
pub async fn xboard_request(
    operation: XboardOperation,
    params: XboardRequestParams,
) -> CmdResult<XboardBusinessResponse> {
    xboard::request(operation, params.0).await.map_err(failure)
}

#[tauri::command]
#[specta::specta]
pub async fn xboard_registration_policy() -> CmdResult<XboardRegistrationPolicy> {
    xboard::registration_policy().await.map_err(failure)
}

#[tauri::command]
#[specta::specta]
pub async fn xboard_complete_onboarding() -> CmdResult<XboardSnapshot> {
    xboard::complete_onboarding().await.map_err(failure)
}

#[tauri::command]
#[specta::specta]
pub async fn xboard_copy_subscription() -> CmdResult {
    xboard::copy_subscription(false).await.map_err(failure)
}

#[tauri::command]
#[specta::specta]
pub async fn xboard_copy_telegram_binding() -> CmdResult {
    xboard::copy_subscription(true).await.map_err(failure)
}

#[tauri::command]
#[specta::specta]
pub fn xboard_guide_snapshot() -> CmdResult<XboardGuideSnapshot> {
    Ok(xboard::guide::snapshot())
}

#[tauri::command]
#[specta::specta]
pub fn xboard_guide_prepare() -> CmdResult<XboardGuideSnapshot> {
    xboard::guide::prepare().map_err(failure)
}

#[tauri::command]
#[specta::specta]
pub async fn xboard_guide_cancel() -> CmdResult<XboardGuideSnapshot> {
    xboard::guide::cancel().await.map_err(failure)
}

#[tauri::command]
#[specta::specta]
pub fn xboard_guide_connect(attempt_id: u64, mode: XboardGuideMode) -> CmdResult<XboardGuideSnapshot> {
    xboard::guide::connect(attempt_id, mode).map_err(failure)
}

#[tauri::command]
#[specta::specta]
pub async fn xboard_guide_complete(attempt_id: u64) -> CmdResult<XboardGuideSnapshot> {
    xboard::guide::complete(attempt_id).await.map_err(failure)
}
