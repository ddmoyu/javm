//! MetaTube sidecar Tauri 命令：状态查询与手动重启。

use tauri::{AppHandle, Manager};

use super::types::MetaTubeStatusSnapshot;
use super::MetaTubeManager;

/// 查询 sidecar 状态（前端展示 + 判断是否就绪）。
#[tauri::command]
pub async fn metatube_status(app: AppHandle) -> Result<MetaTubeStatusSnapshot, String> {
    let manager = app
        .try_state::<MetaTubeManager>()
        .ok_or_else(|| "MetaTube 管理器未初始化".to_string())?;
    Ok(manager.snapshot())
}

/// 手动重启 sidecar（启动失败/放弃后重试）。
#[tauri::command]
pub async fn metatube_restart(app: AppHandle) -> Result<MetaTubeStatusSnapshot, String> {
    let manager = app
        .try_state::<MetaTubeManager>()
        .ok_or_else(|| "MetaTube 管理器未初始化".to_string())?;
    manager.restart();
    Ok(manager.snapshot())
}

/// 下载最新 MetaTube：按当前系统/架构取官方最新 release 资产，解压落地到应用数据 `bin/`，
/// 重解析二进制并尝试启动（启用时）。返回更新后的状态快照。
#[tauri::command]
pub async fn metatube_download_latest(app: AppHandle) -> Result<MetaTubeStatusSnapshot, String> {
    let bin_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?
        .join("bin");

    super::installer::download_latest(&bin_dir).await?;

    let manager = app
        .try_state::<MetaTubeManager>()
        .ok_or_else(|| "MetaTube 管理器未初始化".to_string())?;
    manager.reresolve_binary();
    manager.start();
    Ok(manager.snapshot())
}
