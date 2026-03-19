use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

struct PendingAppUpdate {
    update: Update,
    bytes: Vec<u8>,
}

pub struct PendingAppUpdateState {
    pending: Mutex<Option<PendingAppUpdate>>,
}

impl PendingAppUpdateState {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(None),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    configured: bool,
    available: bool,
    current_version: String,
    version: Option<String>,
    body: Option<String>,
    date: Option<String>,
    target: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateDownloadProgress {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    progress: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateDownloadFinished {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

const UPDATER_NOT_CONFIGURED: &str = "UPDATER_NOT_CONFIGURED";
const GITHUB_RELEASES_API_BASE: &str = "https://api.github.com/repos/ddmoyu/javm/releases/tags";

#[derive(Debug, serde::Deserialize)]
struct GithubReleaseResponse {
    body: Option<String>,
}

fn is_updater_not_configured_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("pubkey")
        || lower.contains("endpoint")
        || lower.contains("endpoints")
        || lower.contains("updater") && lower.contains("config")
}

async fn fetch_release_notes(version: &str) -> Option<String> {
    let tag = if version.starts_with('v') {
        version.to_string()
    } else {
        format!("v{version}")
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;
    let response = client
        .get(format!("{GITHUB_RELEASES_API_BASE}/{tag}"))
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header(
            reqwest::header::USER_AGENT,
            format!("javm/{}", env!("CARGO_PKG_VERSION")),
        )
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let release = response.json::<GithubReleaseResponse>().await.ok()?;
    let body = release.body?.trim().to_string();
    if body.is_empty() {
        return None;
    }

    Some(body)
}

async fn resolve_update_body(version: &str, body: Option<String>) -> Option<String> {
    let body = body
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if body.is_some() {
        return body;
    }

    fetch_release_notes(version).await
}

fn build_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    app.updater_builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("初始化更新器失败: {e}"))
}

#[tauri::command]
pub async fn check_app_update(app: AppHandle) -> Result<AppUpdateInfo, String> {
    let current_version = app.package_info().version.to_string();

    let updater = match build_updater(&app) {
        Ok(updater) => updater,
        Err(error) if is_updater_not_configured_error(&error) => {
            return Err(UPDATER_NOT_CONFIGURED.to_string());
        }
        Err(error) => return Err(error),
    };
    let update = updater
        .check()
        .await
        .map_err(|e| format!("检查更新失败: {e}"))?;

    if let Some(update) = update {
        let current_version = update.current_version;
        let version = update.version;
        let body = resolve_update_body(&version, update.body).await;
        let date = update.date.map(|date| date.to_string());
        let target = update.target;

        Ok(AppUpdateInfo {
            configured: true,
            available: true,
            current_version,
            version: Some(version),
            body,
            date,
            target: Some(target),
        })
    } else {
        Ok(AppUpdateInfo {
            configured: true,
            available: false,
            current_version,
            version: None,
            body: None,
            date: None,
            target: None,
        })
    }
}

#[tauri::command]
pub async fn download_app_update(
    app: AppHandle,
    pending_update_state: State<'_, PendingAppUpdateState>,
) -> Result<String, String> {
    let updater = build_updater(&app)?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("检查更新失败: {e}"))?
        .ok_or_else(|| "当前没有可用更新".to_string())?;

    let downloaded_bytes = Arc::new(AtomicU64::new(0));
    let total_bytes = Arc::new(AtomicU64::new(0));
    let progress_app = app.clone();
    let finish_app = app.clone();
    let progress_downloaded_bytes = Arc::clone(&downloaded_bytes);
    let progress_total_bytes = Arc::clone(&total_bytes);
    let finish_downloaded_bytes = Arc::clone(&downloaded_bytes);
    let finish_total_bytes = Arc::clone(&total_bytes);

    let bytes = update
        .download(
            move |chunk_length, content_length| {
                let downloaded = progress_downloaded_bytes
                    .fetch_add(chunk_length as u64, Ordering::Relaxed)
                    + chunk_length as u64;

                if let Some(total) = content_length {
                    progress_total_bytes.store(total, Ordering::Relaxed);
                }

                let total = progress_total_bytes.load(Ordering::Relaxed);
                let total = if total > 0 { Some(total) } else { None };
                let progress = total.map(|value| {
                    let percent = downloaded as f64 / value as f64 * 100.0;
                    percent.clamp(0.0, 100.0)
                });

                let payload = AppUpdateDownloadProgress {
                    downloaded_bytes: downloaded,
                    total_bytes: total,
                    progress,
                };

                let _ = progress_app.emit("updater-download-progress", payload);
            },
            || {},
        )
        .await
        .map_err(|e| format!("下载更新失败: {e}"))?;

    {
        let mut pending = pending_update_state.pending.lock().await;
        *pending = Some(PendingAppUpdate { update, bytes });
    }

    let downloaded = finish_downloaded_bytes.load(Ordering::Relaxed);
    let total = finish_total_bytes.load(Ordering::Relaxed);
    let payload = AppUpdateDownloadFinished {
        downloaded_bytes: downloaded,
        total_bytes: if total > 0 { Some(total) } else { None },
    };

    let _ = finish_app.emit("updater-download-finished", payload);

    Ok("更新包下载完成，请确认后开始安装。".to_string())
}

#[tauri::command]
pub async fn install_app_update(
    pending_update_state: State<'_, PendingAppUpdateState>,
) -> Result<String, String> {
    let pending = {
        let mut guard = pending_update_state.pending.lock().await;
        guard.take()
    }
    .ok_or_else(|| "尚未下载更新包，请先下载后再安装。".to_string())?;

    if let Err(error) = pending.update.install(&pending.bytes) {
        let mut guard = pending_update_state.pending.lock().await;
        *guard = Some(pending);
        return Err(format!("安装更新失败: {error}"));
    }

    #[cfg(target_os = "windows")]
    {
        Ok("更新安装程序已启动，应用会自动退出完成安装。".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok("更新已安装，请重启应用以完成切换。".to_string())
    }
}