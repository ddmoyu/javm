use std::path::Path;
use tauri::AppHandle;
use tauri::State;

use crate::error::{AppError, AppResult};

use super::service::{
    clear_video_scrape_data, copy_dir_recursive, delete_video_and_files,
    enrich_videos_with_file_times, ensure_video_in_own_dir_with_db, move_file,
    update_all_directories_count, AdVideo, VideoUpdateContext, VideoUpdatePayload,
    VideoUpdateResult, build_nfo_metadata_for_update, load_video_relation_names,
    parse_name_list,
};

// ==================== 目录管理 ====================

#[tauri::command]
pub async fn get_directories(db: State<'_, crate::db::Database>) -> AppResult<Vec<serde_json::Value>> {
    let conn = db.get_connection()?;

    tokio::task::spawn_blocking(move || {
        let mut stmt = conn
            .prepare("SELECT id, path, video_count, created_at, updated_at FROM directories ORDER BY created_at DESC")?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let path: String = row.get(1)?;
                let count: i64 = row.get(2)?;
                let created_at: String = row.get(3)?;
                let updated_at: String = row.get(4)?;
                Ok(serde_json::json!({
                    "id": id,
                    "path": path,
                    "videoCount": count,
                    "createdAt": created_at,
                    "updatedAt": updated_at
                }))
            })?;

        let mut dirs = Vec::new();
        for r in rows {
            dirs.push(r?);
        }
        Ok(dirs)
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}

#[tauri::command]
pub async fn add_directory(db: State<'_, crate::db::Database>, path: String) -> AppResult<String> {
    use uuid::Uuid;

    if crate::scanner::file_scanner::is_skipped_directory(Path::new(&path)) {
        return Err(AppError::Business("该目录已被系统忽略，不能添加：behind the scenes / backdrops".to_string()));
    }

    let conn = db.get_connection()?;

    tokio::task::spawn_blocking(move || {
        let exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM directories WHERE path = ?",
                [&path],
                |row| row.get(0),
            )?;

        if exists {
            return Err(AppError::Business("目录已存在".to_string()));
        }

        let id = Uuid::new_v4().to_string();

        conn.execute(
            "INSERT INTO directories (id, path, video_count) VALUES (?, ?, 0)",
            rusqlite::params![&id, &path],
        )?;

        Ok(id)
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}

#[tauri::command]
pub async fn delete_directory(db: State<'_, crate::db::Database>, id: String) -> AppResult<()> {
    let conn = db.get_connection()?;

    tokio::task::spawn_blocking(move || {
        let path: String = conn
            .query_row("SELECT path FROM directories WHERE id = ?", [&id], |row| {
                row.get(0)
            })?;

        crate::db::Database::delete_videos_in_directory(&conn, &path)?;

        conn.execute("DELETE FROM directories WHERE id = ?", [&id])?;

        Ok(())
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}

// ==================== 视频管理 ====================

#[tauri::command]
pub async fn get_videos(db: State<'_, crate::db::Database>) -> AppResult<Vec<serde_json::Value>> {
    let conn = db.get_connection()?;

    let videos = tokio::task::spawn_blocking(move || -> AppResult<Vec<serde_json::Value>> {
        let sql = r#"
            SELECT
                v.id,
                v.title,
                v.video_path,
                v.studio,
                v.premiered,
                v.rating,
                v.duration,
                v.created_at,
                v.scan_status,
                v.director,
                v.local_id,
                v.poster,
                v.thumb,
                v.fanart,
                v.original_title,
                (
                    SELECT GROUP_CONCAT(a.name, ', ')
                    FROM video_actors va
                    JOIN actors a ON va.actor_id = a.id
                    WHERE va.video_id = v.id
                    ORDER BY va.priority
                ) as actors,
                v.resolution,
                v.file_size,
                (
                    SELECT GROUP_CONCAT(t.name, ', ')
                    FROM video_tags vt
                    JOIN tags t ON vt.tag_id = t.id
                    WHERE vt.video_id = v.id
                ) as tags,
                (
                    SELECT GROUP_CONCAT(g.name, ', ')
                    FROM video_genres vg
                    JOIN genres g ON vg.genre_id = g.id
                    WHERE vg.video_id = v.id
                ) as genres,
                v.fast_hash,
                v.cover_width,
                v.cover_height,
                v.is_uncensored
            FROM videos v
        "#;
        // 注意：不在 SQL 里排序，最终顺序由 enrich_videos_with_file_times 按文件
        // 创建时间重排覆盖，此处排序属浪费。

        let mut stmt = conn.prepare(sql)?;

        let video_iter = stmt
            .query_map([], |row| {
                let poster: Option<String> = row.get(11)?;
                let thumb: Option<String> = row.get(12)?;

                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "title": row.get::<_, Option<String>>(1)?,
                    "videoPath": row.get::<_, String>(2)?,
                    "dirPath": std::path::Path::new(&row.get::<_, String>(2)?)
                        .parent()
                        .map(|path| path.to_string_lossy().to_string()),
                    "studio": row.get::<_, Option<String>>(3)?,
                    "premiered": row.get::<_, Option<String>>(4)?,
                    "rating": row.get::<_, Option<f64>>(5)?.unwrap_or(0.0),
                    "duration": row.get::<_, Option<i64>>(6)?.unwrap_or(0),
                    "createdAt": row.get::<_, String>(7)?,
                    "scanStatus": row.get::<_, i32>(8)?,
                    "director": row.get::<_, Option<String>>(9)?,
                    "localId": row.get::<_, Option<String>>(10)?,
                    // 原始 poster，封面存在性解析挪到 enrich 并发阶段，避免在此串行 exists()
                    "poster": poster,
                    "thumb": thumb,
                    "fanart": row.get::<_, Option<String>>(13)?,
                    "originalTitle": row.get::<_, Option<String>>(14)?,
                    "actors": row.get::<_, Option<String>>(15)?,
                    "resolution": row.get::<_, Option<String>>(16)?,
                    "fileSize": row.get::<_, Option<i64>>(17)?,
                    "tags": row.get::<_, Option<String>>(18)?,
                    "genres": row.get::<_, Option<String>>(19)?,
                    "fastHash": row.get::<_, Option<String>>(20)?,
                    "coverWidth": row.get::<_, Option<i64>>(21)?,
                    "coverHeight": row.get::<_, Option<i64>>(22)?,
                    "isUncensored": row.get::<_, Option<i64>>(23)?.unwrap_or(0) != 0,
                }))
            })?;

        let mut videos = Vec::new();
        for video in video_iter {
            videos.push(video?);
        }

        let stale_paths: Vec<String> = videos
            .iter()
            .filter_map(|video| {
                let path = video.get("videoPath").and_then(|p| p.as_str())?;
                if std::path::Path::new(path).exists() {
                    None
                } else {
                    Some(path.to_string())
                }
            })
            .collect();

        if !stale_paths.is_empty() {
            for chunk in stale_paths.chunks(500) {
                let placeholders = std::iter::repeat_n("?", chunk.len()).collect::<Vec<_>>().join(", ");
                let sql = format!("DELETE FROM videos WHERE video_path IN ({})", placeholders);
                let params = chunk
                    .iter()
                    .map(|path| path as &dyn rusqlite::types::ToSql)
                    .collect::<Vec<_>>();
                conn.execute(&sql, params.as_slice())?;
            }

            videos.retain(|video| {
                video
                    .get("videoPath")
                    .and_then(|p| p.as_str())
                    .map(|path| !stale_paths.iter().any(|stale_path| stale_path == path))
                    .unwrap_or(false)
            });
        }

        // 仅保留位于「目录管理」内的视频，避免下载到库外的文件污染媒体库
        let managed_prefixes = crate::db::Database::managed_directory_prefixes(&conn)?;
        videos.retain(|video| {
            video
                .get("videoPath")
                .and_then(|p| p.as_str())
                .map(|path| {
                    crate::db::Database::is_path_under_managed_directory(&managed_prefixes, path)
                })
                .unwrap_or(false)
        });

        Ok(videos)
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))??;

    Ok(enrich_videos_with_file_times(videos).await)
}

/// 获取演员列表（含头像与本地作品数），供「发现」页演员分面显示头像。
/// avatarPath 为本地下载头像、avatarUrl 为远程头像（前端优先本地、回退远程）。
#[tauri::command]
pub async fn get_actors(db: State<'_, crate::db::Database>) -> AppResult<Vec<serde_json::Value>> {
    let conn = db.get_connection()?;

    tokio::task::spawn_blocking(move || -> AppResult<Vec<serde_json::Value>> {
        let mut stmt = conn.prepare(
            "SELECT a.id, a.name, a.avatar_path, a.avatar_url,
                    (SELECT COUNT(*) FROM video_actors va WHERE va.actor_id = a.id) AS video_count
             FROM actors a",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, i64>(0)?,
                "name": row.get::<_, String>(1)?,
                "avatarPath": row.get::<_, Option<String>>(2)?,
                "avatarUrl": row.get::<_, Option<String>>(3)?,
                "videoCount": row.get::<_, i64>(4)?,
            }))
        })?;

        let mut actors = Vec::new();
        for r in rows {
            actors.push(r?);
        }
        Ok(actors)
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}

/// 回填存量视频的封面尺寸：扫描有 poster 但缺 cover_width/cover_height 的记录，
/// 仅读图头补算尺寸写回。瀑布流等高画廊布局/虚拟化需要封面比例。
/// 返回成功补算的数量。
#[tauri::command]
pub async fn backfill_cover_dimensions(db: State<'_, crate::db::Database>) -> AppResult<u32> {
    let conn = db.get_connection()?;

    tokio::task::spawn_blocking(move || -> AppResult<u32> {
        let targets: Vec<(String, String)> = {
            let mut stmt = conn.prepare(
                "SELECT id, poster FROM videos
                 WHERE poster IS NOT NULL AND poster <> ''
                   AND (cover_width IS NULL OR cover_height IS NULL)",
            )?;
            let iter = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            let mut list = Vec::new();
            for item in iter {
                list.push(item?);
            }
            list
        };

        let mut updated = 0u32;
        for (id, poster) in targets {
            if let Ok((w, h)) = image::image_dimensions(&poster) {
                if w > 0 && h > 0 {
                    conn.execute(
                        "UPDATE videos SET cover_width = ?, cover_height = ? WHERE id = ?",
                        rusqlite::params![w as i64, h as i64, id],
                    )?;
                    updated += 1;
                }
            }
        }
        Ok(updated)
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}

#[tauri::command]

pub async fn get_duplicate_videos(db: State<'_, crate::db::Database>) -> AppResult<Vec<serde_json::Value>> {
    let conn = db.get_connection()?;

    tokio::task::spawn_blocking(move || {
        // 跨目录查找 fast_hash 重复或 local_id（番号）重复的视频
        let sql = r#"
            SELECT
                v.id,
                v.title,
                v.video_path,
                v.dir_path,
                v.local_id,
                v.resolution,
                v.file_size,
                v.fast_hash,
                v.scan_status,
                v.duration
            FROM videos v
            WHERE (v.fast_hash IS NOT NULL AND v.fast_hash != '' AND v.fast_hash IN (
                SELECT fast_hash FROM videos WHERE fast_hash IS NOT NULL AND fast_hash != '' GROUP BY fast_hash HAVING COUNT(*) > 1
            ))
            OR (v.local_id IS NOT NULL AND v.local_id != '' AND v.local_id IN (
                SELECT local_id FROM videos WHERE local_id IS NOT NULL AND local_id != '' GROUP BY local_id HAVING COUNT(*) > 1
            ))
            ORDER BY v.local_id, v.fast_hash, v.created_at DESC
        "#;

        let mut stmt = conn.prepare(sql)?;
        let video_iter = stmt
            .query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "title": row.get::<_, Option<String>>(1)?,
                    "videoPath": row.get::<_, String>(2)?,
                    "dirPath": row.get::<_, Option<String>>(3)?,
                    "localId": row.get::<_, Option<String>>(4)?,
                    "resolution": row.get::<_, Option<String>>(5)?,
                    "fileSize": row.get::<_, Option<i64>>(6)?,
                    "fastHash": row.get::<_, Option<String>>(7)?,
                    "scanStatus": row.get::<_, i32>(8)?,
                    "duration": row.get::<_, Option<i32>>(9)?,
                }))
            })?;

        let mut videos = Vec::new();
        for video in video_iter {
            videos.push(video?);
        }

        Ok(videos)
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}

#[tauri::command]
pub async fn delete_video_db(db: State<'_, crate::db::Database>, id: String) -> AppResult<()> {
    let conn = db.get_connection()?;

    tokio::task::spawn_blocking(move || {
        conn.execute("DELETE FROM videos WHERE id = ?", [id])?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}

#[tauri::command]
pub async fn delete_video_file(
    db: State<'_, crate::db::Database>,
    id: String,
    delete_scrape_data_only: Option<bool>,
) -> AppResult<()> {
    let conn = db.get_connection()?;

    tokio::task::spawn_blocking(move || {
        if delete_scrape_data_only.unwrap_or(false) {
            clear_video_scrape_data(&conn, &id).map_err(|e| AppError::Business(e))?;
        } else {
            delete_video_and_files(&conn, &id).map_err(|e| AppError::Business(e))?;
        }
        let _ = update_all_directories_count(&conn);
        Ok(())
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}

#[tauri::command]

pub async fn move_video_file(app: AppHandle, db: State<'_, crate::db::Database>, id: String, target_dir: String) -> AppResult<()> {
    use std::fs;
    use std::path::Path;

    let conn = db.get_connection()?;
    let app_clone = app.clone();
    // 独立目录模式配置（用于移动后同步 .strm）
    let storage_cfg = crate::media::storage::MetadataStorageConfig::from_settings(
        &crate::settings::get_settings(app.clone()).await.unwrap_or_default(),
    );

    tokio::task::spawn_blocking(move || {
        let _app = app_clone;

        // 校验目标路径在已注册的扫描目录范围内
        super::service::validate_path_within_managed_dirs(&conn, Path::new(&target_dir))?;

        // 查询视频路径、同级图路径与番号
        let (current_path, poster, thumb, fanart, local_id): (String, Option<String>, Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT video_path, poster, thumb, fanart, local_id FROM videos WHERE id = ?",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )?;

        let current_path_obj = Path::new(&current_path);
        if !current_path_obj.exists() {
            return Err(AppError::Business("源视频文件不存在".to_string()));
        }

        let file_name = current_path_obj.file_name().ok_or_else(|| AppError::Business("无效的文件名".to_string()))?;
        let new_path_obj = Path::new(&target_dir).join(file_name);

        if new_path_obj.exists() {
            return Err(AppError::Business("目标目录已存在同名文件".to_string()));
        }

        // 1. 移动视频文件
        move_file(current_path_obj, &new_path_obj).map_err(|e| AppError::Business(format!("移动视频失败: {}", e)))?;

        // 2. 移动 NFO 文件
        let current_nfo = current_path_obj.with_extension("nfo");
        if current_nfo.exists() {
            let new_nfo = new_path_obj.with_extension("nfo");
            let _ = move_file(&current_nfo, &new_nfo);
        }

        // 3. 移动同级图片资源
        // 仅搬动与视频同级的图；独立元数据目录里的图留在原地（库内路径不变）
        let move_artwork = |path_opt: Option<String>, label: &str| -> AppResult<Option<String>> {
            if let Some(path) = path_opt {
                let source = Path::new(&path);
                if source.exists() && source.parent() == current_path_obj.parent() {
                    let file_name = source.file_name().ok_or_else(|| AppError::Business(format!("无效的{}文件名", label)))?;
                    let target = Path::new(&target_dir).join(file_name);
                    move_file(source, &target).map_err(|e| AppError::Business(format!("移动{}失败: {}", label, e)))?;
                    return Ok(Some(target.to_string_lossy().to_string()));
                }
            }
            Ok(None)
        };
        let new_poster = move_artwork(poster.clone(), "poster")?;
        let new_thumb = move_artwork(thumb.clone(), "thumb")?;
        let new_fanart = move_artwork(fanart.clone(), "fanart")?;

        // 4. 移动 extrafanart 目录
        let old_parent = current_path_obj.parent().ok_or_else(|| AppError::Business("无效的源路径".to_string()))?;
        let extrafanart_dir = old_parent.join("extrafanart");
        if extrafanart_dir.exists() && extrafanart_dir.is_dir() {
            let target_extrafanart_dir = Path::new(&target_dir).join("extrafanart");
            copy_dir_recursive(&extrafanart_dir, &target_extrafanart_dir)
                .map_err(|e| AppError::Business(format!("移动 extrafanart 目录失败: {}", e)))?;
            let _ = fs::remove_dir_all(&extrafanart_dir);
        }

        // 5. 更新数据库
        let new_path_str = new_path_obj.to_string_lossy().to_string();
        conn.execute(
            "UPDATE videos SET video_path = ?, dir_path = ?, poster = ?, thumb = ?, fanart = ?, updated_at = datetime('now') WHERE id = ?",
            rusqlite::params![
                new_path_str,
                target_dir,
                new_poster.or(poster),
                new_thumb.or(thumb),
                new_fanart.or(fanart),
                id
            ],
        )?;

        // 独立目录模式：把对应番号的 .strm 指向新视频路径（外部媒体库点播才不会失效）
        if let Err(e) = crate::media::storage::sync_independent_strm(
            &storage_cfg,
            local_id.as_deref().unwrap_or_default(),
            &new_path_str,
        ) {
            log::warn!("[video_move] event=sync_strm_failed video_id={} error={}", id, e);
        }

        Ok(())
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}

#[tauri::command]
pub async fn update_video(app: AppHandle, db: State<'_, crate::db::Database>, id: String, data: VideoUpdatePayload) -> AppResult<VideoUpdateResult> {
    // 确保视频在独立的同名目录中（避免重命名时影响其他视频的资源）
    if let Err(e) = ensure_video_in_own_dir_with_db(&app, &id) {
        log::warn!(
            "[video_update] event=ensure_own_dir_failed video_id={} error={}",
            id,
            e
        );
    }

    let mut conn = db.get_connection()?;
    let app_clone = app.clone();
    // 独立目录模式配置（用于重命名后同步 .strm）
    let storage_cfg = crate::media::storage::MetadataStorageConfig::from_settings(
        &crate::settings::get_settings(app.clone()).await.unwrap_or_default(),
    );

    tokio::task::spawn_blocking(move || {
        let _app = app_clone;

        let title_to_store = data.title.as_ref().map(|value| value.trim().to_string());

        if matches!(title_to_store.as_deref(), Some("")) {
            return Err(AppError::Business("标题不能为空".to_string()));
        }

        let current = conn
            .query_row(
                "SELECT title, original_title, local_id, studio, director, premiered, duration, rating, video_path, dir_path, poster, thumb, fanart FROM videos WHERE id = ?",
                [&id],
                |row| {
                    Ok(VideoUpdateContext {
                        title: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                        original_title: row.get(1)?,
                        local_id: row.get(2)?,
                        studio: row.get(3)?,
                        director: row.get(4)?,
                        premiered: row.get(5)?,
                        duration: row.get(6)?,
                        rating: row.get(7)?,
                        video_path: row.get(8)?,
                        dir_path: row.get(9)?,
                        poster: row.get(10)?,
                        thumb: row.get(11)?,
                        fanart: row.get(12)?,
                        actors: Vec::new(),
                        tags: Vec::new(),
                        genres: Vec::new(),
                    })
                },
            )?;

        let mut current = VideoUpdateContext {
            actors: load_video_relation_names(
                &conn,
                "SELECT a.name FROM video_actors va JOIN actors a ON va.actor_id = a.id WHERE va.video_id = ? ORDER BY va.priority",
                &id,
            ).map_err(|e| AppError::Business(e))?,
            tags: load_video_relation_names(
                &conn,
                "SELECT t.name FROM video_tags vt JOIN tags t ON vt.tag_id = t.id WHERE vt.video_id = ? ORDER BY t.name",
                &id,
            ).map_err(|e| AppError::Business(e))?,
            genres: load_video_relation_names(
                &conn,
                "SELECT g.name FROM video_genres vg JOIN genres g ON vg.genre_id = g.id WHERE vg.video_id = ? ORDER BY g.name",
                &id,
            ).map_err(|e| AppError::Business(e))?,
            ..current
        };

        let mut parsed_duration = current.duration.map(|value| value as i32);
        let nfo_path = std::path::Path::new(&current.video_path).with_extension("nfo");
        let parsed_nfo = if nfo_path.exists() {
            crate::nfo::parser::parse_nfo(&nfo_path, &mut parsed_duration)
        } else {
            None
        };

        let updated_actors = data.actors.as_ref().map(|actors| parse_name_list(actors));
        let updated_tags = data.tags.as_ref().map(|tags| parse_name_list(tags));
        let rewritten_nfo_metadata = build_nfo_metadata_for_update(
            &current,
            &data,
            parsed_nfo.as_ref(),
            updated_actors.as_deref(),
            updated_tags.as_deref(),
        );
        let mut final_video_path = current.video_path.clone();
        let mut final_dir_path = current.dir_path.clone().or_else(|| {
            std::path::Path::new(&current.video_path)
                .parent()
                .map(|path| path.to_string_lossy().to_string())
        });
        let mut final_poster = current.poster.clone();
        let mut final_thumb = current.thumb.clone();
        let mut final_fanart = current.fanart.clone();

        let tx = conn.transaction()?;

        // 更新基本字段
        let mut sql_parts = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(v) = &title_to_store {
            sql_parts.push("title = ?");
            params.push(Box::new(v.clone()) as Box<dyn rusqlite::ToSql>);
            current.title = v.clone();
        }
        if let Some(v) = &data.local_id {
            sql_parts.push("local_id = ?");
            params.push(Box::new(v.clone()) as Box<dyn rusqlite::ToSql>);
        }
        if let Some(v) = &data.duration {
            sql_parts.push("duration = ?");
            params.push(Box::new(*v as i64) as Box<dyn rusqlite::ToSql>);
        }
        if let Some(v) = &data.premiered {
            sql_parts.push("premiered = ?");
            params.push(Box::new(v.clone()) as Box<dyn rusqlite::ToSql>);
        }
        if let Some(v) = &data.rating {
            sql_parts.push("rating = ?");
            params.push(Box::new(*v) as Box<dyn rusqlite::ToSql>);
        }

        // 直接字符串字段（不再使用外键）
        if let Some(v) = &data.studio {
            sql_parts.push("studio = ?");
            params.push(Box::new(v.clone()) as Box<dyn rusqlite::ToSql>);
        }
        if let Some(v) = &data.director {
            sql_parts.push("director = ?");
            params.push(Box::new(v.clone()) as Box<dyn rusqlite::ToSql>);
        }
        if let Some(v) = &data.resolution {
            sql_parts.push("resolution = ?");
            params.push(Box::new(v.clone()) as Box<dyn rusqlite::ToSql>);
        }
        // maker 字段已不再使用

        sql_parts.push("updated_at = datetime('now')");

        if !sql_parts.is_empty() {
            let sql = format!("UPDATE videos SET {} WHERE id = ?", sql_parts.join(", "));
            params.push(Box::new(id.clone()));

            let mut stmt = tx.prepare(&sql)?;
            stmt.execute(rusqlite::params_from_iter(params.iter()))?;
        }

        if let Some(actors) = &updated_actors {
            current.actors = actors.clone();

            tx.execute("DELETE FROM video_actors WHERE video_id = ?", [&id])?;

            for (idx, actor_name) in actors.iter().enumerate() {
                let actor_id = crate::db::Database::get_or_create_actor(&tx, actor_name)?;
                tx.execute(
                    "INSERT INTO video_actors (video_id, actor_id, priority) VALUES (?, ?, ?)",
                    rusqlite::params![&id, actor_id, idx as i64],
                )?;
            }
        }

        // 处理标签（如果提供）
        if let Some(tags) = &updated_tags {
            current.tags = tags.clone();

            // 删除已有标签
            tx.execute("DELETE FROM video_tags WHERE video_id = ?", [&id])?;

            // 插入新标签
            for tag_name in tags.iter() {
                let tag_id = crate::db::Database::get_or_create_tag(&tx, tag_name)?;
                tx.execute(
                    "INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)",
                    rusqlite::params![&id, tag_id],
                )?;
            }
        }

        // 维度同步：从更新后的行重建片商 / 系列 / 导演关联（番号/片商/导演任一变更都生效）
        {
            let (studio, director, local_id): (Option<String>, Option<String>, Option<String>) =
                tx.query_row(
                    "SELECT studio, director, local_id FROM videos WHERE id = ?",
                    [&id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?;
            crate::db::Database::sync_video_dimensions(
                &tx,
                &id,
                studio.as_deref(),
                director.as_deref(),
                local_id.as_deref(),
            )?;
        }

        if let Some(title) = &title_to_store {
            if let Some(relocated) = crate::media::assets::rename_video_assets_with_title(
                &final_video_path,
                title,
                final_poster.as_deref(),
                final_thumb.as_deref(),
                final_fanart.as_deref(),
            ).map_err(|e| AppError::Business(e))? {
                final_video_path = relocated.video_path;
                final_dir_path = Some(relocated.dir_path);
                final_poster = relocated.poster;
                final_thumb = relocated.thumb;
                final_fanart = relocated.fanart;

                crate::db::Database::update_video_file_location_tx(
                    &tx,
                    &id,
                    &relocated.original_video_path,
                    &final_video_path,
                    final_dir_path.as_deref().unwrap_or_default(),
                    final_poster.as_deref(),
                    final_thumb.as_deref(),
                    final_fanart.as_deref(),
                )?;
            }
        }

        // 独立目录模式：视频被重命名/移动时，同步对应番号的 .strm 指向新路径
        if final_video_path != current.video_path {
            if let Err(e) = crate::media::storage::sync_independent_strm(
                &storage_cfg,
                current.local_id.as_deref().unwrap_or_default(),
                &final_video_path,
            ) {
                log::warn!("[video_update] event=sync_strm_failed video_id={} error={}", id, e);
            }
        }

        // 独立目录模式：把更新后的 NFO 写回独立目录；非独立 / 未找到时回退写视频同级
        let wrote_independent_nfo = match crate::media::storage::save_nfo_to_independent_dir(
            &storage_cfg,
            current.local_id.as_deref().unwrap_or_default(),
            &rewritten_nfo_metadata,
        ) {
            Ok(wrote) => wrote,
            Err(e) => {
                log::warn!("[video_update] event=save_independent_nfo_failed video_id={} error={}", id, e);
                false
            }
        };
        if !wrote_independent_nfo {
            crate::media::assets::save_nfo_for_video(&final_video_path, &rewritten_nfo_metadata)
                .map_err(|e| AppError::Business(e))?;
        }

        tx.commit()?;

        Ok(VideoUpdateResult {
            title: current.title,
            video_path: final_video_path,
            dir_path: final_dir_path,
            poster: final_poster,
            thumb: final_thumb,
            fanart: final_fanart,
        })
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}

#[tauri::command]
pub async fn find_ad_videos(
    app: AppHandle,
    db: State<'_, crate::db::Database>,
    keywords: Option<Vec<String>>,
    check_duplicate: Option<bool>,
    exclude_keywords: Option<Vec<String>>,
) -> AppResult<Vec<AdVideo>> {
    use std::collections::HashMap;

    let check_duplicate = check_duplicate.unwrap_or(true);

    // 如果没有传入关键词，从设置中读取（async）
    let settings = crate::settings::get_settings(app.clone()).await.map_err(|e| AppError::Business(e))?;
    let keywords = keywords.unwrap_or(settings.ad_filter.keywords);
    let exclude_keywords = exclude_keywords.unwrap_or(settings.ad_filter.exclude_keywords);

    log::info!(
        "[ad_video_scan] event=start keywords={:?} exclude_keywords={:?} check_duplicate={}",
        keywords,
        exclude_keywords,
        check_duplicate
    );

    let conn = db.get_connection()?;

    tokio::task::spawn_blocking(move || {
        let mut ad_videos = Vec::new();

        // 第一步：查询所有视频（移除 50MB 限制）
        let mut stmt = conn
            .prepare("SELECT id, video_path, file_size, title FROM videos")?;

        let all_videos = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })?;

        let mut video_list = Vec::new();
        for video in all_videos {
            let (id, path, size, title) = video?;
            video_list.push((id, path, size, title));
        }

        log::info!(
            "[ad_video_scan] event=loaded_videos total={}",
            video_list.len()
        );

        // 第二步：统计文件名出现次数（在所有视频中统计）
        let mut filename_count: HashMap<String, Vec<String>> = HashMap::new();
        for (_, path, _, _) in &video_list {
            if let Some(filename) = std::path::Path::new(path).file_name() {
                let filename_str = filename.to_string_lossy().to_string();
                filename_count
                    .entry(filename_str.clone())
                    .or_insert_with(Vec::new)
                    .push(path.clone());
            }
        }

        // 第三步：检查每个视频
        for (id, path, size, title) in video_list {
            let filename = std::path::Path::new(&path)
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_default();

            let mut reasons = Vec::new();

            // 规则1: 文件大小为0（优先级最高）
            if size == 0 {
                reasons.push("文件大小为 0".to_string());
            } else {
                // 规则2: 文件名重复2次及以上
                if check_duplicate {
                    if let Some(count) = filename_count.get(&filename) {
                        if count.len() >= 2 {
                            reasons.push(format!("文件名重复 {} 次", count.len()));
                        }
                    }
                }

                // 规则3: 关键词过滤（同时检查文件名和视频标题）
                let filename_lower = filename.to_lowercase();
                let title_lower = title.as_deref().unwrap_or("").to_lowercase();
                for keyword in &keywords {
                    let kw = keyword.to_lowercase();
                    if filename_lower.contains(&kw) || title_lower.contains(&kw) {
                        reasons.push(format!("包含关键词: {}", keyword));
                        break;
                    }
                }
            }

            // 如果有任何匹配的原因，添加到结果
            // 但如果文件名或标题包含排除关键词，则跳过
            if !reasons.is_empty() {
                let filename_lower = filename.to_lowercase();
                let title_lower = title.as_deref().unwrap_or("").to_lowercase();
                let excluded = exclude_keywords
                    .iter()
                    .any(|ek| {
                        let ek_lower = ek.to_lowercase();
                        filename_lower.contains(&ek_lower) || title_lower.contains(&ek_lower)
                    });
                if !excluded {
                    ad_videos.push(AdVideo {
                        id,
                        path: path.clone(),
                        filename,
                        file_size: size,
                        reason: reasons.join(", "),
                    });
                }
            }
        }

        log::info!(
            "[ad_video_scan] event=completed suspicious_total={}",
            ad_videos.len()
        );
        Ok(ad_videos)
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}

/// 下载远程图片到 extrafanart 目录
#[tauri::command]
pub async fn download_remote_image(
    app: AppHandle,
    video_id: String,
    video_path: String,
    url: String,
) -> AppResult<String> {
    // 分离模式：预览图写入 <root>/<番号 标题>/extrafanart/，否则视频同级
    let settings = crate::settings::get_settings(app.clone()).await.unwrap_or_default();
    let cfg = crate::media::storage::MetadataStorageConfig::from_settings(&settings);
    let (local_id, title) = crate::db::Database::new(&app)
        .ok()
        .and_then(|db| {
            db.get_connection().ok().and_then(|conn| {
                conn.query_row(
                    "SELECT local_id, title FROM videos WHERE id = ?",
                    [&video_id],
                    |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)),
                )
                .ok()
            })
        })
        .map(|(a, b)| (a.unwrap_or_default(), b.unwrap_or_default()))
        .unwrap_or_default();
    let target = crate::media::storage::resolve_asset_target(&video_path, &local_id, &title, &cfg)
        .map_err(AppError::Business)?;
    let _ = crate::media::storage::ensure_asset_dir_and_strm(&target);
    let save_dir = crate::media::assets::extrafanart_dir_in(&target.dir);
    std::fs::create_dir_all(&save_dir)?;

    let next_index = crate::media::assets::next_extrafanart_index_in(&target.dir);
    let save_path = save_dir.join(format!("fanart{}.jpg", next_index));
    let client = crate::utils::proxy::apply_proxy_auto(
        wreq::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"),
    )
    .map_err(|e| AppError::Business(format!("创建 HTTP 客户端失败: {}", e)))?
    .build()?;

    let resp = client
        .get(&url)
        .header(
            "Accept",
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        )
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .header("Referer", "https://memojav.com/")
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(AppError::Business(format!("下载失败，HTTP 状态码: {}", resp.status())));
    }

    let bytes = resp
        .bytes()
        .await?;
    if bytes.is_empty() {
        return Err(AppError::Business("下载的数据为空".to_string()));
    }

    std::fs::write(&save_path, &bytes)?;

    Ok(save_path.to_string_lossy().to_string())
}

// 批量删除视频（复用 delete_video_and_files）
#[tauri::command]
pub async fn delete_videos(
    db: State<'_, crate::db::Database>,
    ids: Vec<String>,
    delete_scrape_data_only: Option<bool>,
) -> AppResult<()> {
    let conn = db.get_connection()?;
    let delete_scrape_data_only = delete_scrape_data_only.unwrap_or(false);

    tokio::task::spawn_blocking(move || {
        for id in ids {
            let result = if delete_scrape_data_only {
                clear_video_scrape_data(&conn, &id)
            } else {
                delete_video_and_files(&conn, &id)
            };

            if let Err(e) = result {
                log::error!(
                    "[video_delete] event=batch_delete_failed video_id={} delete_scrape_data_only={} error={}",
                    id,
                    delete_scrape_data_only,
                    e
                );
            }
        }

        let _ = update_all_directories_count(&conn);

        Ok(())
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}

/// 库健康诊断：各诊断项计数
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryHealth {
    /// 视频总数
    pub total: i64,
    /// 识别失败（scan_status=3）
    pub recognize_failed: i64,
    /// 刮削失败（scan_status=4）
    pub scrape_failed: i64,
    /// 缺封面（poster/thumb/fanart 均空）
    pub missing_cover: i64,
    /// 缺 NFO（nfo_mtime 空）
    pub missing_nfo: i64,
    /// 缺番号（local_id 空，无法刮削/取图）
    pub missing_code: i64,
}

/// 聚合媒体库的元数据缺口与失败项计数（库健康诊断总览）。
#[tauri::command]
pub async fn get_library_health(db: State<'_, crate::db::Database>) -> AppResult<LibraryHealth> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || -> AppResult<LibraryHealth> {
        let conn = db.get_connection()?;
        let health = conn.query_row(
            "SELECT
                COUNT(*),
                SUM(CASE WHEN scan_status = 3 THEN 1 ELSE 0 END),
                SUM(CASE WHEN scan_status = 4 THEN 1 ELSE 0 END),
                SUM(CASE WHEN (poster IS NULL OR poster = '')
                          AND (thumb IS NULL OR thumb = '')
                          AND (fanart IS NULL OR fanart = '') THEN 1 ELSE 0 END),
                SUM(CASE WHEN nfo_mtime IS NULL THEN 1 ELSE 0 END),
                SUM(CASE WHEN local_id IS NULL OR local_id = '' THEN 1 ELSE 0 END)
             FROM videos",
            [],
            |row| {
                Ok(LibraryHealth {
                    total: row.get(0)?,
                    recognize_failed: row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    scrape_failed: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    missing_cover: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                    missing_nfo: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
                    missing_code: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                })
            },
        )?;
        Ok(health)
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}
