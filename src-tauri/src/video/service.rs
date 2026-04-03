use crate::db::Database;
use crate::error::AppError;
use std::sync::Arc;
use tokio::{sync::Semaphore, task::JoinSet};

/// 校验路径是否在已注册的扫描目录范围内，防止路径穿越
///
/// 检查 `target` 是否位于 `directories` 表中任一目录（或其子目录）下。
/// 用于验证前端传入的 `target_dir`、`thumb_path` 等参数。
pub(crate) fn validate_path_within_managed_dirs(
    conn: &rusqlite::Connection,
    target: &std::path::Path,
) -> Result<(), AppError> {
    // 规范化：统一分隔符为 /，展开 ..
    let normalize = |p: &std::path::Path| -> String {
        // 先尝试 canonicalize（路径存在时），否则用 to_string_lossy
        let s = p.canonicalize()
            .map(|c| c.to_string_lossy().to_string())
            .unwrap_or_else(|_| p.to_string_lossy().to_string());
        s.replace('\\', "/")
    };

    let target_normalized = normalize(target);

    // 检查是否包含路径穿越序列
    if target_normalized.contains("/../") || target_normalized.ends_with("/..") {
        return Err(AppError::Business("路径包含非法穿越序列".to_string()));
    }

    let mut stmt = conn
        .prepare("SELECT path FROM directories")?;
    let paths: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .filter_map(Result::ok)
        .collect();

    for dir_path in &paths {
        let dir_normalized = normalize(std::path::Path::new(dir_path));
        // 确保目标路径在某个已注册目录下（精确前缀匹配 + 分隔符边界）
        if target_normalized == dir_normalized
            || target_normalized.starts_with(&format!("{}/", dir_normalized))
        {
            return Ok(());
        }
    }

    Err(AppError::Business(format!(
        "目标路径不在已注册的扫描目录范围内: {}",
        target.display()
    )))
}

// ==================== 视频管理 ====================

fn system_time_to_rfc3339(time: std::time::SystemTime) -> String {
    let date_time: chrono::DateTime<chrono::Utc> = time.into();
    date_time.to_rfc3339()
}

fn parse_rfc3339_timestamp(value: &serde_json::Value, key: &str) -> Option<i64> {
    value
        .get(key)
        .and_then(|field| field.as_str())
        .and_then(|field| chrono::DateTime::parse_from_rfc3339(field).ok())
        .map(|field| field.timestamp_millis())
}

pub(crate) async fn enrich_videos_with_file_times(mut videos: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    let max_concurrency = std::thread::available_parallelism()
        .map(|parallelism| parallelism.get())
        .unwrap_or(4)
        .clamp(2, 16);
    let semaphore = Arc::new(Semaphore::new(max_concurrency));
    let mut tasks = JoinSet::new();

    for (index, video) in videos.iter().enumerate() {
        let Some(video_path) = video
            .get("videoPath")
            .and_then(|path| path.as_str())
            .map(str::to_owned)
        else {
            continue;
        };

        let semaphore = Arc::clone(&semaphore);
        tasks.spawn(async move {
            let _permit = semaphore.acquire_owned().await.ok();
            let metadata = tokio::task::spawn_blocking(move || std::fs::metadata(&video_path)).await;

            let (file_created_at, file_modified_at) = match metadata {
                Ok(Ok(metadata)) => {
                    let file_modified_at = metadata.modified().ok().map(system_time_to_rfc3339);
                    let file_created_at = metadata
                        .created()
                        .ok()
                        .or_else(|| metadata.modified().ok())
                        .map(system_time_to_rfc3339);
                    (file_created_at, file_modified_at)
                }
                _ => (None, None),
            };

            (index, file_created_at, file_modified_at)
        });
    }

    while let Some(result) = tasks.join_next().await {
        let Ok((index, file_created_at, file_modified_at)) = result else {
            continue;
        };

        let Some(video) = videos.get_mut(index).and_then(|video| video.as_object_mut()) else {
            continue;
        };

        let file_created_at = serde_json::to_value(file_created_at).unwrap_or(serde_json::Value::Null);
        let file_modified_at = serde_json::to_value(file_modified_at).unwrap_or(serde_json::Value::Null);

        video.insert("fileCreatedAt".to_string(), file_created_at);
        video.insert("fileModifiedAt".to_string(), file_modified_at);
    }

    videos.sort_by(|left, right| match (
        parse_rfc3339_timestamp(left, "fileCreatedAt"),
        parse_rfc3339_timestamp(right, "fileCreatedAt"),
    ) {
        (Some(left_time), Some(right_time)) => right_time.cmp(&left_time),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });

    videos
}

fn has_same_named_parent_dir(video_path: &std::path::Path) -> bool {
    let Some(parent_dir) = video_path.parent() else {
        return false;
    };
    let Some(parent_name) = parent_dir.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(file_stem) = video_path.file_stem().and_then(|name| name.to_str()) else {
        return false;
    };

    parent_name.eq_ignore_ascii_case(file_stem)
}

fn delete_if_exists(path: &std::path::Path) {
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
}

const SUBTITLE_EXTENSIONS: &[&str] = &[
    "srt", "ass", "ssa", "vtt", "sub", "idx", "smi", "sup", "sbv", "dfxp", "ttml", "scc", "usf",
];

fn is_subtitle_suffix_separator(ch: char) -> bool {
    matches!(ch, '.' | '_' | '-' | ' ' | '[' | '(')
}

fn is_matching_subtitle_file(video_path: &std::path::Path, candidate: &std::path::Path) -> bool {
    let Some(video_parent) = video_path.parent() else {
        return false;
    };
    let Some(candidate_parent) = candidate.parent() else {
        return false;
    };
    if video_parent != candidate_parent {
        return false;
    }

    let Some(extension) = candidate.extension().and_then(|ext| ext.to_str()) else {
        return false;
    };
    if !SUBTITLE_EXTENSIONS
        .iter()
        .any(|item| item.eq_ignore_ascii_case(extension))
    {
        return false;
    }

    let Some(video_stem) = video_path.file_stem().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(candidate_stem) = candidate.file_stem().and_then(|name| name.to_str()) else {
        return false;
    };

    let video_stem_lower = video_stem.to_ascii_lowercase();
    let candidate_stem_lower = candidate_stem.to_ascii_lowercase();

    candidate_stem_lower == video_stem_lower
        || candidate_stem_lower
            .strip_prefix(&video_stem_lower)
            .is_some_and(|suffix| {
                suffix
                    .chars()
                    .next()
                    .is_some_and(is_subtitle_suffix_separator)
            })
}

fn delete_matching_subtitle_files(video_path: &std::path::Path) {
    let Some(parent_dir) = video_path.parent() else {
        return;
    };

    let Ok(entries) = std::fs::read_dir(parent_dir) else {
        return;
    };

    for entry in entries.flatten() {
        let candidate = entry.path();
        if is_matching_subtitle_file(video_path, &candidate) {
            let _ = std::fs::remove_file(candidate);
        }
    }
}

/// 删除单个视频的所有关联文件（视频、NFO、封面、extrafanart 或同名目录）和数据库记录
///
/// 供 `delete_video_file` 和 `delete_videos` 共用
fn delete_video_scrape_assets(
    video_path: &std::path::Path,
    poster: Option<String>,
    thumb: Option<String>,
    fanart: Option<String>,
) {
    use std::fs;
    use std::path::Path;

    delete_if_exists(&video_path.with_extension("nfo"));

    for image_path in [poster, thumb, fanart].into_iter().flatten() {
        delete_if_exists(Path::new(&image_path));
    }

    for suffix in ["poster", "thumb", "fanart"] {
        if let Some(image_path) = crate::media::assets::find_sibling_artwork(video_path, suffix) {
            delete_if_exists(Path::new(&image_path));
        }
    }

    if let Ok(extrafanart_dir) = crate::media::assets::extrafanart_dir_for_video(video_path) {
        if extrafanart_dir.exists() && extrafanart_dir.is_dir() {
            let _ = fs::remove_dir_all(&extrafanart_dir);
        }
    }
}

pub(crate) fn clear_video_scrape_data(conn: &rusqlite::Connection, id: &str) -> Result<(), String> {
    let (video_path, poster, thumb, fanart): (String, Option<String>, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT video_path, poster, thumb, fanart FROM videos WHERE id = ?",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| e.to_string())?;

    let path_obj = std::path::Path::new(&video_path);
    delete_video_scrape_assets(path_obj, poster, thumb, fanart);

    conn.execute(
        "UPDATE videos SET
            studio = NULL,
            director = NULL,
            premiered = NULL,
            rating = NULL,
            poster = NULL,
            thumb = NULL,
            fanart = NULL,
            scraped_at = NULL,
            scan_status = CASE
                WHEN local_id IS NOT NULL AND TRIM(local_id) != '' THEN 1
                ELSE 0
            END,
            updated_at = datetime('now')
        WHERE id = ?",
        [id],
    )
    .map_err(|e| e.to_string())?;

    conn.execute("DELETE FROM video_actors WHERE video_id = ?", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM video_tags WHERE video_id = ?", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM video_genres WHERE video_id = ?", [id])
        .map_err(|e| e.to_string())?;

    Ok(())
}

pub(crate) fn delete_video_and_files(conn: &rusqlite::Connection, id: &str) -> Result<(), String> {
    use std::fs;
    use std::path::Path;

    // 获取视频路径和同级图路径
    let (video_path, poster, thumb, fanart): (String, Option<String>, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT video_path, poster, thumb, fanart FROM videos WHERE id = ?",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| e.to_string())?;

    let path_obj = Path::new(&video_path);

    if has_same_named_parent_dir(path_obj) {
        if let Some(parent_dir) = path_obj.parent() {
            if parent_dir.exists() {
                fs::remove_dir_all(parent_dir)
                    .map_err(|e| format!("删除同名目录失败 '{}': {}", parent_dir.display(), e))?;
            }
        }
    } else {
        // 删除视频文件
        delete_if_exists(path_obj);

        // 删除同名元数据和字幕
        delete_video_scrape_assets(path_obj, poster.clone(), thumb.clone(), fanart.clone());
        delete_matching_subtitle_files(path_obj);
    }

    // 删除数据库记录
    conn.execute("DELETE FROM videos WHERE id = ?", [id])
        .map_err(|e| e.to_string())?;

    Ok(())
}

pub(crate) fn update_all_directories_count(conn: &rusqlite::Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT path FROM directories")
        .map_err(|e| e.to_string())?;
    let paths: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    for path in paths {
        let video_count = Database::count_videos_in_directory(conn, &path).unwrap_or(0);
        let _ = Database::update_directory_video_count(conn, &path, video_count);
    }
    Ok(())
}

/// 递归复制目录（跨盘移动时 rename 会失败，需要 copy + delete）
pub(crate) fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dest_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            std::fs::copy(entry.path(), &dest_path)?;
        }
    }
    Ok(())
}

/// 移动文件，rename 失败时回退到 copy + delete（跨盘场景）
pub(crate) fn move_file(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    match std::fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::copy(src, dst)?;
            std::fs::remove_file(src)?;
            Ok(())
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoUpdatePayload {
    pub title: Option<String>,
    pub local_id: Option<String>,
    pub studio: Option<String>,
    pub director: Option<String>,
    pub actors: Option<String>,
    pub rating: Option<f64>,
    pub duration: Option<f64>,
    pub premiered: Option<String>,
    pub tags: Option<String>,
    pub resolution: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct VideoUpdateContext {
    pub title: String,
    pub original_title: Option<String>,
    pub local_id: Option<String>,
    pub studio: Option<String>,
    pub director: Option<String>,
    pub premiered: Option<String>,
    pub duration: Option<i64>,
    pub rating: Option<f64>,
    pub video_path: String,
    pub dir_path: Option<String>,
    pub poster: Option<String>,
    pub thumb: Option<String>,
    pub fanart: Option<String>,
    pub actors: Vec<String>,
    pub tags: Vec<String>,
    pub genres: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoUpdateResult {
    pub title: String,
    pub video_path: String,
    pub dir_path: Option<String>,
    pub poster: Option<String>,
    pub thumb: Option<String>,
    pub fanart: Option<String>,
}

pub(crate) fn parse_name_list(input: &str) -> Vec<String> {
    input
        .split(|ch| matches!(ch, ',' | '，'))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

pub(crate) fn load_video_relation_names(
    conn: &rusqlite::Connection,
    sql: &str,
    video_id: &str,
) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([video_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;

    let mut names = Vec::new();
    for row in rows {
        names.push(row.map_err(|e| e.to_string())?);
    }
    Ok(names)
}

pub(crate) fn seconds_to_minutes(duration_seconds: Option<i64>) -> Option<i64> {
    duration_seconds.and_then(|seconds| {
        if seconds <= 0 {
            None
        } else {
            Some((seconds + 59) / 60)
        }
    })
}

pub(crate) fn build_nfo_metadata_for_update(
    current: &VideoUpdateContext,
    data: &VideoUpdatePayload,
    parsed_nfo: Option<&crate::nfo::parser::NfoData>,
    updated_actors: Option<&[String]>,
    updated_tags: Option<&[String]>,
) -> crate::resource_scrape::types::ScrapeMetadata {
    let title = data
        .title
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| current.title.clone());

    let original_title = current
        .original_title
        .clone()
        .or_else(|| parsed_nfo.and_then(|nfo| nfo.original_title.clone()));

    let local_id = data
        .local_id
        .clone()
        .or_else(|| current.local_id.clone())
        .or_else(|| parsed_nfo.and_then(|nfo| nfo.local_id.clone()))
        .unwrap_or_default();

    let studio = data
        .studio
        .clone()
        .or_else(|| current.studio.clone())
        .or_else(|| parsed_nfo.and_then(|nfo| nfo.studio.clone()))
        .unwrap_or_default();

    let director = data
        .director
        .clone()
        .or_else(|| current.director.clone())
        .or_else(|| parsed_nfo.and_then(|nfo| nfo.director.clone()))
        .unwrap_or_default();

    let premiered = data
        .premiered
        .clone()
        .or_else(|| current.premiered.clone())
        .or_else(|| parsed_nfo.and_then(|nfo| nfo.premiered.clone()))
        .unwrap_or_default();

    let duration_seconds = data.duration.map(|value| value as i64).or(current.duration);
    let score = data.rating.or(current.rating).or_else(|| parsed_nfo.and_then(|nfo| nfo.rating));
    let actors = updated_actors
        .map(|values| values.to_vec())
        .unwrap_or_else(|| {
            if current.actors.is_empty() {
                parsed_nfo
                    .map(|nfo| nfo.actor_names.clone())
                    .unwrap_or_default()
            } else {
                current.actors.clone()
            }
        });
    let tags = updated_tags
        .map(|values| values.to_vec())
        .unwrap_or_else(|| {
            if current.tags.is_empty() {
                parsed_nfo
                    .map(|nfo| nfo.tag_names.clone())
                    .unwrap_or_default()
            } else {
                current.tags.clone()
            }
        });
    let genres = if current.genres.is_empty() {
        parsed_nfo
            .map(|nfo| nfo.genre_names.clone())
            .unwrap_or_default()
    } else {
        current.genres.clone()
    };

    crate::resource_scrape::types::ScrapeMetadata {
        title,
        local_id,
        original_title,
        plot: parsed_nfo
            .and_then(|nfo| nfo.plot.clone())
            .unwrap_or_default(),
        outline: parsed_nfo
            .and_then(|nfo| nfo.outline.clone())
            .unwrap_or_default(),
        original_plot: parsed_nfo
            .and_then(|nfo| nfo.original_plot.clone())
            .unwrap_or_default(),
        tagline: parsed_nfo
            .and_then(|nfo| nfo.tagline.clone())
            .unwrap_or_default(),
        studio,
        premiered,
        duration: seconds_to_minutes(duration_seconds),
        poster_url: parsed_nfo
            .and_then(|nfo| nfo.poster_url.clone())
            .or_else(|| parsed_nfo.and_then(|nfo| nfo.remote_cover_url.clone()))
            .unwrap_or_default(),
        cover_url: parsed_nfo
            .and_then(|nfo| nfo.remote_cover_url.clone())
            .or_else(|| parsed_nfo.and_then(|nfo| nfo.poster_url.clone()))
            .unwrap_or_default(),
        actors,
        director,
        score,
        critic_rating: parsed_nfo.and_then(|nfo| nfo.critic_rating),
        sort_title: parsed_nfo
            .and_then(|nfo| nfo.sort_title.clone())
            .unwrap_or_default(),
        mpaa: parsed_nfo
            .and_then(|nfo| nfo.mpaa.clone())
            .unwrap_or_default(),
        custom_rating: parsed_nfo
            .and_then(|nfo| nfo.custom_rating.clone())
            .unwrap_or_default(),
        country_code: parsed_nfo
            .and_then(|nfo| nfo.country_code.clone())
            .unwrap_or_default(),
        set_name: parsed_nfo
            .and_then(|nfo| nfo.set_name.clone())
            .unwrap_or_default(),
        maker: parsed_nfo
            .and_then(|nfo| nfo.maker.clone())
            .unwrap_or_else(|| current.studio.clone().unwrap_or_default()),
        publisher: parsed_nfo
            .and_then(|nfo| nfo.publisher.clone())
            .unwrap_or_default(),
        label: parsed_nfo
            .and_then(|nfo| nfo.label.clone())
            .unwrap_or_default(),
        tags,
        genres,
        thumbs: parsed_nfo
            .map(|nfo| nfo.thumb_urls.clone())
            .unwrap_or_default(),
    }
}

/// 确保视频在独立的同名目录中，并更新数据库。
/// 返回最终的 video_path（可能是原路径，也可能是迁移后的新路径）。
pub(crate) fn ensure_video_in_own_dir_with_db(app: &tauri::AppHandle, video_id: &str) -> Result<String, String> {
    let db = Database::new(app).map_err(|e| e.to_string())?;
    let conn = db.get_connection().map_err(|e| e.to_string())?;

    let (video_path, poster, thumb, fanart): (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT video_path, poster, thumb, fanart FROM videos WHERE id = ?",
            [video_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| format!("未找到视频: {}", e))?;

    let relocated = crate::media::assets::ensure_video_in_named_parent_dir(
        &video_path,
        poster.as_deref(),
        thumb.as_deref(),
        fanart.as_deref(),
    )?;

    if let Some(relocated) = relocated {
        Database::update_video_file_location(
            &conn,
            video_id,
            &relocated.original_video_path,
            &relocated.video_path,
            &relocated.dir_path,
            relocated.poster.as_deref(),
            relocated.thumb.as_deref(),
            relocated.fanart.as_deref(),
        )
        .map_err(|e| e.to_string())?;

        log::info!(
            "[video_directory] event=normalized_to_named_parent video_id={} original_video_path={} video_path={} dir_path={}",
            video_id,
            relocated.original_video_path,
            relocated.video_path,
            relocated.dir_path
        );

        Ok(relocated.video_path)
    } else {
        Ok(video_path)
    }
}

// 查找广告视频
#[derive(serde::Serialize)]
pub struct AdVideo {
    pub id: String,
    pub path: String,
    pub filename: String,
    pub file_size: i64,
    pub reason: String,
}

#[cfg(test)]
mod tests {
    use super::{
        build_nfo_metadata_for_update, has_same_named_parent_dir, is_matching_subtitle_file,
        parse_name_list, VideoUpdateContext, VideoUpdatePayload,
    };
    use std::path::Path;

    #[test]
    fn detects_same_named_parent_dir() {
        assert!(has_same_named_parent_dir(Path::new("D:/videos/ABC-123/ABC-123.mp4")));
    }

    #[test]
    fn ignores_different_named_parent_dir() {
        assert!(!has_same_named_parent_dir(Path::new("D:/videos/collection/ABC-123.mp4")));
    }

    #[test]
    fn matches_prefixed_subtitle_file() {
        let video = Path::new("D:/videos/DLDSS-385-C-cd3.mp4");
        let subtitle = Path::new("D:/videos/DLDSS-385-C-cd3.chs.srt");
        assert!(is_matching_subtitle_file(video, subtitle));
    }

    #[test]
    fn matches_multiple_subtitle_formats_only_in_same_dir() {
        let video = Path::new("D:/videos/DLDSS-385-C-cd3.mp4");
        assert!(is_matching_subtitle_file(
            video,
            Path::new("D:/videos/DLDSS-385-C-cd3.ass")
        ));
        assert!(is_matching_subtitle_file(
            video,
            Path::new("D:/videos/DLDSS-385-C-cd3.sc.ass")
        ));
        assert!(!is_matching_subtitle_file(
            video,
            Path::new("D:/other/DLDSS-385-C-cd3.chs.srt")
        ));
        assert!(!is_matching_subtitle_file(
            video,
            Path::new("D:/videos/OTHER-DLDSS-385-C-cd3.chs.srt")
        ));
    }

    #[test]
    fn matches_loose_language_and_subtitle_suffix_patterns() {
        let video = Path::new("D:/videos/FSDSS-497-C-cd3.mp4");
        assert!(is_matching_subtitle_file(
            video,
            Path::new("D:/videos/FSDSS-497-C-cd3-eng.srt")
        ));
        assert!(is_matching_subtitle_file(
            video,
            Path::new("D:/videos/FSDSS-497-C-cd3_jpn.ass")
        ));
        assert!(is_matching_subtitle_file(
            video,
            Path::new("D:/videos/FSDSS-497-C-cd3 [chs][forced].vtt")
        ));
        assert!(is_matching_subtitle_file(
            video,
            Path::new("D:/videos/FSDSS-497-C-cd3.zh-Hans.default.sup")
        ));
        assert!(!is_matching_subtitle_file(
            video,
            Path::new("D:/videos/FSDSS-497-C-cd31.srt")
        ));
    }

    fn create_video_update_context() -> VideoUpdateContext {
        VideoUpdateContext {
            title: "原始标题".to_string(),
            original_title: Some("Original Title".to_string()),
            local_id: None,
            studio: Some("旧片商".to_string()),
            director: Some("旧导演".to_string()),
            premiered: Some("2024-01-01".to_string()),
            duration: Some(3600),
            rating: Some(7.5),
            video_path: "D:/videos/sample.mp4".to_string(),
            dir_path: Some("D:/videos".to_string()),
            poster: None,
            thumb: None,
            fanart: None,
            actors: vec!["旧演员".to_string()],
            tags: vec!["旧标签".to_string()],
            genres: vec!["旧类型".to_string()],
        }
    }

    #[test]
    fn parse_name_list_should_split_and_trim_names() {
        assert_eq!(
            parse_name_list("Alice, Bob， Carol ,, "),
            vec!["Alice".to_string(), "Bob".to_string(), "Carol".to_string()]
        );
    }

    #[test]
    fn build_nfo_metadata_for_update_should_prefer_latest_actor_and_tag_values() {
        let current = create_video_update_context();
        let data = VideoUpdatePayload {
            title: Some("新标题".to_string()),
            local_id: Some("".to_string()),
            studio: Some("新片商".to_string()),
            director: Some("新导演".to_string()),
            actors: Some("演员A, 演员B".to_string()),
            rating: Some(8.8),
            duration: Some(5400.0),
            premiered: Some("2025-02-03".to_string()),
            tags: Some("标签A, 标签B".to_string()),
            resolution: None,
        };
        let updated_actors = parse_name_list(data.actors.as_deref().unwrap_or_default());
        let updated_tags = parse_name_list(data.tags.as_deref().unwrap_or_default());

        let metadata = build_nfo_metadata_for_update(
            &current,
            &data,
            None,
            Some(updated_actors.as_slice()),
            Some(updated_tags.as_slice()),
        );

        assert_eq!(metadata.title, "新标题");
        assert_eq!(metadata.local_id, "");
        assert_eq!(metadata.studio, "新片商");
        assert_eq!(metadata.director, "新导演");
        assert_eq!(metadata.premiered, "2025-02-03");
        assert_eq!(metadata.duration, Some(90));
        assert_eq!(metadata.score, Some(8.8));
        assert_eq!(metadata.actors, vec!["演员A".to_string(), "演员B".to_string()]);
        assert_eq!(metadata.tags, vec!["标签A".to_string(), "标签B".to_string()]);
        assert_eq!(metadata.genres, vec!["旧类型".to_string()]);
    }

    #[test]
    fn build_nfo_metadata_for_update_should_fallback_to_existing_values() {
        let current = create_video_update_context();
        let data = VideoUpdatePayload {
            title: None,
            local_id: None,
            studio: None,
            director: None,
            actors: None,
            rating: None,
            duration: None,
            premiered: None,
            tags: None,
            resolution: None,
        };

        let metadata = build_nfo_metadata_for_update(&current, &data, None, None, None);

        assert_eq!(metadata.title, "原始标题");
        assert_eq!(metadata.local_id, "");
        assert_eq!(metadata.actors, vec!["旧演员".to_string()]);
        assert_eq!(metadata.tags, vec!["旧标签".to_string()]);
    }
}
