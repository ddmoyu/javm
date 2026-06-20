//! 扫描相关的 Tauri 命令

use crate::db::Database;
use crate::scanner::{ScanProgress, ScanSummary, ScannerService};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn scan_directory(app: AppHandle, path: String) -> Result<ScanSummary, String> {
    let db = Database::new(&app).map_err(|e| e.to_string())?;
    let scanner = ScannerService::new(db.clone());
    let app_clone = app.clone();
    let app_clone2 = app.clone();

    // 创建封面截帧任务 channel（扫描过程中实时派发）
    let (cover_tx, cover_rx) = tokio::sync::mpsc::unbounded_channel::<(String, String)>();
    let cover_results: Arc<tokio::sync::Mutex<Vec<CoverResult>>> =
        Arc::new(tokio::sync::Mutex::new(Vec::new()));

    // 启动封面截帧 dispatcher（与扫描并行执行）
    let app_for_cover = app.clone();
    let results_ref = cover_results.clone();
    let cover_handle = tokio::spawn(cover_dispatcher(app_for_cover, cover_rx, results_ref));

    // 扫描目录（process_file 发现无封面时通过 cover_tx 派发任务）
    let summary = scanner
        .scan_directory_async(
            &path,
            move |progress| {
                let _ = app_clone.emit("scan-progress", progress);
            },
            Some(cover_tx),
        )
        .await?;

    // cover_tx 已在 scan_directory_async 内被 move 并 drop → channel 关闭
    // 等待所有截帧任务完成
    if let Err(e) = cover_handle.await {
        log::error!(
            "[auto_cover] event=dispatcher_join_failed path={} error={}",
            path,
            e
        );
    }

    // 扫描事务已提交，批量更新封面路径到数据库
    let results = cover_results.lock().await;
    if !results.is_empty() {
        let db_for_update = db.clone();
        let results_owned: Vec<CoverResult> = results.clone();
        drop(results);

        tauri::async_runtime::spawn_blocking(move || {
            if let Ok(conn) = db_for_update.get_connection() {
                for r in &results_owned {
                    let (cover_width, cover_height) =
                        crate::media::artwork::read_image_dimensions(r.artwork.primary_dimension_path());
                    let _ = Database::update_video_cover_paths(
                        &conn,
                        &r.video_id,
                        r.artwork.poster.as_deref(),
                        r.artwork.thumb.as_deref(),
                        r.artwork.fanart.as_deref(),
                        cover_width,
                        cover_height,
                    );
                }
            }
        })
        .await
        .ok();
    }

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

    Ok(summary)
}

// ============================================================
// 封面自动生成
// ============================================================

#[derive(Clone)]
struct CoverResult {
    video_id: String,
    artwork: crate::media::artwork::ArtworkResult,
}

/// 封面截帧 dispatcher：从 channel 接收任务，使用自适应并发执行 ffmpeg 截帧
///
/// 与扫描并行运行。扫描每发现一个无封面的视频，就通过 channel 发来一条任务。
/// dispatcher 使用 AdaptiveLimiter 控制并发数（根据 CPU 核心数和系统负载动态调整）。
/// 截帧结果（poster/thumb 文件路径）收集到 results 中，扫描完成后批量更新数据库。
async fn cover_dispatcher(
    app: AppHandle,
    mut cover_rx: tokio::sync::mpsc::UnboundedReceiver<(String, String)>,
    results: Arc<tokio::sync::Mutex<Vec<CoverResult>>>,
) {
    use crate::utils::adaptive_concurrency::AdaptiveLimiter;

    let limiter = Arc::new(AdaptiveLimiter::start(None));
    let total = Arc::new(AtomicUsize::new(0));
    let completed = Arc::new(AtomicUsize::new(0));
    let mut handles = Vec::new();

    while let Some((video_id, video_path)) = cover_rx.recv().await {
        total.fetch_add(1, Ordering::Relaxed);

        let limiter = limiter.clone();
        let app = app.clone();
        let results = results.clone();
        let total = total.clone();
        let completed = completed.clone();

        handles.push(tokio::spawn(async move {
            // 获取自适应并发槽位（系统繁忙时会等待）
            let _guard = limiter.acquire().await;

            let vid = video_id.clone();
            let vpath = video_path.clone();
            // 复用扫描时已写入数据库的时长，避免重复 ffmpeg 探测
            let db = crate::db::Database::new(&app).ok();
            let vid_for_db = vid.clone();

            let result = tokio::task::spawn_blocking(move || {
                let duration = match db
                    .as_ref()
                    .and_then(|d| d.get_connection().ok())
                    .and_then(|conn| {
                        crate::db::Database::get_video_duration(&conn, &vid_for_db)
                            .ok()
                            .flatten()
                    }) {
                    Some(secs) if secs > 0 => secs as f64,
                    _ => crate::media::ffmpeg::get_video_duration(&vpath)?,
                };
                if duration <= 0.0 {
                    return Err("视频时长为 0".to_string());
                }

                // 在 5%~15% 位置截取一帧（避开片头黑屏）
                let percentage: f64 = rand::random_range(0.05..0.15);
                let timestamp = duration * percentage;

                let temp_dir = std::env::temp_dir()
                    .join(format!("jav_auto_cover_{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
                let output = temp_dir.join("cover.jpg");
                let output_str = output.to_string_lossy().to_string();

                crate::media::ffmpeg::extract_frame(&vpath, timestamp, &output_str)?;

                // 截帧为横版 → 产出标准图集（fanart + thumb，并右裁出竖版 poster）
                let video_path_obj = std::path::Path::new(&vpath);
                let parent_dir = video_path_obj
                    .parent()
                    .ok_or("无效的视频路径")?;
                let file_stem = video_path_obj
                    .file_stem()
                    .ok_or("无效的文件名")?
                    .to_string_lossy()
                    .to_string();

                let artwork = crate::media::artwork::produce_artwork_from_local_image(
                    parent_dir,
                    &file_stem,
                    &output,
                );

                // 清理临时文件和目录
                let _ = std::fs::remove_file(&output);
                let _ = std::fs::remove_dir(&temp_dir);

                if artwork.fanart.is_none() && artwork.poster.is_none() {
                    return Err("保存封面失败".to_string());
                }
                Ok::<crate::media::artwork::ArtworkResult, String>(artwork)
            })
            .await
            .unwrap_or(Err("Task join failed".to_string()));

            let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
            let total_val = total.load(Ordering::Relaxed);

            match result {
                Ok(artwork) => {
                    let cover_path = artwork
                        .primary_dimension_path()
                        .map(|s| s.to_string())
                        .unwrap_or_default();
                    results.lock().await.push(CoverResult {
                        video_id: vid.clone(),
                        artwork,
                    });

                    let _ = app.emit(
                        "auto-cover-progress",
                        serde_json::json!({
                            "videoId": vid,
                            "status": "completed",
                            "thumbPath": cover_path,
                            "completed": done,
                            "total": total_val,
                            "concurrency": limiter.current_limit(),
                        }),
                    );
                }
                Err(e) => {
                    let _ = app.emit(
                        "auto-cover-progress",
                        serde_json::json!({
                            "videoId": vid,
                            "status": "failed",
                            "error": e,
                            "completed": done,
                            "total": total_val,
                            "concurrency": limiter.current_limit(),
                        }),
                    );
                }
            }
        }));
    }

    // channel 关闭（扫描完成），等待剩余截帧任务完成
    for handle in handles {
        let _ = handle.await;
    }

    let final_total = total.load(Ordering::Relaxed);
    let final_completed = completed.load(Ordering::Relaxed);

    if final_total > 0 {
        let _ = app.emit(
            "auto-cover-done",
            serde_json::json!({
                "total": final_total,
                "completed": final_completed,
            }),
        );
    }
}
