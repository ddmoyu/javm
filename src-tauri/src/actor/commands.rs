//! 演员中心命令：抓取档案 + 作品全集（star 页），演员详情查询。

use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

use crate::db::{ActorWorkInput, Database, FacetWorkInput, MetadataTable};
use crate::error::{AppError, AppResult};
use crate::resource_scrape::actor_provider;
use crate::resource_scrape::fetcher::{FetchOptions, Fetcher};
use crate::resource_scrape::sources::ResourceSite;
use crate::settings;
use crate::utils::designation_recognizer;

/// 分页抓取上限，防止异常分页导致空转
const MAX_STAR_PAGES: u32 = 50;

/// 演员/维度全集抓取的取消状态：按 key（`actor:{id}` / `facet:{type}:{name}`）保存当前抓取令牌，
/// 供「停止」命令触发取消。新一次抓取会取消并替换同 key 的旧令牌。
#[derive(Default)]
pub struct FetchCancelState {
    map: tokio::sync::Mutex<std::collections::HashMap<String, CancellationToken>>,
}

impl FetchCancelState {
    pub fn new() -> Self {
        Self::default()
    }

    /// 开始一次抓取：取消并替换同 key 的旧令牌，返回新令牌
    pub async fn begin(&self, key: String) -> CancellationToken {
        let token = CancellationToken::new();
        let mut guard = self.map.lock().await;
        if let Some(old) = guard.insert(key, token.clone()) {
            old.cancel();
        }
        token
    }

    /// 触发某 key 的取消（停止抓取）
    pub async fn cancel(&self, key: &str) {
        if let Some(token) = self.map.lock().await.get(key) {
            token.cancel();
        }
    }
}

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

fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// 从 "B88/W58/H85" 之类的三围原文提取 bust/waist/hip。识别不出则 None。
fn parse_measurements(s: &str) -> (Option<i32>, Option<i32>, Option<i32>) {
    let upper = s.to_uppercase();
    let grab = |prefix: char| -> Option<i32> {
        let pos = upper.find(prefix)?;
        let digits: String = upper[pos + prefix.len_utf8()..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        digits.parse().ok()
    };
    (grab('B'), grab('W'), grab('H'))
}

/// 规整生日：取日期部分（截到 'T' 前），年份 < 1900 视为零值/无效 → None。
/// MetaTube 对未知生日返回 "0001-01-01T00:00:00Z" 之类零值，需过滤，否则前端显示成乱日期。
fn normalize_birthday(raw: &str) -> Option<String> {
    let date = raw.trim().split('T').next().unwrap_or("").trim();
    let year: i32 = date.split('-').next().and_then(|y| y.parse().ok()).unwrap_or(0);
    if year < 1900 {
        return None;
    }
    Some(date.to_string())
}

/// MetaTube ActorInfo → 演员档案入参（头像取首图，三围从 measurements 解析）。
fn actor_info_to_profile(info: &crate::metatube::types::ActorInfo) -> crate::db::ActorProfileInput {
    let (bust, waist, hip) = parse_measurements(&info.measurements);
    crate::db::ActorProfileInput {
        avatar_url: info.images.iter().find(|s| !s.trim().is_empty()).cloned(),
        birthday: normalize_birthday(&info.birthday),
        height: (info.height > 0).then_some(info.height as i32),
        cup: non_empty(&info.cup_size),
        bust,
        waist,
        hip,
    }
}

/// 抓取演员档案 + 作品全集：解析 star 页（分页爬全）→ 落库 + 本地番号匹配。
///
/// star code 优先用库里已收割的（刮削时从详情页 `.avatar-box` 取）；没有则按演员名走
/// `searchstar` 搜索解析得到并回填。所有抓取经 `Fetcher`（HTTP→WebView 回退），
/// 过 javbus 的年龄门 / Cloudflare（与详情刮削同路径）。
#[tauri::command]
pub async fn fetch_actor_profile(
    app: AppHandle,
    actor_id: i64,
    // 抓取用名字候选（主名在前），逐个搜源，命中即止。空则只用库内名。
    name_candidates: Option<Vec<String>>,
    db: State<'_, Database>,
    cancel: State<'_, FetchCancelState>,
) -> AppResult<ActorFetchResult> {
    // javbus 站点 + 抓取选项（含 WebView 回退），与详情刮削一致，用于过年龄门 / CF
    let app_settings = settings::get_settings(app.clone()).await.unwrap_or_default();
    let fetch_settings = settings::resolve_scrape_fetch_settings(&app_settings.scrape);
    let options = FetchOptions {
        webview_enabled: fetch_settings.webview_enabled,
        webview_fallback_enabled: fetch_settings.webview_fallback_enabled,
        show_webview: fetch_settings.dev_show_webview,
        max_webview_windows: fetch_settings.max_webview_windows,
    };
    let site = ResourceSite {
        id: "javbus".to_string(),
        name: "javbus".to_string(),
        enabled: true,
        avg_score: None,
        scrape_count: None,
    };
    // 注册可取消令牌（供「停止」按钮触发），覆盖搜索 + 全集分页全过程
    let token = cancel.begin(format!("actor:{actor_id}")).await;
    let fetcher = Fetcher::new();

    // 1. star code：库里有就用；没有则按演员名 searchstar 搜索并回填
    let (name, mut star_code) = {
        let conn = db.get_connection()?;
        let name: String = conn
            .query_row(
                "SELECT name FROM actors WHERE id = ?",
                rusqlite::params![actor_id],
                |r| r.get(0),
            )
            .map_err(|e| AppError::Business(format!("演员不存在: {e}")))?;
        let code = Database::get_actor_star_code(&conn, actor_id)?;
        (name, code)
    };

    // 名字候选：前端传入（主名在前）优先，库内名兜底；去重保序。让用户把正确源名放前面即可搜到。
    let candidates: Vec<String> = {
        let mut v: Vec<String> = Vec::new();
        if let Some(list) = name_candidates {
            for c in list {
                let t = c.trim().to_string();
                if !t.is_empty() && !v.contains(&t) {
                    v.push(t);
                }
            }
        }
        let nt = name.trim().to_string();
        if !nt.is_empty() && !v.contains(&nt) {
            v.push(nt);
        }
        v
    };

    // 1.5 MetaTube 档案（就绪时优先）：结构化 JSON 拿头像/身高/三围/生日，比抓 star 页可靠、免年龄门；
    //      并尽量取 JavBus provider 的演员 id 当 star code（用于后续全集抓取）。
    let mut mt_profile: Option<crate::db::ActorProfileInput> = None;
    if let Some(client) = app
        .try_state::<crate::metatube::MetaTubeManager>()
        .and_then(|m| m.client())
    {
        for cand in &candidates {
            let Ok(cands) = client.search_actor(cand, &[]).await else {
                continue;
            };
            let want = cand.trim();
            let pick = cands
                .iter()
                .find(|c| c.name.trim() == want && c.provider.eq_ignore_ascii_case("javbus"))
                .or_else(|| cands.iter().find(|c| c.name.trim() == want))
                .or_else(|| cands.first());
            if let Some(c) = pick {
                if let Ok(info) = client.get_actor(&c.provider, &c.id).await {
                    mt_profile = Some(actor_info_to_profile(&info));
                }
                if star_code.is_none()
                    && c.provider.eq_ignore_ascii_case("javbus")
                    && !c.id.trim().is_empty()
                {
                    let conn = db.get_connection()?;
                    let avatar = c.images.first().map(|s| s.as_str()).unwrap_or("");
                    let _ = Database::update_actor_avatar(&conn, &name, avatar, &c.id);
                    star_code = Some(c.id.clone());
                }
                break; // 命中一个候选即止
            }
        }
    }

    // star code 仍无 → JavBus searchstar 兜底（经 fetcher 过年龄门），逐个候选名搜
    if star_code.is_none() {
        for cand in &candidates {
            if token.is_cancelled() {
                break;
            }
            let search_url = actor_provider::build_search_url(cand);
            if let Ok(html) = fetcher.fetch(&app, &search_url, &site, options, &token).await {
                if let Some(hit) = actor_provider::pick_star_from_search(&html, cand) {
                    let conn = db.get_connection()?;
                    let _ =
                        Database::update_actor_avatar(&conn, &name, &hit.avatar_url, &hit.star_code);
                    star_code = Some(hit.star_code);
                    break;
                }
            }
        }
    }

    // 既无 star code 又无 MetaTube 档案 → 确实搜不到
    if star_code.is_none() && mt_profile.is_none() {
        return Err(AppError::Business(format!(
            "未在数据源搜到演员「{name}」，无法获取档案/全集"
        )));
    }

    // 2. 先落 MetaTube 档案并发进度，让前端立即显示档案（即使没全集也有档案）
    let mut profile_updated = mt_profile.is_some();
    if let Some(p) = mt_profile.clone() {
        let db_inner = db.inner().clone();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let conn = db_inner.get_connection()?;
            Database::update_actor_profile(&conn, actor_id, &p)?;
            Ok(())
        })
        .await
        .map_err(|e| AppError::TaskJoin(e.to_string()))??;
    }
    let _ = app.emit(
        "actor-fetch-progress",
        serde_json::json!({ "actorId": actor_id, "worksTotal": 0 }),
    );

    // 3. 全集：有 star code 才分页抓 star 页，**边抓边存边发进度**，前端每页即增量显示
    let mut works_total = 0usize;
    if let Some(code) = &star_code {
        let mut page = 1u32;
        loop {
            // 用户点了「停止」：保留已抓到的页（每页已各自提交），直接结束
            if token.is_cancelled() {
                break;
            }
            let url = actor_provider::build_star_url(code, page);
            let html = match fetcher.fetch(&app, &url, &site, options, &token).await {
                Ok(h) => h,
                Err(e) => {
                    if token.is_cancelled() {
                        break;
                    }
                    return Err(AppError::Business(e));
                }
            };
            let page_profile = if page == 1 {
                Some(actor_provider::parse_profile(&html))
            } else {
                None
            };
            let page_works = actor_provider::parse_works(&html);
            let has_next = actor_provider::parse_has_next_page(&html);
            if page_profile.is_some() {
                profile_updated = true;
            }
            let n = page_works.len();
            if n == 0 && page_profile.is_none() {
                break;
            }

            // 持久化本页（page1 档案 + 作品 + 本地匹配）。page1 在 star 档案后重写 MetaTube，保 MetaTube 优先
            let db_inner = db.inner().clone();
            let batch = page_works;
            let pp = page_profile;
            let mt = if page == 1 { mt_profile.clone() } else { None };
            tokio::task::spawn_blocking(move || -> AppResult<()> {
                let mut conn = db_inner.get_connection()?;
                let tx = conn.transaction()?;
                if let Some(p) = &pp {
                    Database::update_actor_profile(&tx, actor_id, p)?;
                }
                if let Some(p) = &mt {
                    Database::update_actor_profile(&tx, actor_id, p)?;
                }
                for w in &batch {
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
                tx.commit()?;
                Ok(())
            })
            .await
            .map_err(|e| AppError::TaskJoin(e.to_string()))??;
            works_total += n;

            let _ = app.emit(
                "actor-fetch-progress",
                serde_json::json!({ "actorId": actor_id, "worksTotal": works_total }),
            );

            if n == 0 || !has_next || page >= MAX_STAR_PAGES {
                break;
            }
            page += 1;
        }
    }

    let works_local: i64 = {
        let conn = db.get_connection()?;
        Database::set_actor_work_count(&conn, actor_id, works_total as i64)?;
        conn.query_row(
            "SELECT COUNT(*) FROM actor_works WHERE actor_id = ?1 AND status = 'local'",
            rusqlite::params![actor_id],
            |r| r.get(0),
        )?
    };
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
    // 该演员的所有别名：多名字演员的不同 name-form 可能各自有一行 actors 记录，全集可能落在任一
    // name-form 的 actor_id 下。按全部别名 id 合并作品，避免「之前抓过却查到 0 部」。
    alias_names: Option<Vec<String>>,
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

        // 汇总当前 id + 所有别名对应的 actor_id（去重）
        let mut ids: Vec<i64> = vec![actor_id];
        if let Some(names) = &alias_names {
            let mut id_stmt = conn.prepare("SELECT id FROM actors WHERE name = ?")?;
            for name in names {
                let trimmed = name.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(id) =
                    id_stmt.query_row(rusqlite::params![trimmed], |r| r.get::<_, i64>(0))
                {
                    if !ids.contains(&id) {
                        ids.push(id);
                    }
                }
            }
        }

        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT code, title, cover_url, release_date, status, local_video_id, is_uncensored
             FROM actor_works WHERE actor_id IN ({placeholders}) ORDER BY release_date DESC"
        );
        let id_params: Vec<&dyn rusqlite::ToSql> =
            ids.iter().map(|i| i as &dyn rusqlite::ToSql).collect();
        let mut stmt = conn.prepare(&sql)?;
        let raw: Vec<(String, bool, serde_json::Value)> = stmt
            .query_map(id_params.as_slice(), |r| {
                let code = r.get::<_, String>(0)?;
                let status = r.get::<_, String>(4)?;
                let is_local = status == "local";
                let value = serde_json::json!({
                    "code": code.clone(),
                    "title": r.get::<_, Option<String>>(1)?,
                    "coverUrl": r.get::<_, Option<String>>(2)?,
                    "releaseDate": r.get::<_, Option<String>>(3)?,
                    "status": status,
                    "localVideoId": r.get::<_, Option<String>>(5)?,
                    "isUncensored": r.get::<_, Option<i64>>(6)?.unwrap_or(0) != 0,
                });
                Ok((code, is_local, value))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        // 跨 id 去重：同番号只保留一条，本地状态优先（缺失版可被本地版替换）
        let mut works: Vec<serde_json::Value> = Vec::new();
        let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for (code, is_local, value) in raw {
            if let Some(&i) = index.get(&code) {
                if is_local && works[i].get("status").and_then(|s| s.as_str()) != Some("local") {
                    works[i] = value;
                }
            } else {
                index.insert(code, works.len());
                works.push(value);
            }
        }

        Ok(serde_json::json!({ "profile": profile, "works": works }))
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}

/// 停止某演员的全集抓取（触发已注册的取消令牌）。
#[tauri::command]
pub async fn cancel_actor_fetch(
    actor_id: i64,
    cancel: State<'_, FetchCancelState>,
) -> AppResult<()> {
    cancel.cancel(&format!("actor:{actor_id}")).await;
    Ok(())
}

// ==================== 维度（片商/系列/导演）作品全集 ====================

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetFetchResult {
    pub works_total: usize,
    pub works_local: i64,
}

fn facet_metadata_table(facet_type: &str) -> Option<MetadataTable> {
    match facet_type {
        "studio" => Some(MetadataTable::Studios),
        "series" => Some(MetadataTable::Series),
        "director" => Some(MetadataTable::Directors),
        _ => None,
    }
}

/// 抓取某维度（片商/系列/导演）的作品全集：定位其数据源 id（缓存优先，否则刮该维度下任一本地番号的
/// 详情页解析），分页爬全集 → 落库 + 本地匹配。经 Fetcher 过年龄门。
#[tauri::command]
pub async fn fetch_facet_works(
    app: AppHandle,
    facet_type: String,
    facet_name: String,
    db: State<'_, Database>,
    cancel: State<'_, FetchCancelState>,
) -> AppResult<FacetFetchResult> {
    let mt = facet_metadata_table(&facet_type)
        .ok_or_else(|| AppError::Business("不支持的维度".to_string()))?;

    let app_settings = settings::get_settings(app.clone()).await.unwrap_or_default();
    let fetch_settings = settings::resolve_scrape_fetch_settings(&app_settings.scrape);
    let options = FetchOptions {
        webview_enabled: fetch_settings.webview_enabled,
        webview_fallback_enabled: fetch_settings.webview_fallback_enabled,
        show_webview: fetch_settings.dev_show_webview,
        max_webview_windows: fetch_settings.max_webview_windows,
    };
    let site = ResourceSite {
        id: "javbus".to_string(),
        name: "javbus".to_string(),
        enabled: true,
        avg_score: None,
        scrape_count: None,
    };
    // 注册可取消令牌（供「停止」按钮触发），覆盖数据源定位 + 全集分页全过程
    let token = cancel
        .begin(format!("facet:{}:{}", facet_type, facet_name.trim()))
        .await;
    let fetcher = Fetcher::new();

    // 1. 维度 id
    let facet_id = {
        let conn = db.get_connection()?;
        Database::get_or_create_metadata(&conn, mt, facet_name.trim())?
    };

    // 2. 数据源 id：缓存优先，否则刮该维度下任一本地番号的详情页解析并缓存
    let mut source_id = {
        let conn = db.get_connection()?;
        Database::get_facet_source_id(&conn, &facet_type, facet_id)?
    };
    if source_id.is_none() {
        let code = {
            let conn = db.get_connection()?;
            Database::find_local_code_for_facet(&conn, &facet_type, facet_id)?
        };
        if let Some(code) = code {
            let detail_url = format!("https://www.javbus.com/{}", code);
            if let Ok(html) = fetcher.fetch(&app, &detail_url, &site, options, &token).await {
                if let Some(sid) = actor_provider::parse_facet_source_id(&html, &facet_type) {
                    let conn = db.get_connection()?;
                    let _ = Database::set_facet_source_id(&conn, &facet_type, facet_id, &sid);
                    source_id = Some(sid);
                }
            }
        }
    }
    let source_id = source_id.ok_or_else(|| {
        AppError::Business(format!("无法定位「{facet_name}」的数据源链接（需先刮削其下任一作品）"))
    })?;

    // 3. 分页抓全集：**边抓边存边发进度**，前端每页即增量显示，不等全部结束
    let mut works_total = 0usize;
    let mut page = 1u32;
    loop {
        // 用户点了「停止」：保留已抓到的页，直接结束
        if token.is_cancelled() {
            break;
        }
        let url = actor_provider::build_facet_url(&facet_type, &source_id, page);
        let html = match fetcher.fetch(&app, &url, &site, options, &token).await {
            Ok(h) => h,
            Err(e) => {
                if token.is_cancelled() {
                    break;
                }
                return Err(AppError::Business(e));
            }
        };
        let page_works = actor_provider::parse_works(&html);
        let has_next = actor_provider::parse_has_next_page(&html);
        if page_works.is_empty() {
            break;
        }

        // 持久化本页 + 本地匹配
        let db_inner = db.inner().clone();
        let ft = facet_type.clone();
        let batch = page_works;
        let n = batch.len();
        tokio::task::spawn_blocking(move || -> AppResult<()> {
            let mut conn = db_inner.get_connection()?;
            let tx = conn.transaction()?;
            for w in &batch {
                let is_unc = designation_recognizer::is_uncensored_designation(&w.code);
                Database::upsert_facet_work(
                    &tx,
                    &FacetWorkInput {
                        facet_type: &ft,
                        facet_id,
                        code: &w.code,
                        title: opt(&w.title),
                        cover_url: opt(&w.cover_url),
                        release_date: opt(&w.release_date),
                        source: Some("javbus"),
                        is_uncensored: is_unc,
                    },
                )?;
            }
            Database::relink_facet_works_local(&tx, &ft, facet_id)?;
            tx.commit()?;
            Ok(())
        })
        .await
        .map_err(|e| AppError::TaskJoin(e.to_string()))??;
        works_total += n;

        // 进度事件 → 前端增量刷新
        let _ = app.emit(
            "facet-fetch-progress",
            serde_json::json!({ "facetName": facet_name, "worksTotal": works_total }),
        );

        if !has_next || page >= MAX_STAR_PAGES {
            break;
        }
        page += 1;
    }

    let works_local: i64 = {
        let conn = db.get_connection()?;
        conn.query_row(
            "SELECT COUNT(*) FROM facet_works WHERE facet_type = ?1 AND facet_id = ?2 AND status = 'local'",
            rusqlite::params![&facet_type, facet_id],
            |r| r.get(0),
        )?
    };
    Ok(FacetFetchResult { works_total, works_local })
}

/// 停止某维度（片商/系列/导演）的全集抓取（触发已注册的取消令牌）。
#[tauri::command]
pub async fn cancel_facet_fetch(
    facet_type: String,
    facet_name: String,
    cancel: State<'_, FetchCancelState>,
) -> AppResult<()> {
    cancel
        .cancel(&format!("facet:{}:{}", facet_type, facet_name.trim()))
        .await;
    Ok(())
}

/// 维度详情：作品全集（本地有/缺失）。供片商/系列/导演详情面板渲染。
#[tauri::command]
pub async fn get_facet_detail(
    facet_type: String,
    facet_name: String,
    db: State<'_, Database>,
) -> AppResult<serde_json::Value> {
    let mt = facet_metadata_table(&facet_type)
        .ok_or_else(|| AppError::Business("不支持的维度".to_string()))?;
    let conn = db.get_connection()?;
    let ft = facet_type.clone();
    tokio::task::spawn_blocking(move || -> AppResult<serde_json::Value> {
        use rusqlite::OptionalExtension;
        let facet_id: Option<i64> = conn
            .query_row(
                &format!("SELECT id FROM {} WHERE name = ?", mt.as_str()),
                rusqlite::params![facet_name.trim()],
                |r| r.get(0),
            )
            .optional()?;

        let works: Vec<serde_json::Value> = if let Some(fid) = facet_id {
            let mut stmt = conn.prepare(
                "SELECT code, title, cover_url, release_date, status, local_video_id, is_uncensored
                 FROM facet_works WHERE facet_type = ?1 AND facet_id = ?2 ORDER BY release_date DESC",
            )?;
            let mapped = stmt.query_map(rusqlite::params![&ft, fid], |r| {
                Ok(serde_json::json!({
                    "code": r.get::<_, String>(0)?,
                    "title": r.get::<_, Option<String>>(1)?,
                    "coverUrl": r.get::<_, Option<String>>(2)?,
                    "releaseDate": r.get::<_, Option<String>>(3)?,
                    "status": r.get::<_, String>(4)?,
                    "localVideoId": r.get::<_, Option<String>>(5)?,
                    "isUncensored": r.get::<_, Option<i64>>(6)?.unwrap_or(0) != 0,
                }))
            })?;
            let collected: rusqlite::Result<Vec<_>> = mapped.collect();
            collected?
        } else {
            Vec::new()
        };

        Ok(serde_json::json!({ "works": works }))
    })
    .await
    .map_err(|e| AppError::TaskJoin(e.to_string()))?
}

/// 缺失作品预览刮削后：把标题/封面存回作品全集条目（actor_works + facet_works），关窗不丢。
#[tauri::command]
pub async fn save_scraped_work_meta(
    code: String,
    title: String,
    cover_url: String,
    db: State<'_, Database>,
) -> AppResult<()> {
    let conn = db.get_connection()?;
    Database::save_scraped_work_meta(&conn, &code, &title, &cover_url)?;
    Ok(())
}

/// 切换某维度取值（演员/片商/系列/导演/分类）的收藏态，返回切换后的收藏态（true=已收藏）。
#[tauri::command]
pub async fn toggle_favorite(
    entity_type: String,
    name: String,
    db: State<'_, Database>,
) -> AppResult<bool> {
    let conn = db.get_connection()?;
    Ok(Database::toggle_favorite(&conn, &entity_type, &name)?)
}

/// 某维度类型下的全部收藏取值名（按收藏时间倒序）。
#[tauri::command]
pub async fn list_favorites(
    entity_type: String,
    db: State<'_, Database>,
) -> AppResult<Vec<String>> {
    let conn = db.get_connection()?;
    Ok(Database::list_favorites(&conn, &entity_type)?)
}
