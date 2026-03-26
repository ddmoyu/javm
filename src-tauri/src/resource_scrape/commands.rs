//! 资源刮削 Tauri 命令
//!
//! 提供搜索、图片代理、资源网站列表等命令。
//! 搜索使用事件流式推送：每个数据源有结果就立即通过 `search-result` 事件发给前端，
//! 全部完成后发送 `search-done` 事件。
//!
//! 注意：函数名使用 `rs_` 前缀以避免与旧 search::commands 模块的宏名冲突。
//! 在任务 7.2 移除旧模块后，可通过 `#[tauri::command(rename_all = "snake_case")]`
//! 或直接重命名恢复原名。

use super::client;
use super::fetcher::Fetcher;
use super::sources;
use super::sources::{ResourceSite, Source};
use crate::analytics;
use crate::settings;
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio_util::sync::CancellationToken;

/// 搜索取消状态：存储当前搜索的 CancellationToken
pub struct SearchCancelState {
    token: tokio::sync::Mutex<Option<CancellationToken>>,
}

impl SearchCancelState {
    pub fn new() -> Self {
        Self {
            token: tokio::sync::Mutex::new(None),
        }
    }
}

fn preview_html(html: &str) -> String {
    let compact = html.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut preview = compact.chars().take(300).collect::<String>();
    if compact.chars().count() > 300 {
        preview.push_str("...");
    }
    preview
}

fn normalize_result_url(raw: &str, base_url: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    if trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("data:")
        || trimmed.starts_with("blob:")
        || trimmed.starts_with("file://")
        || trimmed.contains(":\\")
        || trimmed.starts_with("\\\\")
    {
        return trimmed.to_string();
    }

    if trimmed.starts_with("//") {
        if let Ok(base) = Url::parse(base_url) {
            return format!("{}:{}", base.scheme(), trimmed);
        }
        return format!("https:{}", trimmed);
    }

    if let Ok(base) = Url::parse(base_url) {
        if let Ok(resolved) = base.join(trimmed) {
            return resolved.to_string();
        }
    }

    trimmed.to_string()
}

fn normalize_result_image_url(raw: &str, base_url: &str) -> String {
    normalize_result_url(raw, base_url)
}

fn normalize_search_result_urls(result: &mut SearchResult, base_url: &str) {
    result.cover_url = normalize_result_image_url(&result.cover_url, base_url);
    result.poster_url = normalize_result_image_url(&result.poster_url, base_url);
    result.thumbs = result
        .thumbs
        .iter()
        .map(|thumb| normalize_result_image_url(thumb, base_url))
        .filter(|thumb| !thumb.is_empty())
        .collect();
}

fn has_text(value: &str) -> bool {
    !value.trim().is_empty()
}

/// 检查搜索结果是否有效（过滤 404、空白页、站点通用标题等无意义结果）
fn is_valid_search_result(result: &SearchResult) -> bool {
    let title_lower = result.title.to_lowercase();

    // 404 / 页面不存在
    let is_not_found = title_lower.contains("404")
        || title_lower.contains("not found")
        || title_lower.contains("页面不存在")
        || title_lower.contains("頁面不存在")
        || title_lower.contains("page not found");

    if is_not_found {
        return false;
    }

    // 无封面 + 无演员 + 无日期 → 极高概率是无效页面
    if result.cover_url.is_empty()
        && result.actors.is_empty()
        && result.premiered.is_empty()
    {
        return false;
    }

    true
}

fn compute_search_result_detail_score(result: &SearchResult) -> i32 {
    let has_previews = !result.thumbs.is_empty();
    let mut score = 0;

    if has_text(&result.title) {
        score += 18;
    }
    if has_text(&result.actors) {
        score += 12;
    }
    if has_text(&result.premiered) {
        score += 10;
    }
    if has_text(&result.duration) {
        score += 8;
    }
    if has_text(&result.studio) {
        score += 8;
    }
    if has_text(&result.cover_url) || has_text(&result.poster_url) {
        score += 10;
    }
    if has_previews {
        score += 24;
    }
    if has_text(&result.director) {
        score += 6;
    }
    if has_text(&result.tags) {
        score += 6;
    }
    if has_text(&result.genres) {
        score += 6;
    }
    if result.rating.is_some() {
        score += 4;
    }
    if has_text(&result.plot) || has_text(&result.outline) {
        score += 12;
    }
    if has_text(&result.tagline) {
        score += 4;
    }
    if has_text(&result.set_name) {
        score += 4;
    }
    if has_text(&result.maker) {
        score += 2;
    }
    if has_text(&result.publisher) {
        score += 2;
    }
    if has_text(&result.label) {
        score += 2;
    }

    if !has_previews {
        return score.min(20);
    }

    score.min(100)
}

fn detail_level_from_score(score: i32) -> &'static str {
    match score {
        75..=100 => "完整",
        50..=74 => "丰富",
        30..=49 => "标准",
        _ => "简略",
    }
}

fn enrich_search_result_detail(result: &mut SearchResult) {
    let score = compute_search_result_detail_score(result);
    result.detail_score = score;
    result.detail_level = detail_level_from_score(score).to_string();
}

async fn proxy_preview_images_to_files(
    client: &reqwest::Client,
    thumbs: &[String],
    referer: &str,
) -> (Vec<String>, Option<Vec<String>>) {
    let mut display_urls = Vec::with_capacity(thumbs.len());
    let mut remote_urls = Vec::with_capacity(thumbs.len());
    let mut has_remote_urls = false;

    for thumb in thumbs {
        let trimmed = thumb.trim();
        if trimmed.is_empty() {
            continue;
        }

        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            has_remote_urls = true;
            remote_urls.push(trimmed.to_string());

            match proxy_image_to_file(client, trimmed, referer).await {
                Ok(local_path) => display_urls.push(local_path),
                Err(e) => {
                    println!("[搜索] 预览图代理失败: {}", e);
                    display_urls.push(trimmed.to_string());
                }
            }
        } else {
            display_urls.push(trimmed.to_string());
            remote_urls.push(trimmed.to_string());
        }
    }

    let remote_urls = if has_remote_urls { Some(remote_urls) } else { None };
    (display_urls, remote_urls)
}

/// 搜索资源：并发请求所有数据源，每个结果通过事件流式推送
///
/// 事件：
/// - `search-result`: 单个数据源的搜索结果（SearchResult）
/// - `search-done`: 搜索全部完成（无 payload）
///
/// 参数：
/// - `code`: 番号
/// - `source`: 可选，指定单个数据源 ID（如 "javbus"），不传则搜索全部
#[tauri::command]
pub async fn rs_search_resource(
    app: AppHandle,
    code: String,
    source: Option<String>,
    search_cancel: tauri::State<'_, SearchCancelState>,
) -> Result<(), String> {
    let code = code.trim().to_uppercase();
    if code.is_empty() {
        return Err("番号不能为空".to_string());
    }

    // 取消上一次搜索
    {
        let mut guard = search_cancel.token.lock().await;
        if let Some(old_token) = guard.take() {
            old_token.cancel();
        }
    }

    // 创建新的取消令牌
    let token = CancellationToken::new();
    {
        let mut guard = search_cancel.token.lock().await;
        *guard = Some(token.clone());
    }

    println!(
        "[搜索] 开始搜索: {}, 数据源: {}",
        code,
        source.as_deref().unwrap_or("全部")
    );

    analytics::record_search_designation(&app);
    let http_client = client::create_client()?;

    let app_settings = settings::get_settings(app.clone()).await.unwrap_or_default();
    let enabled_sites = settings::enabled_scrape_sites(&app_settings.scrape);
    let enabled_site_ids: Vec<String> = enabled_sites.iter().map(|site| site.id.clone()).collect();
    let fetch_settings = settings::resolve_scrape_fetch_settings(&app_settings.scrape);

    // 根据 source 参数和启用状态过滤数据源
    let search_sources: Vec<Box<dyn Source>> = if let Some(ref site_id) = source {
        sources::all_sources()
            .into_iter()
            .filter(|s| {
                let source_name = s.name().to_lowercase();
                let requested = site_id.to_lowercase();
                let source_matches = source_name == requested || requested == source_name.replace(" ", "");
                let enabled = enabled_site_ids.iter().any(|id| id.eq_ignore_ascii_case(s.name()));
                source_matches && enabled
            })
            .collect()
    } else {
        sources::all_sources()
            .into_iter()
            .filter(|s| enabled_site_ids.iter().any(|id| id.eq_ignore_ascii_case(s.name())))
            .collect()
    };

    if search_sources.is_empty() {
        println!("[搜索] 未找到可用数据源 {:?}，已启用网站: {:?}", source, enabled_site_ids);
        let _ = app.emit("search-done", ());
        return Ok(());
    }

    let total = search_sources.len();
    let max_concurrent = (app_settings.scrape.concurrent.max(1) as usize).min(total);
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(max_concurrent));
    println!("[搜索] 最大并发数: {}，数据源总数: {}", max_concurrent, total);

    // 并发请求所有数据源（受 semaphore 限制）
    let mut handles = Vec::new();
    for source in search_sources {
        let client = http_client.clone();
        let fetcher = Fetcher::new(client.clone());
        let code = code.clone();
        let app = app.clone();
        let token = token.clone();
        let semaphore = semaphore.clone();
        let site = enabled_sites
            .iter()
            .find(|item| item.id.eq_ignore_ascii_case(source.name()))
            .cloned()
            .unwrap_or(ResourceSite {
                id: source.name().to_string(),
                name: source.name().to_string(),
                enabled: true,
            });
        let handle = tokio::spawn(async move {
            let name = source.name().to_string();

            // 检查是否已取消
            if token.is_cancelled() {
                println!("[搜索] {} 已取消，跳过", name);
                return;
            }

            // 获取并发许可
            let _permit = match semaphore.acquire().await {
                Ok(permit) => permit,
                Err(_) => {
                    println!("[搜索] {} 信号量已关闭，跳过", name);
                    return;
                }
            };

            // 获取许可后再次检查取消
            if token.is_cancelled() {
                println!("[搜索] {} 已取消，跳过", name);
                return;
            }

            let url = source.build_url(&code);
            println!("[搜索] 请求数据源 {}: {}", name, url);

            let fetch_options = super::fetcher::FetchOptions {
                webview_enabled: fetch_settings.webview_enabled,
                webview_fallback_enabled: fetch_settings.webview_fallback_enabled,
                show_webview: fetch_settings.dev_show_webview,
                max_webview_windows: fetch_settings.max_webview_windows,
            };

            match fetcher.fetch(&app, &url, &site, fetch_options).await {
                Ok(html) => {
                    // 取消检查
                    if token.is_cancelled() {
                        println!("[搜索] {} 已取消，丢弃结果", name);
                        return;
                    }

                    let final_url = url.clone();
                    println!("[搜索] {} 最终URL: {}", name, final_url);
                    println!("[搜索] {} 返回 {} 字符", name, html.len());
                    println!("[搜索] {} 内容摘要: {}", name, preview_html(&html));

                    // 检查是否需要二次请求详情页
                    let (parse_html, page_url) = if let Some(detail) =
                        source.extract_detail_url(&html, &code)
                    {
                        let detail = normalize_result_url(&detail, &final_url);
                        println!("[搜索] {} 需要二次请求: {}", name, detail);
                        match fetcher.fetch(&app, &detail, &site, fetch_options).await {
                            Ok(dh) => {
                                println!("[搜索] {} 详情页 {} 返回 {} 字符", name, detail, dh.len());
                                println!("[搜索] {} 详情页内容摘要: {}", name, preview_html(&dh));
                                (dh, detail)
                            }
                            Err(e) => {
                                println!("[搜索] {} 详情页请求失败: {}，回退到搜索页", name, e);
                                (html, final_url.clone())
                            }
                        }
                    } else {
                        (html, final_url.clone())
                    };

                    if let Some(mut result) = source.parse(&parse_html, &code) {
                        if !is_valid_search_result(&result) {
                            println!("[搜索] {} 结果无效，已过滤: {}", name, result.title);
                        } else {
                        result.page_url = page_url.clone();
                        normalize_search_result_urls(&mut result, &page_url);

                        if !result.thumbs.is_empty() {
                            let (display_thumbs, remote_thumbs) = proxy_preview_images_to_files(
                                &client,
                                &result.thumbs,
                                page_url.as_str(),
                            )
                            .await;
                            result.thumbs = display_thumbs;
                            result.remote_thumb_urls = remote_thumbs;
                        }

                        // 对防盗链图片做后端代理（下载到临时文件，返回本地路径）
                        if result.cover_url.starts_with("http://")
                            || result.cover_url.starts_with("https://")
                        {
                            let referer_url = page_url.as_str();
                            match proxy_image_to_file(&client, &result.cover_url, referer_url).await
                            {
                                Ok(local_path) => {
                                    // 保留原始远程 URL，同时提供本地缓存路径
                                    result.remote_cover_url = Some(result.cover_url.clone());
                                    result.cover_url = local_path;
                                }
                                Err(e) => {
                                    println!("[搜索] {} 封面代理失败: {}", name, e);
                                }
                            }
                        }
                        println!("[搜索] {} 解析成功: {}", name, result.title);

                        // 如果开启了翻译，先翻译再 emit 给前端
                        let mut result_to_emit = match crate::utils::ai_translator::translate_search_result(&app, &result).await {
                            Ok(translated) => {
                                println!("[搜索] {} 已应用 AI 翻译", name);
                                translated
                            }
                            Err(e) => {
                                println!("[搜索] {} AI 翻译跳过: {}", name, e);
                                result
                            }
                        };
                        enrich_search_result_detail(&mut result_to_emit);
                        if !token.is_cancelled() {
                            let _ = app.emit("search-result", &result_to_emit);
                        }
                        }
                    } else {
                        println!("[搜索] {} 解析无结果", name);
                    }
                }
                Err(e) => {
                    println!("[搜索] {} 请求失败: {}", name, e);
                }
            }
        });
        handles.push(handle);
    }

    // 等待所有任务完成
    for handle in handles {
        let _ = handle.await;
    }

    // 清理取消令牌
    {
        let mut guard = search_cancel.token.lock().await;
        // 仅清理本次搜索创建的令牌（避免误清新搜索的令牌）
        if guard.as_ref().map(|t| t.is_cancelled()) == Some(token.is_cancelled()) {
            *guard = None;
        }
    }

    if token.is_cancelled() {
        println!("[搜索] 搜索已被用户取消");
    } else {
        println!("[搜索] 全部完成（{} 个数据源）", total);
    }
    let _ = app.emit("search-done", ());
    Ok(())
}

/// 取消当前搜索：取消令牌 + 关闭所有刮削 WebView 窗口
#[tauri::command]
pub async fn rs_cancel_search(
    app: AppHandle,
    search_cancel: tauri::State<'_, SearchCancelState>,
) -> Result<(), String> {
    println!("[搜索] 收到取消搜索请求");

    // 取消令牌
    {
        let mut guard = search_cancel.token.lock().await;
        if let Some(token) = guard.take() {
            token.cancel();
        }
    }

    // 关闭所有刮削 WebView 窗口
    let pool = app.state::<super::fetcher::WebviewPoolState>();
    pool.close_all(&app);

    // 通知前端搜索已完成（停止 loading 状态）
    let _ = app.emit("search-done", ());

    println!("[搜索] 搜索已取消，WebView 窗口已关闭");
    Ok(())
}

/// 图片代理：后端下载图片并返回本地缓存文件路径
///
/// 用于解决防盗链问题（如 projectjav 的封面图）
#[tauri::command]
pub async fn rs_proxy_image(url: String) -> Result<String, String> {
    let client = client::create_client()?;

    // 从 URL 中提取域名作为 Referer
    let referer = url
        .find("://")
        .and_then(|i| {
            let after = &url[i + 3..];
            after.find('/').map(|j| &url[..i + 3 + j])
        })
        .unwrap_or(&url);

    proxy_image_to_file(&client, &url, referer).await
}

/// 获取资源网站列表
///
/// 返回所有支持的资源网站及其配置信息。
#[tauri::command]
pub async fn get_resource_sites() -> Result<Vec<ResourceSite>, String> {
    Ok(sources::default_sites())
}

/// 全局自增 ID，用于生成唯一的缓存文件名
static CACHE_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 获取图片缓存目录（系统临时目录下的子目录）
fn get_image_cache_dir() -> Result<PathBuf, String> {
    let cache_dir = std::env::temp_dir().join("jav_image_cache");
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("创建图片缓存目录失败: {}", e))?;
    Ok(cache_dir)
}

/// 图片代理：下载图片到本地临时文件，返回本地文件路径
///
/// 替代原来的 base64 data URL 方案，避免大字符串在 Tauri 事件中传输导致的问题。
/// 前端使用 convertFileSrc() 将本地路径转为可访问的 URL。
async fn proxy_image_to_file(
    client: &reqwest::Client,
    url: &str,
    referer: &str,
) -> Result<String, String> {
    let resp = client
        .get(url)
        .header("Referer", referer)
        .header(
            "Accept",
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        )
        .header("Sec-Fetch-Dest", "image")
        .header("Sec-Fetch-Mode", "no-cors")
        .header("Sec-Fetch-Site", "same-origin")
        .send()
        .await
        .map_err(|e| format!("图片请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取图片失败: {}", e))?;

    if bytes.is_empty() {
        return Err("下载的图片数据为空".to_string());
    }

    // 生成唯一文件名
    let counter = CACHE_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let filename = format!("cover_{}_{}.jpg", timestamp, counter);

    let cache_dir = get_image_cache_dir()?;
    let file_path = cache_dir.join(&filename);

    std::fs::write(&file_path, &bytes).map_err(|e| format!("写入缓存文件失败: {}", e))?;

    Ok(file_path.to_string_lossy().to_string())
}

// ==================== 刮削保存 ====================

use super::types::SearchResult;
use crate::db::Database;
use crate::resource_scrape::types::ScrapeMetadata;
use serde::{Deserialize, Serialize};

/// 刮削保存结果
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScrapeSaveResult {
    /// 封面是否保存成功
    pub cover_saved: bool,
    /// NFO 是否保存成功
    pub nfo_saved: bool,
    /// 数据库是否更新成功
    pub db_updated: bool,
    /// 各步骤的错误信息
    pub errors: Vec<String>,
}

/// 将 SearchResult 转换为 ScrapeMetadata
///
/// 用于复用 NfoGenerator 和 DatabaseWriter。
/// 也被 queue_manager 使用。
pub fn search_result_to_metadata(sr: &SearchResult) -> ScrapeMetadata {
    ScrapeMetadata {
        title: sr.title.clone(),
        local_id: sr.code.clone(),
        original_title: sr
            .original_title
            .clone()
            .or_else(|| (!sr.title.is_empty()).then(|| sr.title.clone())),
        plot: sr.plot.clone(),
        outline: if sr.outline.is_empty() {
            sr.plot.clone()
        } else {
            sr.outline.clone()
        },
        original_plot: if sr.original_plot.is_empty() {
            sr.plot.clone()
        } else {
            sr.original_plot.clone()
        },
        tagline: sr.tagline.clone(),
        studio: sr.studio.clone(),
        premiered: sr.premiered.clone(),
        duration: parse_duration_minutes(&sr.duration),
        poster_url: if sr.poster_url.is_empty() {
            sr.cover_url.clone()
        } else {
            sr.poster_url.clone()
        },
        cover_url: if sr.cover_url.is_empty() {
            sr.poster_url.clone()
        } else {
            sr.cover_url.clone()
        },
        actors: sr
            .actors
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        director: sr.director.clone(),
        score: sr.rating,
        critic_rating: sr.critic_rating,
        sort_title: sr.sort_title.clone(),
        mpaa: sr.mpaa.clone(),
        custom_rating: sr.custom_rating.clone(),
        country_code: sr.country_code.clone(),
        set_name: sr.set_name.clone(),
        maker: sr.maker.clone(),
        publisher: sr.publisher.clone(),
        label: sr.label.clone(),
        tags: sr
            .tags
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        genres: sr
            .genres
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        thumbs: sr
            .remote_thumb_urls
            .clone()
            .unwrap_or_else(|| sr.thumbs.clone()),
    }
}

/// 从时长字符串中解析分钟数
///
/// 支持格式："120分钟"、"120 min"、"120"
fn parse_duration_minutes(duration: &str) -> Option<i64> {
    let trimmed = duration.trim();
    if trimmed.is_empty() {
        return None;
    }
    // 提取数字部分
    let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<i64>().ok()
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedScrapeVideo {
    pub video_path: String,
    pub poster: Option<String>,
}

pub(crate) fn prepare_video_for_scrape_save(
    db: &Database,
    video_id: &str,
) -> Result<PreparedScrapeVideo, String> {
    prepare_video_for_scrape_save_with_target_title(db, video_id, None)
}

#[cfg(test)]
mod tests {
    use super::normalize_result_url;

    #[test]
    fn normalize_result_url_resolves_relative_detail_link() {
        let resolved = normalize_result_url(
            "/jav/start-521-1-1.html",
            "https://jav.sb/vod/search.html?wd=start-521",
        );

        assert_eq!(resolved, "https://jav.sb/jav/start-521-1-1.html");
    }

    #[test]
    fn normalize_result_url_keeps_absolute_detail_link() {
        let resolved = normalize_result_url(
            "https://jav.sb/jav/start-521-1-1.html",
            "https://jav.sb/vod/search.html?wd=start-521",
        );

        assert_eq!(resolved, "https://jav.sb/jav/start-521-1-1.html");
    }
}

pub(crate) fn prepare_video_for_scrape_save_with_target_title(
    db: &Database,
    video_id: &str,
    target_title: Option<&str>,
) -> Result<PreparedScrapeVideo, String> {
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

    if let Some(target_title) = target_title.map(str::trim).filter(|value| !value.is_empty()) {
        let relocated = crate::utils::media_assets::rename_video_assets_with_title(
            &video_path,
            target_title,
            poster.as_deref(),
            thumb.as_deref(),
            fanart.as_deref(),
        )?;

        if let Some(relocated) = relocated {
            crate::db::Database::update_video_file_location(
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

            println!(
                "[刮削保存] 已按目标标题调整文件路径: {}",
                relocated.video_path
            );

            return Ok(PreparedScrapeVideo {
                video_path: relocated.video_path,
                poster: relocated.poster,
            });
        }
    }

    let relocated = crate::utils::media_assets::ensure_video_in_named_parent_dir(
        &video_path,
        poster.as_deref(),
        thumb.as_deref(),
        fanart.as_deref(),
    )?;

    if let Some(relocated) = relocated {
        crate::db::Database::update_video_file_location(
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

        println!(
            "[刮削保存] 已将视频迁移到同名目录: {}",
            relocated.video_path
        );

        return Ok(PreparedScrapeVideo {
            video_path: relocated.video_path,
            poster: relocated.poster,
        });
    }

    Ok(PreparedScrapeVideo {
        video_path,
        poster,
    })
}

/// 刮削保存：从搜索结果保存元数据到本地
///
/// 执行三个步骤（步骤级错误容忍）：
/// 1. 下载封面图片到视频所在目录
/// 2. 生成 NFO 文件到视频所在目录
/// 3. 更新数据库中对应视频的元数据
///
/// 任何步骤失败不会中断后续步骤，最终返回部分完成状态。
#[tauri::command]
pub async fn rs_scrape_save(
    app: AppHandle,
    video_id: String,
    metadata: SearchResult,
) -> Result<ScrapeSaveResult, String> {
    println!("[刮削保存] 开始保存 video_id={}", video_id);
    println!(
        "[刮削保存] metadata.code={}, metadata.title={}",
        metadata.code, metadata.title
    );
    println!(
        "[刮削保存] metadata.cover_url 长度={}, 前缀={}",
        metadata.cover_url.len(),
        if metadata.cover_url.len() > 50 {
            &metadata.cover_url[..50]
        } else {
            &metadata.cover_url
        }
    );
    let db = Database::new(&app);
    let prepared_video = prepare_video_for_scrape_save_with_target_title(
        &db,
        &video_id,
        metadata.target_title.as_deref(),
    )?;
    let video_path = prepared_video.video_path.clone();
    println!("[刮削保存] video_path={}", video_path);

    let mut scrape_meta = search_result_to_metadata(&metadata);
    match crate::utils::ai_translator::translate_scrape_metadata(&app, &scrape_meta).await {
        Ok(translated) => {
            scrape_meta = translated;
            println!("[刮削保存] 已应用 AI 翻译（若命中日语/英语）");
        }
        Err(e) => {
            println!("[刮削保存] AI 翻译跳过: {}", e);
        }
    }

    let mut result = ScrapeSaveResult {
        cover_saved: false,
        nfo_saved: false,
        db_updated: false,
        errors: vec![],
    };

    // 步骤 1: 下载封面（失败不中断）
    let local_cover_path = if !metadata.cover_url.is_empty() {
        println!(
            "[刮削保存] 开始下载封面, URL 类型: {}",
            if metadata.cover_url.starts_with("data:") {
                "data URL (base64)"
            } else if metadata.cover_url.starts_with("http") {
                "HTTP URL"
            } else {
                "未知"
            }
        );
        match crate::download::image::download_cover(&video_path, &metadata.cover_url, None).await {
            Ok(path) => {
                result.cover_saved = true;
                println!("[刮削保存] 封面下载成功: {}", path);
                path
            }
            Err(e) => {
                let msg = format!("封面下载失败: {}", e);
                println!("[刮削保存] {}", msg);
                result.errors.push(msg);
                prepared_video.poster.clone().unwrap_or_default()
            }
        }
    } else {
        println!("[刮削保存] 无封面 URL，跳过下载");
        prepared_video.poster.clone().unwrap_or_default()
    };

    // 步骤 2: 下载预览图到 extrafanart（失败不中断）
    if !scrape_meta.thumbs.is_empty() {
        let preview_items: Vec<(usize, String)> = scrape_meta
            .thumbs
            .iter()
            .enumerate()
            .map(|(index, url)| (index + 1, url.clone()))
            .collect();

        if let Err(e) = crate::utils::media_assets::sync_extrafanart_from_urls(
            &video_path,
            preview_items,
        )
        .await
        {
            let msg = format!("预览图下载失败: {}", e);
            println!("[刮削保存] {}", msg);
            result.errors.push(msg);
        }
    }

    // 步骤 3: 生成 NFO（失败不中断）
    {
        match crate::utils::media_assets::save_nfo_for_video(&video_path, &scrape_meta) {
            Ok(_) => {
                result.nfo_saved = true;
                println!("[刮削保存] NFO 生成成功");
            }
            Err(e) => {
                let msg = format!("NFO 生成失败: {}", e);
                println!("[刮削保存] {}", msg);
                result.errors.push(msg);
            }
        }
    }

    // 步骤 3: 更新数据库（失败不中断）
    {
        let writer = super::database_writer::DatabaseWriter::new(&db);
        match writer
            .write_all(
                video_id.clone(),
                scrape_meta,
                local_cover_path,
            )
            .await
        {
            Ok(_) => {
                result.db_updated = true;
                println!("[刮削保存] 数据库更新成功");
            }
            Err(e) => {
                let msg = format!("数据库更新失败: {}", e);
                println!("[刮削保存] {}", msg);
                result.errors.push(msg);
            }
        }
    }

    // 通知前端
    let _ = app.emit("scrape-save-done", &result);
    Ok(result)
}

// ==================== 批量刮削命令 ====================

use super::detector::ScrapedVideoDetector;
use super::queue_manager::TaskQueueManager;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;
use uuid::Uuid;

/// 任务队列全局状态管理（resource_scrape 版本）
pub struct RsTaskQueueState {
    pub manager: Arc<Mutex<Option<TaskQueueManager>>>,
}

impl RsTaskQueueState {
    pub fn new() -> Self {
        Self {
            manager: Arc::new(Mutex::new(None)),
        }
    }
}

/// 获取所有刮削任务列表
#[tauri::command]
pub async fn rs_get_scrape_tasks(app: AppHandle) -> Result<Vec<crate::db::ScrapeTask>, String> {
    let db = Database::new(&app);
    db.get_all_scrape_tasks().await.map_err(|e| e.to_string())
}

/// 创建过滤后的刮削任务
///
/// 扫描目录并仅为未刮削的视频创建刮削任务。
/// 跳过已刮削（scan_status = 2）和已有活跃任务的视频。
#[tauri::command]
pub async fn rs_create_filtered_scrape_tasks(
    app: AppHandle,
    path: String,
) -> Result<usize, String> {
    if path.trim().is_empty() {
        return Err("目录路径不能为空".to_string());
    }

    let db = Database::new(&app);

    let files = crate::scanner::file_scanner::find_video_files(&path, usize::MAX)
        .await
        .map_err(|e| format!("扫描目录失败: {}", e))?;

    if files.is_empty() {
        return Err("目录中未找到视频文件".to_string());
    }

    let mut tasks_to_create = Vec::new();

    for file_path in files {
        // 跳过已有活跃任务的视频
        if db
            .scrape_task_exists_active(&file_path)
            .map_err(|e| e.to_string())?
        {
            continue;
        }
        // 跳过已完全刮削的视频
        if db
            .is_video_completely_scraped(&file_path)
            .map_err(|e| e.to_string())?
        {
            continue;
        }
        let id = Uuid::new_v4().to_string();
        tasks_to_create.push((id, file_path));
    }

    let created_count = db
        .create_scrape_tasks_batch(tasks_to_create)
        .await
        .map_err(|e| format!("批量创建任务失败: {}", e))?;

    Ok(created_count)
}

/// 启动任务队列 - 按顺序处理所有 waiting 状态的任务
#[tauri::command]
pub async fn rs_start_task_queue(
    app: AppHandle,
    queue_state: State<'_, RsTaskQueueState>,
) -> Result<(), String> {
    let mut state = queue_state.manager.lock().await;

    // 检查是否已有运行中的队列
    if let Some(existing_manager) = state.as_ref() {
        if existing_manager.is_running().await {
            return Err("任务队列正在运行中".to_string());
        }
    }

    // 创建新的队列管理器
    let manager = TaskQueueManager::new(app.clone());
    *state = Some(manager.clone());
    drop(state); // 释放锁

    // 在后台启动队列处理
    tauri::async_runtime::spawn(async move {
        if let Err(e) = manager.start().await {
            eprintln!("Queue processing error: {}", e);
            manager.set_running(false).await;
        }
    });

    Ok(())
}

/// 停止任务队列
#[tauri::command]
pub async fn rs_stop_task_queue(queue_state: State<'_, RsTaskQueueState>) -> Result<(), String> {
    let state = queue_state.manager.lock().await;
    if let Some(manager) = state.as_ref() {
        manager.stop().await;
    }
    Ok(())
}

/// 停止指定的刮削任务
#[tauri::command]
pub async fn rs_stop_scrape_task(
    app: AppHandle,
    task_id: String,
    queue_state: State<'_, RsTaskQueueState>,
) -> Result<(), String> {
    if task_id.trim().is_empty() {
        return Err("任务 ID 不能为空".to_string());
    }

    let db = Database::new(&app);
    db.stop_task(&task_id).await.map_err(|e| e.to_string())?;

    // 如果是当前运行的任务，停止队列
    let state = queue_state.manager.lock().await;
    if let Some(manager) = state.as_ref() {
        if manager.current_task().await == Some(task_id) {
            manager.stop().await;
        }
    }

    Ok(())
}

/// 重置刮削任务状态
#[tauri::command]
pub async fn rs_reset_scrape_task(app: AppHandle, task_id: String) -> Result<(), String> {
    if task_id.trim().is_empty() {
        return Err("任务 ID 不能为空".to_string());
    }

    let db = Database::new(&app);
    db.reset_task(&task_id).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除指定的刮削任务
#[tauri::command]
pub async fn rs_delete_scrape_task(app: AppHandle, task_id: String) -> Result<(), String> {
    if task_id.trim().is_empty() {
        return Err("任务 ID 不能为空".to_string());
    }

    let db = Database::new(&app);
    db.delete_scrape_task(&task_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除所有已完成的任务
#[tauri::command]
pub async fn rs_delete_completed_scrape_tasks(app: AppHandle) -> Result<usize, String> {
    let db = Database::new(&app);
    let count = db
        .delete_completed_tasks()
        .await
        .map_err(|e| e.to_string())?;
    Ok(count)
}

/// 删除所有失败的任务
#[tauri::command]
pub async fn rs_delete_failed_scrape_tasks(app: AppHandle) -> Result<usize, String> {
    let db = Database::new(&app);
    let count = db
        .delete_failed_scrape_tasks()
        .await
        .map_err(|e| e.to_string())?;
    Ok(count)
}

/// 删除全部任务
#[tauri::command]
pub async fn rs_delete_all_scrape_tasks(app: AppHandle) -> Result<usize, String> {
    let db = Database::new(&app);
    let count = db
        .delete_all_scrape_tasks()
        .await
        .map_err(|e| e.to_string())?;
    Ok(count)
}

/// 检查视频是否已完全刮削
///
/// 验证：数据库 scan_status = 2、NFO 文件存在、封面图片存在
#[tauri::command]
pub async fn rs_check_video_completely_scraped(
    app: AppHandle,
    video_path: String,
) -> Result<bool, String> {
    use std::path::Path;

    if video_path.trim().is_empty() {
        return Err("视频路径不能为空".to_string());
    }

    let db = Database::new(&app);
    let detector = ScrapedVideoDetector::new(&db);

    let is_scraped = detector.is_video_scraped(&video_path)?;
    if !is_scraped {
        return Ok(false);
    }

    let video_path_obj = Path::new(&video_path);
    let nfo_path = video_path_obj.with_extension("nfo");
    if !nfo_path.exists() {
        return Ok(false);
    }

    let has_cover = db.has_cover_image(&video_path).map_err(|e| e.to_string())?;
    Ok(has_cover)
}

/// 查找视频下载链接 - 打开 WebView 窗口
///
/// 通过 WebView 访问指定视频网站，注入 JS 拦截网络请求，
/// 捕获的视频链接通过 `video-finder-link` 事件推送给前端。
#[tauri::command]
pub async fn rs_find_video_links(
    app: AppHandle,
    code: String,
    site_id: Option<String>,
) -> Result<(), String> {
    let code = code.trim().to_uppercase();
    if code.is_empty() {
        return Err("番号不能为空".to_string());
    }
    let site = site_id.unwrap_or_else(|| "missav".to_string());
    println!(
        "[rs_find_video_links] 打开 WebView 查找: {} (网站: {})",
        code, site
    );
    analytics::record_search_resource_link(&app);
    super::video_finder::open_video_finder_webview(&app, &code, &site)
}

/// 关闭视频查找 WebView 窗口
#[tauri::command]
pub async fn rs_close_video_finder(app: AppHandle) -> Result<(), String> {
    super::video_finder::close_video_finder_webview(&app)
}

/// 获取支持的视频网站列表
#[tauri::command]
pub async fn rs_get_video_sites() -> Result<Vec<super::video_finder::VideoSite>, String> {
    Ok(super::video_finder::get_video_sites())
}

/// 验证链接是否为 HLS 播放列表，并判断是否为 VOD
#[tauri::command]
pub async fn rs_verify_hls(
    url: String,
    referer: Option<String>,
) -> Result<super::video_finder::HlsVerifyResult, String> {
    Ok(super::video_finder::verify_hls(&url, referer.as_deref()).await)
}

// ==================== 批量截图封面命令 ====================

/// 批量截图封面全局状态（共享同一个 manager 实例）
pub struct CoverCaptureState {
    pub manager: Arc<Mutex<Option<super::cover_capture::CoverCaptureManager>>>,
}

impl CoverCaptureState {
    pub fn new() -> Self {
        Self {
            manager: Arc::new(Mutex::new(None)),
        }
    }
}

/// 获取所有截图封面任务（从数据库读取）
#[tauri::command]
pub async fn rs_get_cover_capture_tasks(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let db = Database::new(&app);
    db.get_all_cover_capture_tasks()
        .await
        .map_err(|e| e.to_string())
}

/// 获取目录下所有没有封面的视频列表
#[tauri::command]
pub async fn rs_get_videos_without_cover(
    app: AppHandle,
    path: String,
) -> Result<Vec<serde_json::Value>, String> {
    if path.trim().is_empty() {
        return Err("目录路径不能为空".to_string());
    }

    let files = crate::scanner::file_scanner::find_video_files(&path, usize::MAX)
        .await
        .map_err(|e| format!("扫描目录失败: {}", e))?;

    if files.is_empty() {
        return Err("目录中未找到视频文件".to_string());
    }

    let db = Database::new(&app);
    let conn = db.get_connection().map_err(|e| e.to_string())?;

    let mut results = Vec::new();

    for file_path in files {
        // 查询数据库中该视频是否有封面
        let row: Option<(String, Option<String>)> =
            Database::get_video_id_and_cover(&conn, &file_path).ok();

        match row {
            Some((video_id, poster_path)) => {
                // 检查封面文件是否真实存在
                let has_cover = poster_path
                    .as_ref()
                    .map(|p| std::path::Path::new(p).exists())
                    .unwrap_or(false);

                if !has_cover {
                    results.push(serde_json::json!({
                        "videoId": video_id,
                        "videoPath": file_path,
                    }));
                }
            }
            None => {
                // 视频不在数据库中，跳过
            }
        }
    }

    Ok(results)
}

/// 为目录下无封面视频创建截图封面任务（持久化到数据库）
#[tauri::command]
pub async fn rs_create_cover_capture_tasks(app: AppHandle, path: String) -> Result<usize, String> {
    let videos = rs_get_videos_without_cover(app.clone(), path).await?;

    if videos.is_empty() {
        return Ok(0);
    }

    let db = Database::new(&app);
    let tasks: Vec<(String, String, String)> = videos
        .iter()
        .map(|v| {
            let id = Uuid::new_v4().to_string();
            let video_id = v["videoId"].as_str().unwrap_or("").to_string();
            let video_path = v["videoPath"].as_str().unwrap_or("").to_string();
            (id, video_id, video_path)
        })
        .filter(|(_, vid, vp)| !vid.is_empty() && !vp.is_empty())
        .collect();

    let count = db
        .create_cover_capture_tasks_batch(tasks)
        .await
        .map_err(|e| format!("创建截图任务失败: {}", e))?;

    Ok(count)
}

/// 批量截图封面 - 启动处理所有 waiting 状态的任务
#[tauri::command]
pub async fn rs_batch_capture_covers(
    app: AppHandle,
    concurrency: Option<usize>,
    capture_state: State<'_, CoverCaptureState>,
) -> Result<(), String> {
    let concurrency = concurrency.unwrap_or(4).min(8).max(1);

    // 从数据库读取所有 waiting 和 failed 状态的任务
    let db = Database::new(&app);
    let all_tasks = db
        .get_all_cover_capture_tasks()
        .await
        .map_err(|e| e.to_string())?;

    let tasks: Vec<super::cover_capture::CoverCaptureTask> = all_tasks
        .iter()
        .filter(|t| {
            let status = t["status"].as_str().unwrap_or("");
            status == "waiting" || status == "failed"
        })
        .map(|t| super::cover_capture::CoverCaptureTask {
            id: t["id"].as_str().unwrap_or("").to_string(),
            video_id: t["videoId"].as_str().unwrap_or("").to_string(),
            video_path: t["videoPath"].as_str().unwrap_or("").to_string(),
            status: "waiting".to_string(),
            cover_path: None,
            error: None,
        })
        .filter(|t| !t.video_id.is_empty() && !t.video_path.is_empty())
        .collect();

    if tasks.is_empty() {
        return Err("没有等待处理的任务".to_string());
    }

    // 重置 failed 任务状态为 waiting
    if let Ok(conn) = db.get_connection() {
        let _ = Database::reset_failed_cover_capture_tasks(&conn);
    }

    // 创建 manager 并存入全局状态（共享同一实例）
    let manager = super::cover_capture::CoverCaptureManager::new(app.clone());
    {
        let mut state = capture_state.manager.lock().await;
        *state = Some(manager.clone());
    }

    // 在后台启动批量截图
    tauri::async_runtime::spawn(async move {
        if let Err(e) = manager.batch_capture(tasks, concurrency).await {
            eprintln!("[批量截图封面] 执行失败: {}", e);
        }
    });

    Ok(())
}

/// 停止批量截图封面
#[tauri::command]
pub async fn rs_stop_cover_capture(
    capture_state: State<'_, CoverCaptureState>,
) -> Result<(), String> {
    let state = capture_state.manager.lock().await;
    if let Some(manager) = state.as_ref() {
        manager.stop().await;
        Ok(())
    } else {
        Err("没有运行中的截图任务".to_string())
    }
}

/// 删除已完成的截图封面任务
#[tauri::command]
pub async fn rs_delete_completed_cover_tasks(app: AppHandle) -> Result<usize, String> {
    let db = Database::new(&app);
    db.delete_completed_cover_capture_tasks()
        .await
        .map_err(|e| e.to_string())
}

/// 删除失败的截图封面任务及其对应的本地视频文件
#[tauri::command]
pub async fn rs_delete_failed_cover_tasks(app: AppHandle) -> Result<usize, String> {
    let db = Database::new(&app);
    db.delete_failed_cover_capture_tasks()
        .await
        .map_err(|e| e.to_string())
}

/// 删除全部截图封面任务
#[tauri::command]
pub async fn rs_delete_all_cover_tasks(app: AppHandle) -> Result<usize, String> {
    let db = Database::new(&app);
    db.delete_all_cover_capture_tasks()
        .await
        .map_err(|e| e.to_string())
}

/// 删除单个截图封面任务
#[tauri::command]
pub async fn rs_delete_cover_task(app: AppHandle, video_id: String) -> Result<usize, String> {
    let db = Database::new(&app);
    db.delete_cover_capture_task(&video_id)
        .await
        .map_err(|e| e.to_string())
}

/// 重试单个截图封面任务
#[tauri::command]
pub async fn rs_retry_cover_task(app: AppHandle, video_id: String) -> Result<(), String> {
    let db = Database::new(&app);
    db.retry_cover_capture_task(&video_id)
        .await
        .map_err(|e| e.to_string())
}

// ==================== 资源链接下载查重 ====================

/// 根据影片番号(code)检查本地库中是否已经存在
#[tauri::command]
pub async fn rs_check_video_exists_by_code(
    app: AppHandle,
    code: String,
) -> Result<serde_json::Value, String> {
    let db = Database::new(&app);

    // 调用 DB 内部方法
    match db.get_video_by_local_id(&code).await {
        Ok(Some(info)) => {
            // 将查询结果组装后返回 (剔除了前端展示时不需要的 FileSize 信息)
            Ok(serde_json::json!({
                "exists": true,
                "video": {
                    "id": info["id"],
                    "title": info["title"],
                    "videoPath": info["videoPath"]
                }
            }))
        }
        Ok(None) => Ok(serde_json::json!({ "exists": false })),
        Err(e) => Err(format!("查重检索失败: {}", e)),
    }
}
