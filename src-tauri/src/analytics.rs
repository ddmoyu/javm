use crate::db::Database;
use chrono::Local;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const META_KEY_USER_ID: &str = "analytics_user_id";
const META_KEY_SYSTEM_LANGUAGE: &str = "analytics_system_language";
const META_KEY_LAST_ACTIVE_DATE: &str = "analytics_last_active_date";
const DEFAULT_SUPABASE_URL: &str = "https://qnozwngeewudjqjsqhrh.supabase.co";
const DEFAULT_SUPABASE_PUBLISHABLE_KEY: &str = "sb_publishable_W3QZzoUXwuoQT4RK3Lg1Ag_OklHhRme";

#[derive(Debug, Clone)]
struct SupabaseConfig {
    url: String,
    api_key: String,
    table: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupabaseConfigDebugInfo {
    found: bool,
    source: String,
    url_preview: Option<String>,
    key_length: Option<usize>,
    table: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct DailyStatPayload {
    user_id: String,
    stat_date: String,
    os: String,
    cpu_arch: String,
    system_language: String,
    app_version: String,
    play_video_count: i64,
    download_video_count: i64,
    app_launch_count: i64,
    active_duration_seconds: i64,
    search_designation_count: i64,
    search_resource_link_count: i64,
    download_video_failed_count: i64,
    #[serde(rename = "video_total_count")]
    current_video_total_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPayload {
    user_id: Option<String>,
    days: Vec<LegacyDay>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyDay {
    stat_date: String,
    os: Option<String>,
    cpu_arch: Option<String>,
    system_language: Option<String>,
    app_version: Option<String>,
    play_video_count: Option<i64>,
    download_video_count: Option<i64>,
    app_launch_count: Option<i64>,
    active_duration_seconds: Option<i64>,
    search_designation_count: Option<i64>,
    search_resource_link_count: Option<i64>,
    current_video_total_count: Option<i64>,
}

fn default_table() -> String {
    "app_daily_stats".to_string()
}

fn default_supabase_config() -> Option<SupabaseConfig> {
    let url = DEFAULT_SUPABASE_URL.trim().trim_end_matches('/').to_string();
    let api_key = DEFAULT_SUPABASE_PUBLISHABLE_KEY.trim().to_string();

    if url.is_empty() || api_key.is_empty() {
        return None;
    }

    Some(SupabaseConfig {
        url,
        api_key,
        table: default_table(),
    })
}

fn today_string() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn app_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn normalize_language(language: Option<&str>) -> String {
    language.unwrap_or_default().trim().to_string()
}

fn video_total_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM videos", [], |row| row.get(0))
        .unwrap_or(0)
}

fn ensure_tables(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS analytics_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS analytics_daily (
            user_id TEXT NOT NULL,
            stat_date TEXT NOT NULL,
            os TEXT NOT NULL,
            cpu_arch TEXT NOT NULL,
            system_language TEXT NOT NULL DEFAULT '',
            app_version TEXT NOT NULL,
            play_video_count INTEGER NOT NULL DEFAULT 0,
            download_video_count INTEGER NOT NULL DEFAULT 0,
            app_launch_count INTEGER NOT NULL DEFAULT 0,
            active_duration_seconds INTEGER NOT NULL DEFAULT 0,
            search_designation_count INTEGER NOT NULL DEFAULT 0,
            search_resource_link_count INTEGER NOT NULL DEFAULT 0,
            current_video_total_count INTEGER NOT NULL DEFAULT 0,
            needs_sync INTEGER NOT NULL DEFAULT 1,
            sent_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id)
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    migrate_analytics_daily_to_user_pk(conn)?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_analytics_daily_sync_date
         ON analytics_daily (user_id, needs_sync, stat_date)",
        [],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

fn has_user_primary_key(conn: &Connection) -> Result<bool, String> {
    conn.query_row(
        "SELECT CASE
            WHEN EXISTS(
                SELECT 1 FROM pragma_table_info('analytics_daily')
                WHERE name = 'user_id' AND pk = 1
            ) AND EXISTS(
                SELECT 1 FROM pragma_table_info('analytics_daily')
                WHERE name = 'stat_date' AND pk = 0
            ) THEN 1
            ELSE 0
        END",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(|v| v == 1)
    .map_err(|e| e.to_string())
}

fn migrate_analytics_daily_to_user_pk(conn: &Connection) -> Result<(), String> {
    if has_user_primary_key(conn)? {
        return Ok(());
    }

    conn.execute_batch(
        "BEGIN;
         CREATE TABLE analytics_daily_new (
             user_id TEXT NOT NULL PRIMARY KEY,
             stat_date TEXT NOT NULL,
             os TEXT NOT NULL,
             cpu_arch TEXT NOT NULL,
             system_language TEXT NOT NULL DEFAULT '',
             app_version TEXT NOT NULL,
             play_video_count INTEGER NOT NULL DEFAULT 0,
             download_video_count INTEGER NOT NULL DEFAULT 0,
             app_launch_count INTEGER NOT NULL DEFAULT 0,
             active_duration_seconds INTEGER NOT NULL DEFAULT 0,
             search_designation_count INTEGER NOT NULL DEFAULT 0,
             search_resource_link_count INTEGER NOT NULL DEFAULT 0,
             current_video_total_count INTEGER NOT NULL DEFAULT 0,
             needs_sync INTEGER NOT NULL DEFAULT 1,
             sent_at TEXT,
             created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
             updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         INSERT INTO analytics_daily_new (
             user_id, stat_date, os, cpu_arch, system_language, app_version,
             play_video_count, download_video_count, app_launch_count,
             active_duration_seconds, search_designation_count,
             search_resource_link_count, current_video_total_count,
             needs_sync, sent_at, created_at, updated_at
         )
         SELECT
             user_id,
             COALESCE(stat_date, strftime('%Y-%m-%d', 'now', 'localtime')) AS stat_date,
             MAX(os) AS os,
             MAX(cpu_arch) AS cpu_arch,
             MAX(system_language) AS system_language,
             MAX(app_version) AS app_version,
             SUM(play_video_count) AS play_video_count,
             SUM(download_video_count) AS download_video_count,
             SUM(app_launch_count) AS app_launch_count,
             SUM(active_duration_seconds) AS active_duration_seconds,
             SUM(search_designation_count) AS search_designation_count,
             SUM(search_resource_link_count) AS search_resource_link_count,
             MAX(current_video_total_count) AS current_video_total_count,
             MAX(needs_sync) AS needs_sync,
             MAX(sent_at) AS sent_at,
             MIN(created_at) AS created_at,
             MAX(updated_at) AS updated_at
         FROM analytics_daily
         GROUP BY user_id;
         DROP TABLE analytics_daily;
         ALTER TABLE analytics_daily_new RENAME TO analytics_daily;
         COMMIT;",
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO analytics_meta (key, value, updated_at)
         VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = datetime('now')",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn get_meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM analytics_meta WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

fn ensure_user_id(conn: &Connection) -> Result<String, String> {
    if let Some(existing) = get_meta(conn, META_KEY_USER_ID) {
        if !existing.trim().is_empty() {
            return Ok(existing);
        }
    }

    let uid = Uuid::new_v4().to_string();
    set_meta(conn, META_KEY_USER_ID, &uid)?;
    Ok(uid)
}

fn merge_legacy_files(app: &AppHandle, conn: &Connection, default_user_id: &str) -> Result<(), String> {
    let mut candidates = Vec::new();

    if let Ok(config_dir) = app.path().app_config_dir() {
        candidates.push(config_dir.join("analytics_legacy.json"));
        candidates.push(config_dir.join("analytics_pending.json"));
        candidates.push(config_dir.join("usage_analytics.json"));
    }

    if let Ok(data_dir) = app.path().app_data_dir() {
        candidates.push(data_dir.join("analytics_legacy.json"));
        candidates.push(data_dir.join("analytics_pending.json"));
        candidates.push(data_dir.join("usage_analytics.json"));
    }

    for path in candidates {
        if !path.exists() {
            continue;
        }

        let content = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let payload: LegacyPayload = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let legacy_user_id = payload
            .user_id
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(default_user_id)
            .to_string();

        for day in payload.days {
            if day.stat_date.trim().is_empty() {
                continue;
            }

            conn.execute(
                "INSERT INTO analytics_daily (
                    user_id, stat_date, os, cpu_arch, system_language, app_version,
                    play_video_count, download_video_count, app_launch_count,
                    active_duration_seconds, search_designation_count,
                    search_resource_link_count, current_video_total_count,
                    needs_sync, sent_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 1, NULL)
                ON CONFLICT(user_id) DO UPDATE SET
                    play_video_count = CASE
                        WHEN analytics_daily.stat_date = excluded.stat_date
                        THEN analytics_daily.play_video_count + excluded.play_video_count
                        ELSE excluded.play_video_count
                    END,
                    download_video_count = CASE
                        WHEN analytics_daily.stat_date = excluded.stat_date
                        THEN analytics_daily.download_video_count + excluded.download_video_count
                        ELSE excluded.download_video_count
                    END,
                    app_launch_count = CASE
                        WHEN analytics_daily.stat_date = excluded.stat_date
                        THEN analytics_daily.app_launch_count + excluded.app_launch_count
                        ELSE excluded.app_launch_count
                    END,
                    active_duration_seconds = CASE
                        WHEN analytics_daily.stat_date = excluded.stat_date
                        THEN analytics_daily.active_duration_seconds + excluded.active_duration_seconds
                        ELSE excluded.active_duration_seconds
                    END,
                    search_designation_count = CASE
                        WHEN analytics_daily.stat_date = excluded.stat_date
                        THEN analytics_daily.search_designation_count + excluded.search_designation_count
                        ELSE excluded.search_designation_count
                    END,
                    search_resource_link_count = CASE
                        WHEN analytics_daily.stat_date = excluded.stat_date
                        THEN analytics_daily.search_resource_link_count + excluded.search_resource_link_count
                        ELSE excluded.search_resource_link_count
                    END,
                    current_video_total_count = MAX(analytics_daily.current_video_total_count, excluded.current_video_total_count),
                    system_language = CASE
                        WHEN excluded.system_language != '' THEN excluded.system_language
                        ELSE analytics_daily.system_language
                    END,
                    stat_date = excluded.stat_date,
                    os = excluded.os,
                    cpu_arch = excluded.cpu_arch,
                    app_version = excluded.app_version,
                    needs_sync = 1,
                    sent_at = NULL,
                    updated_at = datetime('now')",
                params![
                    legacy_user_id,
                    day.stat_date,
                    day.os.unwrap_or_else(|| std::env::consts::OS.to_string()),
                    day.cpu_arch
                        .unwrap_or_else(|| std::env::consts::ARCH.to_string()),
                    day.system_language.unwrap_or_default(),
                    day.app_version.unwrap_or_default(),
                    day.play_video_count.unwrap_or(0),
                    day.download_video_count.unwrap_or(0),
                    day.app_launch_count.unwrap_or(0),
                    day.active_duration_seconds.unwrap_or(0),
                    day.search_designation_count.unwrap_or(0),
                    day.search_resource_link_count.unwrap_or(0),
                    day.current_video_total_count.unwrap_or(0),
                ],
            )
            .map_err(|e| e.to_string())?;
        }

        let _ = std::fs::remove_file(&path);
    }

    Ok(())
}

fn upsert_today_delta(
    app: &AppHandle,
    conn: &Connection,
    user_id: &str,
    language: Option<&str>,
    app_launch_delta: i64,
    play_delta: i64,
    download_delta: i64,
    active_seconds_delta: i64,
    search_designation_delta: i64,
    search_resource_link_delta: i64,
) -> Result<(), String> {
    let today = today_string();
    let language_value = if let Some(lang) = language {
        normalize_language(Some(lang))
    } else {
        get_meta(conn, META_KEY_SYSTEM_LANGUAGE).unwrap_or_default()
    };

    let version = app_version(app);
    let total_videos = video_total_count(conn);

    conn.execute(
        "INSERT INTO analytics_daily (
            user_id, stat_date, os, cpu_arch, system_language, app_version,
            play_video_count, download_video_count, app_launch_count,
            active_duration_seconds, search_designation_count,
            search_resource_link_count, current_video_total_count,
            needs_sync, sent_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 1, NULL)
        ON CONFLICT(user_id) DO UPDATE SET
            play_video_count = CASE
                WHEN analytics_daily.stat_date = excluded.stat_date
                THEN analytics_daily.play_video_count + excluded.play_video_count
                ELSE excluded.play_video_count
            END,
            download_video_count = CASE
                WHEN analytics_daily.stat_date = excluded.stat_date
                THEN analytics_daily.download_video_count + excluded.download_video_count
                ELSE excluded.download_video_count
            END,
            app_launch_count = CASE
                WHEN analytics_daily.stat_date = excluded.stat_date
                THEN analytics_daily.app_launch_count + excluded.app_launch_count
                ELSE excluded.app_launch_count
            END,
            active_duration_seconds = CASE
                WHEN analytics_daily.stat_date = excluded.stat_date
                THEN analytics_daily.active_duration_seconds + excluded.active_duration_seconds
                ELSE excluded.active_duration_seconds
            END,
            search_designation_count = CASE
                WHEN analytics_daily.stat_date = excluded.stat_date
                THEN analytics_daily.search_designation_count + excluded.search_designation_count
                ELSE excluded.search_designation_count
            END,
            search_resource_link_count = CASE
                WHEN analytics_daily.stat_date = excluded.stat_date
                THEN analytics_daily.search_resource_link_count + excluded.search_resource_link_count
                ELSE excluded.search_resource_link_count
            END,
            stat_date = excluded.stat_date,
            os = excluded.os,
            cpu_arch = excluded.cpu_arch,
            system_language = CASE
                WHEN excluded.system_language != '' THEN excluded.system_language
                ELSE analytics_daily.system_language
            END,
            app_version = excluded.app_version,
            current_video_total_count = excluded.current_video_total_count,
            needs_sync = 1,
            sent_at = NULL,
            updated_at = datetime('now')",
        params![
            user_id,
            today,
            std::env::consts::OS,
            std::env::consts::ARCH,
            language_value,
            version,
            play_delta.max(0),
            download_delta.max(0),
            app_launch_delta.max(0),
            active_seconds_delta.max(0),
            search_designation_delta.max(0),
            search_resource_link_delta.max(0),
            total_videos.max(0),
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

fn load_supabase_config() -> Option<SupabaseConfig> {
    default_supabase_config()
}

fn url_preview(url: &str) -> String {
    if let Ok(parsed) = url::Url::parse(url) {
        if let Some(host) = parsed.host_str() {
            return format!("{}://{}", parsed.scheme(), host);
        }
    }
    "<invalid-url>".to_string()
}

#[tauri::command]
pub async fn analytics_debug_supabase_config(_app: AppHandle) -> Result<SupabaseConfigDebugInfo, String> {
    let resolved = load_supabase_config();
    let info = SupabaseConfigDebugInfo {
        found: resolved.is_some(),
        source: if resolved.is_some() {
            "built_in_default".to_string()
        } else {
            "none".to_string()
        },
        url_preview: resolved.as_ref().map(|c| url_preview(&c.url)),
        key_length: resolved.as_ref().map(|c| c.api_key.len()),
        table: resolved.as_ref().map(|c| c.table.clone()),
    };

    Ok(info)
}

fn load_pending_payloads_before(
    app: &AppHandle,
    user_id: &str,
    before_date: &str,
) -> Result<Vec<DailyStatPayload>, String> {
    with_connection(app, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT
                    user_id,
                    stat_date,
                    os,
                    cpu_arch,
                    system_language,
                    app_version,
                    play_video_count,
                    download_video_count,
                    app_launch_count,
                    active_duration_seconds,
                    search_designation_count,
                    search_resource_link_count,
                    current_video_total_count
                FROM analytics_daily
                WHERE user_id = ?1
                  AND needs_sync = 1
                  AND stat_date < ?2
                ORDER BY stat_date ASC, updated_at ASC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![user_id, before_date], |row| {
                Ok(DailyStatPayload {
                    user_id: row.get(0)?,
                    stat_date: row.get(1)?,
                    os: row.get(2)?,
                    cpu_arch: row.get(3)?,
                    system_language: row.get(4)?,
                    app_version: row.get(5)?,
                    play_video_count: row.get(6)?,
                    download_video_count: row.get(7)?,
                    app_launch_count: row.get(8)?,
                    active_duration_seconds: row.get(9)?,
                    search_designation_count: row.get(10)?,
                    search_resource_link_count: row.get(11)?,
                    download_video_failed_count: 0,
                    current_video_total_count: row.get(12)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut payloads = Vec::new();
        for row in rows {
            payloads.push(row.map_err(|e| e.to_string())?);
        }

        Ok(payloads)
    })
}

fn load_all_pending_payloads(app: &AppHandle, user_id: &str) -> Result<Vec<DailyStatPayload>, String> {
    with_connection(app, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT
                    user_id,
                    stat_date,
                    os,
                    cpu_arch,
                    system_language,
                    app_version,
                    play_video_count,
                    download_video_count,
                    app_launch_count,
                    active_duration_seconds,
                    search_designation_count,
                    search_resource_link_count,
                    current_video_total_count
                FROM analytics_daily
                WHERE user_id = ?1
                  AND needs_sync = 1
                ORDER BY stat_date ASC, updated_at ASC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![user_id], |row| {
                Ok(DailyStatPayload {
                    user_id: row.get(0)?,
                    stat_date: row.get(1)?,
                    os: row.get(2)?,
                    cpu_arch: row.get(3)?,
                    system_language: row.get(4)?,
                    app_version: row.get(5)?,
                    play_video_count: row.get(6)?,
                    download_video_count: row.get(7)?,
                    app_launch_count: row.get(8)?,
                    active_duration_seconds: row.get(9)?,
                    search_designation_count: row.get(10)?,
                    search_resource_link_count: row.get(11)?,
                    download_video_failed_count: 0,
                    current_video_total_count: row.get(12)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut payloads = Vec::new();
        for row in rows {
            payloads.push(row.map_err(|e| e.to_string())?);
        }

        Ok(payloads)
    })
}

fn mark_payload_synced(app: &AppHandle, user_id: &str) -> Result<(), String> {
    with_connection(app, |conn| {
        conn.execute(
            "UPDATE analytics_daily
             SET needs_sync = 0,
                 sent_at = datetime('now'),
                 updated_at = datetime('now')
             WHERE user_id = ?1",
            params![user_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

async fn upload_payloads(
    app: &AppHandle,
    config: &SupabaseConfig,
    payloads: Vec<DailyStatPayload>,
) -> Result<(usize, usize), String> {
    if payloads.is_empty() {
        return Ok((0, 0));
    }

    let client = crate::utils::proxy::apply_proxy_auto(
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(12)),
    )
    .map_err(|e| e.to_string())?
    .build()
    .map_err(|e| e.to_string())?;

    let endpoint = format!(
        "{}/rest/v1/{}?on_conflict=user_id",
        config.url, config.table
    );

    let mut success = 0usize;
    let mut failed = 0usize;

    for row in payloads {
        let response = client
            .post(&endpoint)
            .header("apikey", &config.api_key)
            .header("Content-Type", "application/json")
            .header("Prefer", "resolution=merge-duplicates,return=minimal")
            .json(&vec![row.clone()])
            .send()
            .await;

        match response {
            Ok(resp) if resp.status().is_success() => {
                mark_payload_synced(app, &row.user_id)?;
                success += 1;
            }
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                log::error!(
                    "[analytics] event=supabase_upload_failed user_id={} stat_date={} status={} error_body={}",
                    row.user_id,
                    row.stat_date,
                    status.as_u16(),
                    body
                );
                failed += 1;
            }
            Err(e) => {
                log::error!(
                    "[analytics] event=supabase_upload_request_failed user_id={} stat_date={} error={}",
                    row.user_id,
                    row.stat_date,
                    e
                );
                failed += 1;
            }
        }
    }

    Ok((success, failed))
}

async fn flush_previous_days(app: &AppHandle, user_id: &str) -> Result<(), String> {
    let config = match load_supabase_config() {
        Some(cfg) => cfg,
        None => return Ok(()),
    };

    let today = today_string();
    let payloads = load_pending_payloads_before(app, user_id, &today)?;
    if payloads.is_empty() {
        return Ok(());
    }

    let _ = upload_payloads(app, &config, payloads).await?;

    Ok(())
}

fn with_connection<T>(app: &AppHandle, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let db = Database::new(app).map_err(|e| e.to_string())?;
    let conn = db.get_connection().map_err(|e| e.to_string())?;
    ensure_tables(&conn)?;
    f(&conn)
}

fn apply_counter(
    app: &AppHandle,
    updater: impl FnOnce(&Connection, &str) -> Result<(), String>,
) -> Result<(), String> {
    with_connection(app, |conn| {
        let user_id = ensure_user_id(conn)?;
        updater(conn, &user_id)?;
        set_meta(conn, META_KEY_LAST_ACTIVE_DATE, &today_string())?;
        Ok(())
    })
}

pub fn record_play_video(app: &AppHandle) {
    if let Err(e) = apply_counter(app, |conn, user_id| {
        upsert_today_delta(app, conn, user_id, None, 0, 1, 0, 0, 0, 0)
    }) {
        log::error!("[analytics] event=record_play_video_failed error={}", e);
    }
}

pub fn record_download_completed(app: &AppHandle) {
    if let Err(e) = apply_counter(app, |conn, user_id| {
        upsert_today_delta(app, conn, user_id, None, 0, 0, 1, 0, 0, 0)
    }) {
        log::error!("[analytics] event=record_download_completed_failed error={}", e);
    }
}

pub fn record_search_designation(app: &AppHandle) {
    if let Err(e) = apply_counter(app, |conn, user_id| {
        upsert_today_delta(app, conn, user_id, None, 0, 0, 0, 0, 1, 0)
    }) {
        log::error!("[analytics] event=record_search_designation_failed error={}", e);
    }
}

pub fn record_search_resource_link(app: &AppHandle) {
    if let Err(e) = apply_counter(app, |conn, user_id| {
        upsert_today_delta(app, conn, user_id, None, 0, 0, 0, 0, 0, 1)
    }) {
        log::error!("[analytics] event=record_search_resource_link_failed error={}", e);
    }
}

#[tauri::command]
pub async fn analytics_init(app: AppHandle, system_language: Option<String>) -> Result<(), String> {
    let (user_id, crossed_day) = with_connection(&app, |conn| {
        let user_id = ensure_user_id(conn)?;
        merge_legacy_files(&app, conn, &user_id)?;

        let normalized = normalize_language(system_language.as_deref());
        if !normalized.is_empty() {
            set_meta(conn, META_KEY_SYSTEM_LANGUAGE, &normalized)?;
        }

        let today = today_string();
        let last_active_date = get_meta(conn, META_KEY_LAST_ACTIVE_DATE).unwrap_or_default();
        let crossed_day = !last_active_date.is_empty() && last_active_date != today;

        Ok((user_id, crossed_day))
    })?;

    if crossed_day {
        flush_previous_days(&app, &user_id).await?;
    }

    with_connection(&app, |conn| {
        upsert_today_delta(&app, conn, &user_id, system_language.as_deref(), 1, 0, 0, 0, 0, 0)?;
        set_meta(conn, META_KEY_LAST_ACTIVE_DATE, &today_string())?;
        Ok(())
    })?;

    Ok(())
}

#[tauri::command]
pub async fn analytics_add_active_seconds(app: AppHandle, seconds: u64) -> Result<(), String> {
    let delta = (seconds as i64).clamp(0, 3600);
    if delta == 0 {
        return Ok(());
    }

    let (user_id, crossed_day) = with_connection(&app, |conn| {
        let user_id = ensure_user_id(conn)?;
        let today = today_string();
        let last_active_date = get_meta(conn, META_KEY_LAST_ACTIVE_DATE).unwrap_or_default();
        let crossed_day = !last_active_date.is_empty() && last_active_date != today;
        Ok((user_id, crossed_day))
    })?;

    if crossed_day {
        flush_previous_days(&app, &user_id).await?;
    }

    apply_counter(&app, |conn, uid| {
        upsert_today_delta(&app, conn, uid, None, 0, 0, 0, delta, 0, 0)
    })?;

    Ok(())
}

#[tauri::command]
pub async fn analytics_sync_now(app: AppHandle) -> Result<usize, String> {
    let user_id = with_connection(&app, |conn| ensure_user_id(conn))?;
    let config = load_supabase_config()
        .ok_or_else(|| "未找到有效的 Supabase 配置。".to_string())?;

    let payloads = load_all_pending_payloads(&app, &user_id)?;
    let total = payloads.len();
    if total == 0 {
        return Ok(0);
    }

    let (success, failed) = upload_payloads(&app, &config, payloads).await?;
    if failed > 0 {
        return Err(format!("已同步 {} 条，失败 {} 条", success, failed));
    }

    Ok(success)
}
