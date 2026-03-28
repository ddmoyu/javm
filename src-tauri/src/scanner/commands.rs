//! 扫描相关的 Tauri 命令

use crate::db::Database;
use crate::scanner::{ScanProgress, ScannerService};
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn scan_directory(app: AppHandle, path: String) -> Result<u32, String> {
    let db = Database::new(&app).map_err(|e| e.to_string())?;
    let scanner = ScannerService::new(db.clone());
    let app_clone = app.clone();
    let app_clone2 = app.clone();

    let count = scanner
        .scan_directory_async(&path, move |progress| {
            let _ = app_clone.emit("scan-progress", progress);
        })
        .await?;

    // 更新 directories 表中的视频数量
    let db_clone = db.clone();
    let path_clone = path.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let conn = db_clone.get_connection().map_err(|e| e.to_string())?;

        let dir_exists: bool =
            Database::check_directory_exists(&conn, &path_clone).map_err(|e| e.to_string())?;

        if dir_exists {
            let video_count =
                Database::count_videos_in_directory(&conn, &path_clone).map_err(|e| e.to_string())?;
            Database::update_directory_video_count(&conn, &path_clone, video_count)
                .map_err(|e| e.to_string())?;
        }

        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())??;

    // 发送扫描完成信号（null 进度）
    let _ = app_clone2.emit("scan-progress", Option::<ScanProgress>::None);

    Ok(count)
}
