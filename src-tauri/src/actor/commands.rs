//! 演员中心命令：抓取档案 + 作品全集（star 页），演员详情查询。

use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::db::{ActorWorkInput, Database};
use crate::error::{AppError, AppResult};
use crate::resource_scrape::{actor_provider, anti_block};
use crate::utils::designation_recognizer;

/// 分页抓取上限，防止异常分页导致空转
const MAX_STAR_PAGES: u32 = 50;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorFetchResult {
    pub profile_updated: bool,
    pub works_total: usize,
    pub works_local: i64,
}

fn opt(s: &str) -> Option<&str> {
    if s.trim().is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 抓取演员档案 + 作品全集：用已收割的 star code 取 star 页（分页爬全），
/// 解析档案与作品 → 落库 + 本地番号匹配。需先刮削该演员任一作品以获得 star code。
#[tauri::command]
pub async fn fetch_actor_profile(
    actor_id: i64,
    db: State<'_, Database>,
) -> AppResult<ActorFetchResult> {
    // 1. 取 star code（无则提示先刮削）
    let star_code = {
        let conn = db.get_connection()?;
        Database::get_actor_star_code(&conn, actor_id)?
    }
    .ok_or_else(|| AppError::Business("该演员暂无数据源链接，请先刮削其任一作品".to_string()))?;

    // 2. 分页抓取 + 解析（解析为纯 CPU,产出 owned 数据后丢弃 HTML,不跨 await 持有）
    let token = CancellationToken::new();
    let mut profile: Option<crate::db::ActorProfileInput> = None;
    let mut works: Vec<actor_provider::StarWork> = Vec::new();
    let mut page = 1u32;
    loop {
        let url = actor_provider::build_star_url(&star_code, page);
        let html = anti_block::engine()
            .fetch_text(&url, "javbus", &token)
            .await
            .map_err(AppError::Business)?;

        if page == 1 {
            profile = Some(actor_provider::parse_profile(&html));
        }
        let page_works = actor_provider::parse_works(&html);
        let has_next = actor_provider::parse_has_next_page(&html);
        if page_works.is_empty() {
            break;
        }
        works.extend(page_works);
        if !has_next || page >= MAX_STAR_PAGES {
            break;
        }
        page += 1;
    }

    // 3. 落库（单事务：档案 + 作品 upsert + 本地匹配 + 作品数）
    let profile_updated = profile.is_some();
    let works_total = works.len();
    let db_inner = db.inner().clone();
    let works_local = tokio::task::spawn_blocking(move || -> AppResult<i64> {
        let mut conn = db_inner.get_connection()?;
        let tx = conn.transaction()?;

        if let Some(p) = &profile {
            Database::update_actor_profile(&tx, actor_id, p)?;
        }
        for w in &works {
            let is_unc = designation_recognizer::is_uncensored_designation(&w.code);
            Database::upsert_actor_work(
                &tx,
                &ActorWorkInput {
                    actor_id,
                    code: &w.code,
                    title: opt(&w.title),
                    cover_url: opt(&w.cover_url),
                    release_date: opt(&w.release_date),
                    source: Some("javbus"),
                    is_uncensored: is_unc,
                },
            )?;
        }
        Database::relink_actor_works_local(&tx, actor_id)?;
        Database::set_actor_work_count(&tx, actor_id, works_total as i64)?;

        let local: i64 = tx.query_row(
            "SELECT COUNT(*) FROM actor_works WHERE actor_id = ?1 AND status = 'local'",
            rusqlite::params![actor_id],
            |r| r.get(0),
        )?;
        tx.commit()?;
        Ok(local)
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))??;

    Ok(ActorFetchResult {
        profile_updated,
        works_total,
        works_local,
    })
}

/// 演员详情：档案 + 作品全集（本地有/缺失），供演员详情页渲染。
#[tauri::command]
pub async fn get_actor_detail(
    actor_id: i64,
    db: State<'_, Database>,
) -> AppResult<serde_json::Value> {
    let conn = db.get_connection()?;
    tokio::task::spawn_blocking(move || -> AppResult<serde_json::Value> {
        let profile = conn.query_row(
            "SELECT id, name, avatar_path, avatar_url, birthday, height, cup, bust, waist, hip, work_count
             FROM actors WHERE id = ?",
            rusqlite::params![actor_id],
            |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, i64>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "avatarPath": r.get::<_, Option<String>>(2)?,
                    "avatarUrl": r.get::<_, Option<String>>(3)?,
                    "birthday": r.get::<_, Option<String>>(4)?,
                    "height": r.get::<_, Option<i64>>(5)?,
                    "cup": r.get::<_, Option<String>>(6)?,
                    "bust": r.get::<_, Option<i64>>(7)?,
                    "waist": r.get::<_, Option<i64>>(8)?,
                    "hip": r.get::<_, Option<i64>>(9)?,
                    "workCount": r.get::<_, Option<i64>>(10)?,
                }))
            },
        )?;

        let mut stmt = conn.prepare(
            "SELECT code, title, cover_url, release_date, status, local_video_id, is_uncensored
             FROM actor_works WHERE actor_id = ? ORDER BY release_date DESC",
        )?;
        let works: Vec<serde_json::Value> = stmt
            .query_map(rusqlite::params![actor_id], |r| {
                Ok(serde_json::json!({
                    "code": r.get::<_, String>(0)?,
                    "title": r.get::<_, Option<String>>(1)?,
                    "coverUrl": r.get::<_, Option<String>>(2)?,
                    "releaseDate": r.get::<_, Option<String>>(3)?,
                    "status": r.get::<_, String>(4)?,
                    "localVideoId": r.get::<_, Option<String>>(5)?,
                    "isUncensored": r.get::<_, Option<i64>>(6)?.unwrap_or(0) != 0,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        Ok(serde_json::json!({ "profile": profile, "works": works }))
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}
