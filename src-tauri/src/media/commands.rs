use crate::db::Database;
use crate::error::{AppError, AppResult};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

/// 视频截图任务的取消令牌管理
pub struct CaptureState {
    pub cancel_token: Mutex<Option<tokio_util::sync::CancellationToken>>,
}

#[tauri::command]
pub async fn capture_video_frames(
    app: AppHandle,
    state: State<'_, CaptureState>,
    video_path: String,
    count: usize,
) -> AppResult<Vec<String>> {
    // 取消之前可能还在运行的截图任务，并创建新的取消令牌
    let token = {
        let mut token_guard = state.cancel_token.lock().await;
        if let Some(old_token) = token_guard.take() {
            old_token.cancel();
        }
        let new_token = tokio_util::sync::CancellationToken::new();
        let cloned = new_token.clone();
        *token_guard = Some(new_token);
        cloned
    };

    // 使用流式截图：每成功一帧就通过事件推送给前端
    super::ffmpeg::capture_random_frames_streaming(&app, &video_path, count, token)
        .await
        .map_err(AppError::Business)
}

#[tauri::command]
pub async fn cancel_capture(state: State<'_, CaptureState>) -> AppResult<()> {
    let mut token_guard = state.cancel_token.lock().await;
    if let Some(token) = token_guard.take() {
        token.cancel();
    }
    Ok(())
}

/// 删除封面：删除本地文件 + 清空数据库中的封面字段
#[tauri::command]
pub async fn delete_cover(db: State<'_, Database>, video_id: String) -> AppResult<()> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        let conn = db.get_connection()?;

        // 查询当前封面路径
        let (poster, thumb): (Option<String>, Option<String>) = conn.query_row(
            "SELECT poster, thumb FROM videos WHERE id = ?",
            [&video_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        // 删除本地封面文件
        if let Some(ref path) = poster {
            let p = std::path::Path::new(path);
            if p.exists() {
                std::fs::remove_file(p)?;
            }
        }

        if let Some(ref path) = thumb {
            if poster.as_deref() != Some(path.as_str()) {
                let p = std::path::Path::new(path);
                if p.exists() {
                    std::fs::remove_file(p)?;
                }
            }
        }

        // 清空数据库中的封面字段
        conn.execute(
            "UPDATE videos SET poster = NULL, thumb = NULL, updated_at = datetime('now') WHERE id = ?",
            rusqlite::params![&video_id],
        )?;

        Ok(())
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCapturedCoverResult {
    thumb_path: String,
    video_path: String,
}

/// 查询视频的番号与标题（独立目录落地需要），缺失回退空串。
fn query_local_id_title(db: &Database, video_id: &str) -> (String, String) {
    db.get_connection()
        .ok()
        .and_then(|conn| {
            conn.query_row(
                "SELECT local_id, title FROM videos WHERE id = ?",
                [video_id],
                |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)),
            )
            .ok()
        })
        .map(|(a, b)| (a.unwrap_or_default(), b.unwrap_or_default()))
        .unwrap_or_default()
}

#[tauri::command]
pub async fn save_captured_cover(
    app: AppHandle,
    db: State<'_, Database>,
    video_id: String,
    video_path: String,
    frame_path: String,
) -> AppResult<SaveCapturedCoverResult> {
    // 分离落地配置（独立目录模式：封面落到 <root>/<番号 标题>/，否则视频同级）
    let settings = crate::settings::get_settings(app.clone()).await.unwrap_or_default();
    let cfg = crate::media::storage::MetadataStorageConfig::from_settings(&settings);
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        // 确保视频在独立的同名目录中（避免多个视频共享 extrafanart 等资源目录）
        let actual_video_path =
            crate::video::service::ensure_video_in_own_dir_with_db(&app, &video_id)
                .unwrap_or_else(|e| {
                    log::warn!(
                        "[media_capture] event=ensure_own_dir_failed_using_original_path video_id={} video_path={} error={}",
                        video_id,
                        video_path,
                        e
                    );
                    video_path.clone()
                });

        let (local_id, title) = query_local_id_title(&db, &video_id);
        let target = crate::media::storage::resolve_asset_target(
            &actual_video_path,
            &local_id,
            &title,
            &cfg,
        )
        .map_err(AppError::Business)?;
        let _ = crate::media::storage::ensure_asset_dir_and_strm(&target);
        let (asset_dir, stem) = (target.dir, target.stem);

        // 截帧产出标准图集（横版 fanart + thumb，并右裁出竖版 poster）
        let artwork =
            super::assets::save_frame_as_cover_assets(&asset_dir, &stem, &frame_path)
                .map_err(AppError::Business)?;

        // 更新数据库
        let conn = db.get_connection()?;

        let (cover_width, cover_height) =
            crate::media::artwork::read_image_dimensions(artwork.primary_dimension_path());
        crate::db::Database::update_video_cover_paths(
            &conn,
            &video_id,
            artwork.poster.as_deref(),
            artwork.thumb.as_deref(),
            artwork.fanart.as_deref(),
            cover_width,
            cover_height,
        )?;

        // 返回代表封面路径供前端刷新（横版优先）
        let cover = artwork
            .primary_dimension_path()
            .map(|s| s.to_string())
            .unwrap_or_default();
        Ok(SaveCapturedCoverResult {
            thumb_path: cover,
            video_path: actual_video_path,
        })
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCapturedThumbsResult {
    thumb_paths: Vec<String>,
    video_path: String,
}

#[tauri::command]
pub async fn save_captured_thumbs(
    app: AppHandle,
    video_id: String,
    video_path: String,
    frame_paths: Vec<String>,
) -> AppResult<SaveCapturedThumbsResult> {
    // 分离落地配置（独立目录模式：预览图落到 <root>/<番号 标题>/extrafanart/，否则视频同级）
    let settings = crate::settings::get_settings(app.clone()).await.unwrap_or_default();
    let cfg = crate::media::storage::MetadataStorageConfig::from_settings(&settings);
    tokio::task::spawn_blocking(move || {
        // 确保视频在独立的同名目录中（避免多个视频共享 extrafanart 目录）
        let actual_video_path =
            crate::video::service::ensure_video_in_own_dir_with_db(&app, &video_id)
                .unwrap_or_else(|e| {
                    log::warn!(
                        "[media_capture] event=ensure_own_dir_failed_using_original_path video_id={} video_path={} error={}",
                        video_id,
                        video_path,
                        e
                    );
                    video_path.clone()
                });

        let (local_id, title) = crate::db::Database::new(&app)
            .map(|db| query_local_id_title(&db, &video_id))
            .unwrap_or_default();
        let target = crate::media::storage::resolve_asset_target(
            &actual_video_path,
            &local_id,
            &title,
            &cfg,
        )
        .map_err(AppError::Business)?;
        let _ = crate::media::storage::ensure_asset_dir_and_strm(&target);

        // 保存多个帧作为预览图
        let thumb_paths =
            super::assets::save_frames_to_extrafanart(&target.dir, &frame_paths)
                .map_err(AppError::Business)?;

        Ok(SaveCapturedThumbsResult {
            thumb_paths,
            video_path: actual_video_path,
        })
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoPreviewImageSource {
    src: String,
    local_path: Option<String>,
    remote_url: Option<String>,
}

#[tauri::command]
pub async fn resolve_video_preview_images(
    app: AppHandle,
    video_path: String,
    local_id: Option<String>,
) -> AppResult<Vec<VideoPreviewImageSource>> {
    use std::collections::{BTreeMap, HashSet};

    if video_path.trim().is_empty() {
        return Ok(Vec::new());
    }

    // 分离落地配置：独立目录存在则从独立目录读 NFO / 预览图，否则回退视频同级
    let settings = crate::settings::get_settings(app.clone()).await.unwrap_or_default();
    let cfg = crate::media::storage::MetadataStorageConfig::from_settings(&settings);
    let local_id = local_id.unwrap_or_default();
    let (asset_dir, stem) =
        crate::media::storage::resolve_existing_asset_dir(&video_path, &local_id, &cfg);

    let mut duration = None;
    let nfo_path = asset_dir.join(format!("{}.nfo", stem));
    let remote_thumb_urls = if nfo_path.exists() {
        crate::nfo::parser::parse_nfo(&nfo_path, &mut duration)
            .map(|data| data.thumb_urls)
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let extrafanart_map = crate::media::assets::collect_extrafanart_in(&asset_dir)
        .into_iter()
        .collect::<BTreeMap<usize, String>>();
    let mut items = Vec::new();
    let mut used_local_paths = HashSet::new();
    let mut missing_remote_images = Vec::new();

    for (index, remote_url) in remote_thumb_urls.into_iter().enumerate() {
        let file_index = index + 1;
        if let Some(local_path) = extrafanart_map.get(&file_index) {
            used_local_paths.insert(local_path.clone());
            items.push(VideoPreviewImageSource {
                src: local_path.clone(),
                local_path: Some(local_path.clone()),
                remote_url: Some(remote_url),
            });
        } else {
            let remote_url = remote_url.trim().to_string();
            if remote_url.is_empty() {
                continue;
            }
            missing_remote_images.push((file_index, remote_url.clone()));
            items.push(VideoPreviewImageSource {
                src: remote_url.clone(),
                local_path: None,
                remote_url: Some(remote_url),
            });
        }
    }

    for (_, local_path) in extrafanart_map {
        if used_local_paths.insert(local_path.clone()) {
            items.push(VideoPreviewImageSource {
                src: local_path.clone(),
                local_path: Some(local_path),
                remote_url: None,
            });
        }
    }

    if !missing_remote_images.is_empty() {
        let background_dir = asset_dir.clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::media::assets::sync_extrafanart_to_dir(
                &background_dir,
                missing_remote_images,
            )
            .await;
        });
    }

    Ok(items)
}

/// 删除单个预览图文件
#[tauri::command]
pub async fn delete_thumb(db: State<'_, Database>, thumb_path: String) -> AppResult<()> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        let conn = db.get_connection()?;
        let p = std::path::Path::new(&thumb_path);
        crate::video::service::validate_path_within_managed_dirs(&conn, p)?;
        if p.exists() {
            std::fs::remove_file(p)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}

#[tauri::command]
pub async fn clear_thumbs(
    app: AppHandle,
    db: State<'_, Database>,
    video_id: String,
    video_path: String,
) -> AppResult<()> {
    // 分离模式：清空独立目录的 extrafanart，否则回退视频同级
    let settings = crate::settings::get_settings(app.clone()).await.unwrap_or_default();
    let cfg = crate::media::storage::MetadataStorageConfig::from_settings(&settings);
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        let conn = db.get_connection()?;
        let video_path_obj = std::path::Path::new(&video_path);
        crate::video::service::validate_path_within_managed_dirs(&conn, video_path_obj)?;
        let (local_id, title) = query_local_id_title(&db, &video_id);
        let target = crate::media::storage::resolve_asset_target(&video_path, &local_id, &title, &cfg)
            .map_err(AppError::Business)?;
        let extrafanart_dir = crate::media::assets::extrafanart_dir_in(&target.dir);

        if extrafanart_dir.exists() && extrafanart_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&extrafanart_dir) {
                for entry in entries.flatten() {
                    let filename = entry.file_name().to_string_lossy().to_string();
                    if filename.to_ascii_lowercase().starts_with("fanart") {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
            if let Ok(mut entries) = std::fs::read_dir(&extrafanart_dir) {
                if entries.next().is_none() {
                    let _ = std::fs::remove_dir(&extrafanart_dir);
                }
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}

/// 使用 ffmpeg 探测视频文件的实际时长（秒）
#[tauri::command]
pub async fn probe_video_duration(video_path: String) -> AppResult<f64> {
    tokio::task::spawn_blocking(move || {
        let path = std::path::Path::new(&video_path);
        if !path.exists() {
            return Err(AppError::Business("视频文件不存在".to_string()));
        }
        super::ffmpeg::get_video_duration(&video_path)
            .map_err(|e| AppError::Business(e))
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}

/// 候选图片（封面/截图），供「获取封面/截图」预览选用
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCandidate {
    /// 来源：`dmm`（后续接 `scrape` / `frame`）
    pub source: String,
    /// 类型：`cover`（横版封面）/ `screenshot`（截图）
    pub kind: String,
    /// 远程图片 URL（前端经 `rs_proxy_image` 预览，选定后下载落地）
    pub url: String,
}

/// 聚合某视频可选的封面/截图候选。
///
/// 当前来源：DMM 官方 CDN 直拼（零爬取，仅有码主流）。后续接刮削源、ffmpeg 截帧。
#[tauri::command]
pub async fn get_image_candidates(
    db: State<'_, Database>,
    video_id: String,
) -> AppResult<Vec<ImageCandidate>> {
    use rusqlite::OptionalExtension;

    // 取番号
    let db_inner = db.inner().clone();
    let vid = video_id.clone();
    let local_id: Option<String> = tokio::task::spawn_blocking(move || -> AppResult<Option<String>> {
        let conn = db_inner.get_connection()?;
        let id = conn
            .query_row(
                "SELECT local_id FROM videos WHERE id = ?",
                [&vid],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        Ok(id)
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))??;

    let code = local_id.unwrap_or_default();
    let code = code.trim();
    if code.is_empty() {
        return Ok(Vec::new());
    }

    let mut candidates = Vec::new();

    // DMM 官方直拼（探测 digital/mono 海报 + 截图）
    if let Ok(client) = crate::resource_scrape::fingerprint_client::shared_client() {
        if let Some(dmm) = crate::media::dmm::probe_dmm_images(&client, code).await {
            log::info!(
                "[image_fetch] event=dmm_probed video_id={} cid={} screenshots={}",
                video_id, dmm.cid, dmm.screenshot_urls.len()
            );
            candidates.push(ImageCandidate {
                source: "dmm".to_string(),
                kind: "cover".to_string(),
                url: dmm.cover_url,
            });
            for url in dmm.screenshot_urls {
                candidates.push(ImageCandidate {
                    source: "dmm".to_string(),
                    kind: "screenshot".to_string(),
                    url,
                });
            }
        } else {
            log::info!("[image_fetch] event=dmm_no_match video_id={} code={}", video_id, code);
        }
    }

    Ok(candidates)
}

/// 应用所选候选图的结果
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyImagesResult {
    /// 新封面代表路径（横版优先），供前端刷新；未设封面则为 None
    pub cover: Option<String>,
    /// 新增的截图（extrafanart）路径
    pub screenshots: Vec<String>,
}

/// 应用所选的封面/截图候选（核心实现，单视频命令与批量补全共用）。
///
/// - `cover_url`：横版封面 URL → 产出 poster(竖)/fanart(横)/thumb(横) 并写库。
/// - `screenshot_urls`：截图 URL → 追加到 extrafanart（不覆盖已有）。
pub(crate) async fn apply_images(
    app: &AppHandle,
    db: Database,
    video_id: &str,
    cover_url: Option<&str>,
    screenshot_urls: &[String],
) -> AppResult<ApplyImagesResult> {
    use rusqlite::OptionalExtension;

    // 取 video_path / 番号 / 标题（独立目录落地需要）
    let db_inner = db.clone();
    let vid = video_id.to_string();
    let (video_path, local_id, title): (String, String, String) =
        tokio::task::spawn_blocking(move || -> AppResult<(String, String, String)> {
            let conn = db_inner.get_connection()?;
            let row = conn
                .query_row(
                    "SELECT video_path, local_id, title FROM videos WHERE id = ?",
                    [&vid],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                            row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                        ))
                    },
                )
                .optional()?;
            row.ok_or_else(|| AppError::Business("未找到视频".to_string()))
        })
        .await
        .map_err(|e| AppError::TaskJoin(e.to_string()))??;

    // 解析落地目标（独立目录/.strm 或视频同级），与刮削落地一致
    let settings = crate::settings::get_settings(app.clone()).await.unwrap_or_default();
    let cfg = crate::media::storage::MetadataStorageConfig::from_settings(&settings);
    let target = crate::media::storage::resolve_asset_target(&video_path, &local_id, &title, &cfg)
        .map_err(AppError::Business)?;
    if let Err(e) = crate::media::storage::ensure_asset_dir_and_strm(&target) {
        log::error!("[image_fetch] event=ensure_dir_failed video_id={} error={}", video_id, e);
    }
    let dir = target.dir;
    let stem = target.stem;

    let client = crate::resource_scrape::fingerprint_client::shared_client().ok();
    let mut result = ApplyImagesResult { cover: None, screenshots: Vec::new() };

    // 封面：下载横版 → 标准图集(fanart+thumb+裁 poster) → 写库
    if let Some(url) = cover_url.map(str::trim).filter(|u| !u.is_empty()) {
        let artwork = crate::media::artwork::produce_artwork(&dir, &stem, url, "", client.as_ref()).await;
        if artwork.fanart.is_some() || artwork.poster.is_some() {
            let db_inner = db.clone();
            let vid = video_id.to_string();
            let (poster, thumb, fanart) =
                (artwork.poster.clone(), artwork.thumb.clone(), artwork.fanart.clone());
            let (cover_width, cover_height) =
                crate::media::artwork::read_image_dimensions(artwork.primary_dimension_path());
            tokio::task::spawn_blocking(move || -> AppResult<()> {
                let conn = db_inner.get_connection()?;
                crate::db::Database::update_video_cover_paths(
                    &conn,
                    &vid,
                    poster.as_deref(),
                    thumb.as_deref(),
                    fanart.as_deref(),
                    cover_width,
                    cover_height,
                )?;
                Ok(())
            })
            .await
            .map_err(|e| AppError::TaskJoin(e.to_string()))??;
            result.cover = artwork.primary_dimension_path().map(|s| s.to_string());
            log::info!("[image_fetch] event=cover_applied video_id={}", video_id);
        } else {
            log::error!("[image_fetch] event=cover_download_failed video_id={} url={}", video_id, url);
            return Err(AppError::Business("封面下载失败".to_string()));
        }
    }

    // 截图：追加到 extrafanart（不覆盖已有）
    let screenshots: Vec<String> = screenshot_urls
        .iter()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .collect();
    if !screenshots.is_empty() {
        let start = crate::media::assets::next_extrafanart_index_in(&dir);
        let items: Vec<(usize, String)> = screenshots
            .into_iter()
            .enumerate()
            .map(|(i, url)| (start + i, url))
            .collect();
        match crate::media::assets::sync_extrafanart_to_dir(&dir, items).await {
            Ok(paths) => result.screenshots = paths,
            Err(e) => log::error!("[image_fetch] event=screenshots_failed video_id={} error={}", video_id, e),
        }
    }

    Ok(result)
}

/// 应用所选的封面/截图候选（前端单视频换图）。
#[tauri::command]
pub async fn apply_image_candidates(
    app: AppHandle,
    db: State<'_, Database>,
    video_id: String,
    cover_url: Option<String>,
    screenshot_urls: Vec<String>,
) -> AppResult<ApplyImagesResult> {
    apply_images(&app, db.inner().clone(), &video_id, cover_url.as_deref(), &screenshot_urls).await
}

/// 批量获取封面结果汇总
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchFetchResult {
    pub total: usize,
    /// 命中 DMM 并应用官方封面的数量
    pub applied: usize,
    /// DMM 无匹配（番号无法转 cid / 无码 / 素人等）而跳过的数量
    pub skipped: usize,
    /// 处理出错的数量
    pub failed: usize,
}

/// 取某视频的番号（best-effort，失败/无番号返回空串）。
async fn query_local_id(db: Database, video_id: String) -> String {
    tokio::task::spawn_blocking(move || {
        use rusqlite::OptionalExtension;
        db.get_connection().ok().and_then(|conn| {
            conn.query_row(
                "SELECT local_id FROM videos WHERE id = ?",
                [&video_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .ok()
            .flatten()
            .flatten()
        })
    })
    .await
    .ok()
    .flatten()
    .unwrap_or_default()
}

/// 批量从 DMM 官方 CDN 补全封面（仅封面、不含截图，开销小）。
///
/// 对每个 video_id：探测 DMM 海报 → 命中则下载并产出标准图集写库；未命中则跳过（保留现状）。
/// 进度通过 `batch-fetch-cover-progress` 事件推送。无码 / FC2 / 素人 DMM 无图，建议用「截取封面」补全。
#[tauri::command]
pub async fn batch_fetch_covers(
    app: AppHandle,
    db: State<'_, Database>,
    video_ids: Vec<String>,
) -> AppResult<BatchFetchResult> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let total = video_ids.len();
    let db = db.inner().clone();
    let client = crate::resource_scrape::fingerprint_client::shared_client()
        .ok()
        .map(Arc::new);

    let applied = Arc::new(AtomicUsize::new(0));
    let skipped = Arc::new(AtomicUsize::new(0));
    let failed = Arc::new(AtomicUsize::new(0));
    let done = Arc::new(AtomicUsize::new(0));
    // 同一时刻最多并发 3 个视频（每个视频内部 DMM 探测仍有少量并发 HEAD）
    let semaphore = Arc::new(tokio::sync::Semaphore::new(3));

    let mut handles = Vec::new();
    for video_id in video_ids {
        let app = app.clone();
        let db = db.clone();
        let client = client.clone();
        let (applied, skipped, failed, done) =
            (applied.clone(), skipped.clone(), failed.clone(), done.clone());
        let semaphore = semaphore.clone();

        handles.push(tokio::spawn(async move {
            let _permit = semaphore.acquire_owned().await.ok();

            let code = query_local_id(db.clone(), video_id.clone()).await;
            let status = if code.trim().is_empty() {
                skipped.fetch_add(1, Ordering::Relaxed);
                "skipped"
            } else {
                let cover = match client.as_ref() {
                    Some(c) => crate::media::dmm::probe_dmm_cover(c, code.trim()).await,
                    None => None,
                };
                match cover {
                    Some(url) => match apply_images(&app, db.clone(), &video_id, Some(&url), &[]).await {
                        Ok(_) => {
                            applied.fetch_add(1, Ordering::Relaxed);
                            "applied"
                        }
                        Err(_) => {
                            failed.fetch_add(1, Ordering::Relaxed);
                            "failed"
                        }
                    },
                    None => {
                        skipped.fetch_add(1, Ordering::Relaxed);
                        "skipped"
                    }
                }
            };

            let d = done.fetch_add(1, Ordering::Relaxed) + 1;
            let _ = app.emit(
                "batch-fetch-cover-progress",
                serde_json::json!({
                    "videoId": video_id,
                    "status": status,
                    "done": d,
                    "total": total,
                }),
            );
        }));
    }

    for handle in handles {
        let _ = handle.await;
    }

    Ok(BatchFetchResult {
        total,
        applied: applied.load(Ordering::Relaxed),
        skipped: skipped.load(Ordering::Relaxed),
        failed: failed.load(Ordering::Relaxed),
    })
}
