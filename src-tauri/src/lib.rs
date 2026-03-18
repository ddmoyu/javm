// Tauri 命令入口 - https://tauri.app/develop/calling-rust/
mod db;
mod deep_link;
mod metadata;
mod settings;
mod analytics;

// 功能模块
pub mod download;
pub mod nfo;
pub mod resource_scrape;
pub mod scanner;
pub mod utils;

use db::Database;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::UpdaterExt;

use tokio::sync::Mutex;
use url::Url;
use utils::system_commands;

/// 视频截图任务的取消令牌管理
struct CaptureState {
    cancel_token: Mutex<Option<tokio_util::sync::CancellationToken>>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateInfo {
    configured: bool,
    available: bool,
    current_version: String,
    version: Option<String>,
    body: Option<String>,
    date: Option<String>,
    target: Option<String>,
}

const UPDATER_NOT_CONFIGURED: &str = "UPDATER_NOT_CONFIGURED";

fn updater_endpoint() -> Option<&'static str> {
    option_env!("JAVM_UPDATER_ENDPOINT").and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn updater_pubkey() -> Option<&'static str> {
    option_env!("JAVM_UPDATER_PUBKEY").and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn build_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let endpoint = updater_endpoint().ok_or_else(|| "当前构建未配置更新地址".to_string())?;
    let pubkey = updater_pubkey().ok_or_else(|| "当前构建未配置更新公钥".to_string())?;
    let endpoint = Url::parse(endpoint).map_err(|e| format!("解析更新地址失败: {e}"))?;

    app.updater_builder()
        .pubkey(pubkey)
        .endpoints(vec![endpoint])
        .map_err(|e| format!("配置更新地址失败: {e}"))?
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("初始化更新器失败: {e}"))
}

#[tauri::command]
async fn check_app_update(app: AppHandle) -> Result<AppUpdateInfo, String> {
    let current_version = app.package_info().version.to_string();

    if updater_endpoint().is_none() || updater_pubkey().is_none() {
        return Err(UPDATER_NOT_CONFIGURED.to_string());
    }

    let updater = build_updater(&app)?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("检查更新失败: {e}"))?;

    if let Some(update) = update {
        Ok(AppUpdateInfo {
            configured: true,
            available: true,
            current_version: update.current_version,
            version: Some(update.version),
            body: update.body,
            date: update.date.map(|date| date.to_string()),
            target: Some(update.target),
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
async fn install_app_update(app: AppHandle) -> Result<String, String> {
    let updater = build_updater(&app)?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("检查更新失败: {e}"))?
        .ok_or_else(|| "当前没有可用更新".to_string())?;

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("安装更新失败: {e}"))?;

    #[cfg(target_os = "windows")]
    {
        Ok("更新安装程序已启动，应用会自动退出完成安装。".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok("更新已安装，请重启应用以完成切换。".to_string())
    }
}

#[tauri::command]
fn parse_deep_link(url: String) -> Result<deep_link::ParsedDeepLink, String> {
    deep_link::parse_url(&url)
}

#[tauri::command]
fn get_runtime_system_info() -> serde_json::Value {
    serde_json::json!({
        "os": std::env::consts::OS,
        "cpuArch": std::env::consts::ARCH,
    })
}

#[tauri::command]
async fn get_videos(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let db = Database::new(&app);
    let conn = db.get_connection().map_err(|e| e.to_string())?;

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
            v.fast_hash
        FROM videos v
        ORDER BY v.created_at DESC
    "#;

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;

    let video_iter = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "title": row.get::<_, Option<String>>(1)?,
                "videoPath": row.get::<_, String>(2)?,
                "studio": row.get::<_, Option<String>>(3)?,
                "premiered": row.get::<_, Option<String>>(4)?,
                "rating": row.get::<_, Option<f64>>(5)?.unwrap_or(0.0),
                "duration": row.get::<_, Option<i64>>(6)?.unwrap_or(0),
                "createdAt": row.get::<_, String>(7)?,
                "scanStatus": row.get::<_, i32>(8)?,
                "director": row.get::<_, Option<String>>(9)?,
                "localId": row.get::<_, Option<String>>(10)?,
                "poster": row.get::<_, Option<String>>(11)?,
                "thumb": row.get::<_, Option<String>>(12)?,
                "fanart": row.get::<_, Option<String>>(13)?,
                "originalTitle": row.get::<_, Option<String>>(14)?,
                "actors": row.get::<_, Option<String>>(15)?,
                "resolution": row.get::<_, Option<String>>(16)?,
                "fileSize": row.get::<_, Option<i64>>(17)?,
                "tags": row.get::<_, Option<String>>(18)?,
                "genres": row.get::<_, Option<String>>(19)?,
                "fastHash": row.get::<_, Option<String>>(20)?,
            }))
        })
        .map_err(|e| e.to_string())?;

    let mut videos = Vec::new();
    for video in video_iter {
        videos.push(video.map_err(|e| e.to_string())?);
    }

    Ok(videos)
}

#[tauri::command]
async fn get_directories(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let db = Database::new(&app);
    let conn = db.get_connection().map_err(|e| e.to_string())?;

    // 确保 directories 表存在
    conn.execute(
        "CREATE TABLE IF NOT EXISTS directories (
            id TEXT PRIMARY KEY,
            path TEXT UNIQUE NOT NULL,
            video_count INTEGER DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )
    .map_err(|e| format!("创建 directories 表失败: {}", e))?;

    let mut stmt = conn
        .prepare("SELECT id, path, video_count, created_at, updated_at FROM directories ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
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
        })
        .map_err(|e| e.to_string())?;

    let mut dirs = Vec::new();
    for r in rows {
        dirs.push(r.map_err(|e| e.to_string())?);
    }
    Ok(dirs)
}

#[tauri::command]
async fn add_directory(app: AppHandle, path: String) -> Result<String, String> {
    use std::path::Path;
    use uuid::Uuid;

    if crate::scanner::file_scanner::is_skipped_directory(Path::new(&path)) {
        return Err("该目录已被系统忽略，不能添加：behind the scenes / backdrops".to_string());
    }

    let db = Database::new(&app);
    let conn = db.get_connection().map_err(|e| e.to_string())?;

    // 检查路径是否已存在
    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM directories WHERE path = ?",
            [&path],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    if exists {
        return Err("目录已存在".to_string());
    }

    // 生成 UUID 作为 ID
    let id = Uuid::new_v4().to_string();

    // 插入目录记录
    conn.execute(
        "INSERT INTO directories (id, path, video_count) VALUES (?, ?, 0)",
        rusqlite::params![&id, &path],
    )
    .map_err(|e| e.to_string())?;

    Ok(id)
}

#[tauri::command]

async fn get_duplicate_videos(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let db = Database::new(&app);
    let conn = db.get_connection().map_err(|e| e.to_string())?;

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
            v.scan_status
        FROM videos v
        WHERE (v.fast_hash IS NOT NULL AND v.fast_hash != '' AND v.fast_hash IN (
            SELECT fast_hash FROM videos WHERE fast_hash IS NOT NULL AND fast_hash != '' GROUP BY fast_hash HAVING COUNT(*) > 1
        ))
        OR (v.local_id IS NOT NULL AND v.local_id != '' AND v.local_id IN (
            SELECT local_id FROM videos WHERE local_id IS NOT NULL AND local_id != '' GROUP BY local_id HAVING COUNT(*) > 1
        ))
        ORDER BY v.local_id, v.fast_hash, v.created_at DESC
    "#;

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
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
            }))
        })
        .map_err(|e| e.to_string())?;

    let mut videos = Vec::new();
    for video in video_iter {
        videos.push(video.map_err(|e| e.to_string())?);
    }

    Ok(videos)
}

#[tauri::command]
async fn delete_video_db(app: AppHandle, id: String) -> Result<(), String> {
    let db = Database::new(&app);
    let conn = db.get_connection().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM videos WHERE id = ?", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn delete_directory(app: AppHandle, id: String) -> Result<(), String> {
    use std::path::Path;

    let db = Database::new(&app);
    let conn = db.get_connection().map_err(|e| e.to_string())?;

    // 获取目录路径
    let path: String = conn
        .query_row("SELECT path FROM directories WHERE id = ?", [&id], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;

    // 规范化路径，确保使用统一的分隔符
    let normalized_path = Path::new(&path).to_string_lossy().replace('\\', "/");

    // 删除该目录及其所有子目录下的视频
    // 使用 LIKE 匹配路径前缀，需要确保路径末尾有分隔符
    let path_pattern = if normalized_path.ends_with('/') {
        format!("{}%", normalized_path)
    } else {
        format!("{}/%", normalized_path)
    };

    // 同时匹配原始路径和规范化路径
    conn.execute(
        "DELETE FROM videos WHERE
            dir_path = ? OR
            dir_path = ? OR
            REPLACE(dir_path, '\\', '/') LIKE ? OR
            REPLACE(dir_path, '\\', '/') = ?",
        rusqlite::params![&path, &normalized_path, &path_pattern, &normalized_path],
    )
    .map_err(|e| e.to_string())?;

    // 删除目录记录
    conn.execute("DELETE FROM directories WHERE id = ?", [&id])
        .map_err(|e| e.to_string())?;

    Ok(())
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
fn delete_video_and_files(conn: &rusqlite::Connection, id: &str) -> Result<(), String> {
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
        delete_if_exists(&path_obj.with_extension("nfo"));
        delete_matching_subtitle_files(path_obj);

        // 删除本地封面图
        for image_path in [poster, thumb, fanart].into_iter().flatten() {
            delete_if_exists(Path::new(&image_path));
        }

        // 删除 extrafanart 目录
        if let Ok(extrafanart_dir) = crate::utils::media_assets::extrafanart_dir_for_video(path_obj) {
            if extrafanart_dir.exists() && extrafanart_dir.is_dir() {
                let _ = fs::remove_dir_all(&extrafanart_dir);
            }
        }
    }

    // 删除数据库记录
    conn.execute("DELETE FROM videos WHERE id = ?", [id])
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{has_same_named_parent_dir, is_matching_subtitle_file};
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
}

fn update_all_directories_count(conn: &rusqlite::Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT path FROM directories")
        .map_err(|e| e.to_string())?;
    let paths: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    for path in paths {
        let normalized_path = std::path::Path::new(&path)
            .to_string_lossy()
            .replace('\\', "/");

        let path_pattern = if normalized_path.ends_with('/') {
            format!("{}%", normalized_path)
        } else {
            format!("{}/%", normalized_path)
        };

        let video_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM videos WHERE
                    dir_path = ? OR
                    dir_path = ? OR
                    REPLACE(dir_path, '\\', '/') LIKE ? OR
                    REPLACE(dir_path, '\\', '/') = ?",
                rusqlite::params![&path, &normalized_path, &path_pattern, &normalized_path],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let _ = conn.execute(
            "UPDATE directories SET video_count = ?, updated_at = CURRENT_TIMESTAMP WHERE path = ?",
            rusqlite::params![video_count, &path],
        );
    }
    Ok(())
}

#[tauri::command]
async fn delete_video_file(app: AppHandle, id: String) -> Result<(), String> {
    let db = Database::new(&app);
    let conn = db.get_connection().map_err(|e| e.to_string())?;
    delete_video_and_files(&conn, &id)?;
    let _ = update_all_directories_count(&conn);
    Ok(())
}

/// 递归复制目录（跨盘移动时 rename 会失败，需要 copy + delete）
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
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
fn move_file(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    match std::fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::copy(src, dst)?;
            std::fs::remove_file(src)?;
            Ok(())
        }
    }
}

#[tauri::command]

async fn move_video_file(app: AppHandle, id: String, target_dir: String) -> Result<(), String> {
    use std::fs;
    use std::path::Path;

    let db = Database::new(&app);
    let conn = db.get_connection().map_err(|e| e.to_string())?;

    // 查询视频路径和同级图路径
    let (current_path, poster, thumb, fanart): (String, Option<String>, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT video_path, poster, thumb, fanart FROM videos WHERE id = ?",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| e.to_string())?;

    let current_path_obj = Path::new(&current_path);
    if !current_path_obj.exists() {
        return Err("源视频文件不存在".to_string());
    }

    let file_name = current_path_obj.file_name().ok_or("无效的文件名")?;
    let new_path_obj = Path::new(&target_dir).join(file_name);

    if new_path_obj.exists() {
        return Err("目标目录已存在同名文件".to_string());
    }

    // 1. 移动视频文件
    move_file(current_path_obj, &new_path_obj).map_err(|e| format!("移动视频失败: {}", e))?;

    // 2. 移动 NFO 文件
    let current_nfo = current_path_obj.with_extension("nfo");
    if current_nfo.exists() {
        let new_nfo = new_path_obj.with_extension("nfo");
        let _ = move_file(&current_nfo, &new_nfo);
    }

    // 3. 移动同级图片资源
    let move_artwork = |path_opt: Option<String>, label: &str| -> Result<Option<String>, String> {
        if let Some(path) = path_opt {
            let source = Path::new(&path);
            if source.exists() {
                let file_name = source.file_name().ok_or_else(|| format!("无效的{}文件名", label))?;
                let target = Path::new(&target_dir).join(file_name);
                move_file(source, &target).map_err(|e| format!("移动{}失败: {}", label, e))?;
                return Ok(Some(target.to_string_lossy().to_string()));
            }
        }
        Ok(None)
    };
    let new_poster = move_artwork(poster.clone(), "poster")?;
    let new_thumb = move_artwork(thumb.clone(), "thumb")?;
    let new_fanart = move_artwork(fanart.clone(), "fanart")?;

    // 4. 移动 extrafanart 目录
    let old_parent = current_path_obj.parent().ok_or("无效的源路径")?;
    let extrafanart_dir = old_parent.join("extrafanart");
    if extrafanart_dir.exists() && extrafanart_dir.is_dir() {
        let target_extrafanart_dir = Path::new(&target_dir).join("extrafanart");
        copy_dir_recursive(&extrafanart_dir, &target_extrafanart_dir)
            .map_err(|e| format!("移动 extrafanart 目录失败: {}", e))?;
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
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoUpdatePayload {
    title: Option<String>,
    local_id: Option<String>,
    studio: Option<String>,
    director: Option<String>,
    rating: Option<f64>,
    duration: Option<f64>,
    premiered: Option<String>,
    tags: Option<String>,
    resolution: Option<String>,
}

#[tauri::command]
async fn update_video(app: AppHandle, id: String, data: VideoUpdatePayload) -> Result<(), String> {
    let db = Database::new(&app);
    let conn = db.get_connection().map_err(|e| e.to_string())?;

    // 更新基本字段
    let mut sql_parts = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(v) = &data.title {
        sql_parts.push("title = ?");
        params.push(Box::new(v.clone()));
    }
    if let Some(v) = &data.local_id {
        sql_parts.push("local_id = ?");
        params.push(Box::new(v.clone()));
    }
    if let Some(v) = &data.duration {
        sql_parts.push("duration = ?");
        params.push(Box::new(v.clone() as i64));
    }
    if let Some(v) = &data.premiered {
        sql_parts.push("premiered = ?");
        params.push(Box::new(v.clone()));
    }
    if let Some(v) = &data.rating {
        sql_parts.push("rating = ?");
        params.push(Box::new(v.clone()));
    }

    // 直接字符串字段（不再使用外键）
    if let Some(v) = &data.studio {
        sql_parts.push("studio = ?");
        params.push(Box::new(v.clone()));
    }
    if let Some(v) = &data.director {
        sql_parts.push("director = ?");
        params.push(Box::new(v.clone()));
    }
    if let Some(v) = &data.resolution {
        sql_parts.push("resolution = ?");
        params.push(Box::new(v.clone()));
    }
    // maker 字段已不再使用

    sql_parts.push("updated_at = datetime('now')");

    if !sql_parts.is_empty() {
        let sql = format!("UPDATE videos SET {} WHERE id = ?", sql_parts.join(", "));
        params.push(Box::new(id.clone()));

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        stmt.execute(rusqlite::params_from_iter(params.iter()))
            .map_err(|e| e.to_string())?;
    }

    // 处理标签（如果提供）
    if let Some(tags_str) = &data.tags {
        let tags: Vec<String> = tags_str
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        // 删除已有标签
        conn.execute("DELETE FROM video_tags WHERE video_id = ?", [&id])
            .map_err(|e| e.to_string())?;

        // 插入新标签
        for tag_name in tags.iter() {
            let tag_id = Database::get_or_create_tag(&conn, tag_name).map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)",
                rusqlite::params![&id, tag_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[tauri::command]
async fn open_in_explorer(path: String) -> Result<(), String> {
    system_commands::open_in_explorer(path).await
}

#[tauri::command]
async fn open_with_player(app: AppHandle, path: String) -> Result<(), String> {
    system_commands::open_with_player(path).await?;
    analytics::record_play_video(&app);
    Ok(())
}

#[tauri::command]
async fn open_video_player_window(
    app: AppHandle,
    video_url: String,
    title: String,
    is_hls: bool,
) -> Result<(), String> {
    system_commands::open_video_player_window(app.clone(), video_url, title, is_hls).await?;
    analytics::record_play_video(&app);
    Ok(())
}

#[tauri::command]
async fn proxy_hls_request(
    url: String,
    referer: Option<String>,
) -> Result<(String, String), String> {
    system_commands::proxy_hls_request(url, referer).await
}

#[tauri::command]
async fn capture_video_frames(
    app: AppHandle,
    state: State<'_, CaptureState>,
    video_path: String,
    count: usize,
) -> Result<Vec<String>, String> {
    // 取消之前可能还在运行的截图任务
    {
        let mut token_guard = state.cancel_token.lock().await;
        if let Some(old_token) = token_guard.take() {
            old_token.cancel();
        }
        // 创建新的取消令牌
        let new_token = tokio_util::sync::CancellationToken::new();
        *token_guard = Some(new_token);
    }

    // 获取当前令牌的克隆
    let token = {
        let token_guard = state.cancel_token.lock().await;
        token_guard.as_ref().unwrap().clone()
    };

    // 使用流式截图：每成功一帧就通过事件推送给前端
    let result =
        utils::ffmpeg::capture_random_frames_streaming(&app, &video_path, count, token).await;

    result
}

#[tauri::command]
async fn cancel_capture(state: State<'_, CaptureState>) -> Result<(), String> {
    let mut token_guard = state.cancel_token.lock().await;
    if let Some(token) = token_guard.take() {
        token.cancel();
    }
    Ok(())
}

/// 删除封面：删除本地文件 + 清空数据库中的封面字段
#[tauri::command]
async fn delete_cover(app: AppHandle, video_id: String) -> Result<(), String> {
    let db = Database::new(&app);
    let conn = db.get_connection().map_err(|e| e.to_string())?;

    // 查询当前封面路径
    let (poster, thumb): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT poster, thumb FROM videos WHERE id = ?",
            [&video_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;

    // 删除本地封面文件
    if let Some(ref path) = poster {
        let p = std::path::Path::new(path);
        if p.exists() {
            std::fs::remove_file(p).map_err(|e| e.to_string())?;
        }
    }

    if let Some(ref path) = thumb {
        if poster.as_deref() != Some(path.as_str()) {
            let p = std::path::Path::new(path);
            if p.exists() {
                std::fs::remove_file(p).map_err(|e| e.to_string())?;
            }
        }
    }

    // 清空数据库中的封面字段
    conn.execute(
        "UPDATE videos SET poster = NULL, thumb = NULL, updated_at = datetime('now') WHERE id = ?",
        rusqlite::params![&video_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn save_captured_cover(
    app: AppHandle,
    video_id: String,
    video_path: String,
    frame_path: String,
) -> Result<String, String> {
    // 保存帧作为封面资源（poster + thumb）
    let (poster_path, thumb_path) =
        utils::media_assets::save_frame_as_cover_assets(&video_path, &frame_path)?;

    // 更新数据库
    let db = Database::new(&app);
    let conn = db.get_connection().map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE videos SET poster = ?, thumb = ?, updated_at = datetime('now') WHERE id = ?",
        rusqlite::params![&poster_path, &thumb_path, &video_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(thumb_path)
}

#[tauri::command]
async fn save_captured_thumbs(
    _app: AppHandle,
    _video_id: String,
    video_path: String,
    frame_paths: Vec<String>,
) -> Result<Vec<String>, String> {
    // 保存多个帧作为预览图
    let thumb_paths =
        utils::media_assets::save_frames_to_extrafanart(&video_path, &frame_paths)?;

    Ok(thumb_paths)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoPreviewImageSource {
    src: String,
    local_path: Option<String>,
    remote_url: Option<String>,
}

#[tauri::command]
async fn resolve_video_preview_images(video_path: String) -> Result<Vec<VideoPreviewImageSource>, String> {
    use std::collections::{BTreeMap, HashSet};
    use std::path::Path;

    if video_path.trim().is_empty() {
        return Ok(Vec::new());
    }

    let video_path_obj = Path::new(&video_path);
    let mut duration = None;
    let nfo_path = video_path_obj.with_extension("nfo");
    let remote_thumb_urls = if nfo_path.exists() {
        crate::nfo::parser::parse_nfo(&nfo_path, &mut duration)
            .map(|data| data.thumb_urls)
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let extrafanart_map = crate::utils::media_assets::collect_extrafanart_paths(video_path_obj)
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
        let background_video_path = video_path.clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::utils::media_assets::sync_extrafanart_from_urls(
                &background_video_path,
                missing_remote_images,
            )
            .await;
        });
    }

    Ok(items)
}

/// 删除单个预览图文件
#[tauri::command]
async fn delete_thumb(
    _app: AppHandle,
    _video_id: String,
    thumb_path: String,
) -> Result<(), String> {
    // 删除本地截图文件
    let p = std::path::Path::new(&thumb_path);
    if p.exists() {
        std::fs::remove_file(p).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
async fn clear_thumbs(
    _app: AppHandle,
    _video_id: String,
    video_path: String,
) -> Result<(), String> {
    // 删除 extrafanart 中的预览图文件
    let video_path_obj = std::path::Path::new(&video_path);
    let extrafanart_dir = crate::utils::media_assets::extrafanart_dir_for_video(video_path_obj)?;

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
}

// 查找广告视频
#[derive(serde::Serialize)]
struct AdVideo {
    id: String,
    path: String,
    filename: String,
    file_size: i64,
    reason: String,
}

#[tauri::command]
async fn find_ad_videos(
    app: AppHandle,
    keywords: Option<Vec<String>>,
    check_duplicate: Option<bool>,
    exclude_keywords: Option<Vec<String>>,
) -> Result<Vec<AdVideo>, String> {
    use std::collections::HashMap;

    let check_duplicate = check_duplicate.unwrap_or(true);

    // 如果没有传入关键词，从设置中读取
    let settings = settings::get_settings(app.clone()).await?;
    let keywords = keywords.unwrap_or(settings.ad_filter.keywords);
    let exclude_keywords = exclude_keywords.unwrap_or(settings.ad_filter.exclude_keywords);

    println!(
        "[find_ad_videos] 开始查找广告视频，关键词: {:?}, 排除关键词: {:?}, 检查重复: {}",
        keywords, exclude_keywords, check_duplicate
    );

    let db = Database::new(&app);
    let conn = db.get_connection().map_err(|e| e.to_string())?;

    let mut ad_videos = Vec::new();

    // 第一步：查询所有视频（移除 50MB 限制）
    let mut stmt = conn
        .prepare("SELECT id, video_path, file_size FROM videos")
        .map_err(|e| e.to_string())?;

    let all_videos = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut video_list = Vec::new();
    for video in all_videos {
        let (id, path, size) = video.map_err(|e| e.to_string())?;
        video_list.push((id, path, size));
    }

    println!("[find_ad_videos] 找到 {} 个视频", video_list.len());

    // 第二步：统计文件名出现次数（在所有视频中统计）
    let mut filename_count: HashMap<String, Vec<String>> = HashMap::new();
    for (_, path, _) in &video_list {
        if let Some(filename) = std::path::Path::new(path).file_name() {
            let filename_str = filename.to_string_lossy().to_string();
            filename_count
                .entry(filename_str.clone())
                .or_insert_with(Vec::new)
                .push(path.clone());
        }
    }

    // 第三步：检查每个视频
    for (id, path, size) in video_list {
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

            // 规则3: 关键词过滤
            for keyword in &keywords {
                if filename.to_lowercase().contains(&keyword.to_lowercase()) {
                    reasons.push(format!("包含关键词: {}", keyword));
                    break;
                }
            }
        }

        // 如果有任何匹配的原因，添加到结果
        // 但如果文件名包含排除关键词，则跳过
        if !reasons.is_empty() {
            let filename_lower = filename.to_lowercase();
            let excluded = exclude_keywords
                .iter()
                .any(|ek| filename_lower.contains(&ek.to_lowercase()));
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

    println!("[find_ad_videos] 找到 {} 个疑似广告视频", ad_videos.len());
    Ok(ad_videos)
}

/// 下载远程图片到 extrafanart 目录
#[tauri::command]
async fn download_remote_image(
    _app: AppHandle,
    _video_id: String,
    video_path: String,
    url: String,
) -> Result<String, String> {
    let video_path_obj = std::path::Path::new(&video_path);
    let save_dir = crate::utils::media_assets::extrafanart_dir_for_video(video_path_obj)?;
    std::fs::create_dir_all(&save_dir).map_err(|e| format!("创建目录失败: {}", e))?;

    let next_index = crate::utils::media_assets::next_extrafanart_index(video_path_obj);
    let save_path = save_dir.join(format!("fanart{}.jpg", next_index));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .use_rustls_tls()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let resp = client
        .get(&url)
        .header(
            "Accept",
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        )
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .header("Referer", "https://memojav.com/")
        .send()
        .await
        .map_err(|e| format!("下载失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("下载失败，HTTP 状态码: {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取数据失败: {}", e))?;
    if bytes.is_empty() {
        return Err("下载的数据为空".to_string());
    }

    std::fs::write(&save_path, &bytes).map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(save_path.to_string_lossy().to_string())
}

// 批量删除视频（复用 delete_video_and_files）
#[tauri::command]
async fn delete_videos(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let db = Database::new(&app);
    let conn = db.get_connection().map_err(|e| e.to_string())?;

    for id in ids {
        if let Err(e) = delete_video_and_files(&conn, &id) {
            eprintln!("删除视频 {} 失败: {}", id, e);
        }
    }

    let _ = update_all_directories_count(&conn);

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    
    // 在桌面平台上配置 single instance 插件（必须是第一个注册的插件）
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 显示主窗口
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }

            println!("[单实例] 新实例参数: {argv:?}");
        }));

        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_localhost::Builder::new(1421).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let db = Database::new(app.handle());
            db.init().expect("数据库初始化失败");

            // 注册深度链接处理器
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;

                // Windows 开发态与 Linux 下，运行时注册静态配置的协议，便于本地测试深链。
                #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
                {
                    app.deep_link().register_all()?;
                }
            }

            // --- 恢复主窗口位置与尺寸 ---
            if let Some(main_window) = app.handle().get_webview_window("main") {
                // 设置窗口图标（任务栏 + 标题栏）
                if let Some(icon) = app.default_window_icon() {
                    let _ = main_window.set_icon(icon.clone());
                }

                let app_handle = app.handle().clone();
                match tauri::async_runtime::block_on(crate::settings::get_settings(app_handle)) {
                    Ok(settings) => {
                        let vp_settings = settings.main_window;

                        // 设置最小窗口尺寸
                        let _ = main_window.set_min_size(Some(tauri::LogicalSize::new(1080.0, 720.0)));

                        if let (Some(w), Some(h)) = (vp_settings.width, vp_settings.height) {
                            // 确保恢复的尺寸不小于最小值
                            let width = w.max(1080.0);
                            let height = h.max(720.0);
                            let _ = main_window.set_size(tauri::LogicalSize::new(width, height));
                        }

                        if let (Some(x), Some(y)) = (vp_settings.x, vp_settings.y) {
                            let mut is_visible = false;
                            if let Ok(monitors) = main_window.available_monitors() {
                                for m in monitors {
                                    let pos = m.position();
                                    let size = m.size();
                                    // x/y 是物理像素，monitor pos/size 也是物理像素，直接比较
                                    if (x as i32) < pos.x + size.width as i32 - 100
                                        && (x as i32) + 100 > pos.x
                                        && (y as i32) < pos.y + size.height as i32 - 100
                                        && (y as i32) + 100 > pos.y
                                    {
                                        is_visible = true;
                                        break;
                                    }
                                }
                            } else {
                                is_visible = true; // 获取失败则假定可见
                            }

                            if is_visible {
                                let _ = main_window
                                    .set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
                            } else {
                                let _ = main_window.center();
                            }
                        }
                    }
                    Err(e) => {
                        println!("应用设置到主窗口失败: {}", e);
                    }
                }
            }
            // -----------------------------

            // 初始化截图取消令牌管理
            app.manage(CaptureState {
                cancel_token: Mutex::new(None),
            });

            // 初始化下载管理器
            let download_manager = download::manager::DownloadManager::new(3); // 最多 3 个并发下载
            app.manage(download_manager);

            // 初始化资源刮削任务队列状态
            let rs_task_queue_state = resource_scrape::commands::RsTaskQueueState::new();
            app.manage(rs_task_queue_state);
            println!("资源刮削任务队列状态已初始化");

            // 初始化批量截图封面状态
            let cover_capture_state = resource_scrape::commands::CoverCaptureState::new();
            app.manage(cover_capture_state);
            println!("批量截图封面状态已初始化");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            parse_deep_link,
            scanner::commands::scan_directory,
            get_videos,
            get_directories,
            add_directory,
            get_duplicate_videos,
            delete_directory,
            delete_video_db,
            delete_video_file,
            move_video_file,
            update_video,
            open_in_explorer,
            open_with_player,
            open_video_player_window,
            proxy_hls_request,
            capture_video_frames,
            cancel_capture,
            save_captured_cover,
            delete_cover,
            save_captured_thumbs,
            resolve_video_preview_images,
            clear_thumbs,
            delete_thumb,
            settings::get_settings,
            settings::save_settings,
            settings::test_ai_api,
            settings::recognize_designation_with_ai,
            get_runtime_system_info,
            check_app_update,
            install_app_update,
            analytics::analytics_init,
            analytics::analytics_add_active_seconds,
            analytics::analytics_sync_now,
            analytics::analytics_debug_supabase_config,
            download::commands::get_download_tasks,
            download::commands::add_download_task,
            download::commands::pause_download_task,
            download::commands::resume_download_task,
            download::commands::cancel_download_task,
            download::commands::stop_download_task,
            download::commands::retry_download_task,
            download::commands::delete_download_task,
            download::commands::rename_download_task,
            download::commands::change_download_save_path,
            download::commands::get_default_download_path,
            download::commands::batch_pause_tasks,
            download::commands::batch_resume_tasks,
            download::commands::batch_stop_tasks,
            download::commands::batch_retry_tasks,
            download::commands::batch_delete_tasks,
            find_ad_videos,
            delete_videos,
            download_remote_image,
            // 资源刮削模块命令
            resource_scrape::commands::rs_search_resource,
            resource_scrape::commands::rs_proxy_image,
            resource_scrape::commands::get_resource_sites,
            resource_scrape::commands::rs_scrape_save,
            resource_scrape::commands::rs_get_scrape_tasks,
            resource_scrape::commands::rs_create_filtered_scrape_tasks,
            resource_scrape::commands::rs_start_task_queue,
            resource_scrape::commands::rs_stop_task_queue,
            resource_scrape::commands::rs_stop_scrape_task,
            resource_scrape::commands::rs_reset_scrape_task,
            resource_scrape::commands::rs_delete_scrape_task,
            resource_scrape::commands::rs_delete_completed_scrape_tasks,
            resource_scrape::commands::rs_delete_failed_scrape_tasks,
            resource_scrape::commands::rs_delete_all_scrape_tasks,
            resource_scrape::commands::rs_check_video_completely_scraped,
            resource_scrape::commands::rs_find_video_links,
            resource_scrape::commands::rs_close_video_finder,
            resource_scrape::commands::rs_get_video_sites,
            resource_scrape::commands::rs_verify_hls,
            // 批量截图封面命令
            resource_scrape::commands::rs_get_cover_capture_tasks,
            resource_scrape::commands::rs_get_videos_without_cover,
            resource_scrape::commands::rs_batch_capture_covers,
            resource_scrape::commands::rs_stop_cover_capture,
            resource_scrape::commands::rs_create_cover_capture_tasks,
            resource_scrape::commands::rs_delete_completed_cover_tasks,
            resource_scrape::commands::rs_delete_failed_cover_tasks,
            resource_scrape::commands::rs_delete_all_cover_tasks,
            resource_scrape::commands::rs_delete_cover_task,
            resource_scrape::commands::rs_retry_cover_task,
            resource_scrape::commands::rs_check_video_exists_by_code,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// 测试已移至 utils::media_assets
