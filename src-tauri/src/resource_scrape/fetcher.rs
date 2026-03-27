//! 双模式获取器
//!
//! 支持 HTTP 快速模式和 WebView 增强模式两种网页获取方式。
//! 根据资源网站配置和全局设置智能选择获取模式，
//! HTTP 失败时可自动回退到 WebView 模式。

use reqwest::Client;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Listener, Manager};

use super::cf_detection;
use super::client;
use super::sources::ResourceSite;
use super::webview_support;

#[derive(Debug, Clone, Copy)]
pub struct FetchOptions {
    pub webview_enabled: bool,
    pub webview_fallback_enabled: bool,
    pub show_webview: bool,
    pub max_webview_windows: usize,
}

/// 双模式获取器
pub struct Fetcher {
    /// 共享 HTTP 客户端
    http_client: Client,
}

/// WebView 获取超时时间（秒）
const WEBVIEW_TIMEOUT_SECS: u64 = 60;

/// Cloudflare 手动验证超时时间（秒）
const CF_MANUAL_TIMEOUT_SECS: u64 = 60;

/// 前端刮削 CF 状态事件
const RESOURCE_SCRAPE_CF_STATE_EVENT: &str = "resource-scrape-cf-state";

#[derive(Debug, Clone)]
struct WebviewSlot {
    label: String,
    site_id: String,
    in_use: bool,
    cf_active: bool,
}

#[derive(Debug, Default)]
struct WebviewPoolInner {
    slots: HashMap<String, WebviewSlot>,
    next_window_id: u64,
}

#[derive(Debug, Clone)]
struct WebviewLease {
    label: String,
    evicted_label: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CfStateSnapshot {
    pub site_id: Option<String>,
    pub active_count: usize,
}

pub struct WebviewPoolState {
    inner: Mutex<WebviewPoolInner>,
    notify: tokio::sync::Notify,
}

impl Default for WebviewPoolState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(WebviewPoolInner::default()),
            notify: tokio::sync::Notify::new(),
        }
    }
}

impl WebviewPoolState {
    async fn acquire(&self, site_id: &str, max_windows: usize) -> WebviewLease {
        let site_id = normalize_site_key(site_id);
        let max_windows = max_windows.max(1);

        loop {
            let lease = {
                let mut inner = lock_webview_pool(&self.inner);

                if let Some(slot) = inner.slots.get_mut(&site_id) {
                    if !slot.in_use {
                        slot.in_use = true;
                        Some(WebviewLease {
                            label: slot.label.clone(),
                            evicted_label: None,
                        })
                    } else {
                        None
                    }
                } else if inner.slots.len() < max_windows {
                    let label = next_webview_label(&mut inner);
                    inner.slots.insert(
                        site_id.clone(),
                        WebviewSlot {
                            label: label.clone(),
                            site_id: site_id.clone(),
                            in_use: true,
                            cf_active: false,
                        },
                    );
                    Some(WebviewLease {
                        label,
                        evicted_label: None,
                    })
                } else if let Some(evicted_site_id) = inner
                    .slots
                    .iter()
                    .find(|(_, slot)| !slot.in_use)
                    .map(|(site_id, _)| site_id.clone())
                {
                    let evicted_label = inner
                        .slots
                        .remove(&evicted_site_id)
                        .map(|slot| slot.label)
                        .unwrap_or_default();
                    let label = next_webview_label(&mut inner);
                    inner.slots.insert(
                        site_id.clone(),
                        WebviewSlot {
                            label: label.clone(),
                            site_id: site_id.clone(),
                            in_use: true,
                            cf_active: false,
                        },
                    );
                    Some(WebviewLease {
                        label,
                        evicted_label: Some(evicted_label),
                    })
                } else {
                    None
                }
            };

            if let Some(lease) = lease {
                return lease;
            }

            self.notify.notified().await;
        }
    }

    pub fn release(&self, label: &str) {
        let mut inner = lock_webview_pool(&self.inner);
        if let Some(slot) = inner.slots.values_mut().find(|slot| slot.label == label) {
            slot.in_use = false;
        }
        drop(inner);
        self.notify.notify_waiters();
    }

    pub fn update_cf_state(&self, label: &str, active: bool) -> CfStateSnapshot {
        let mut inner = lock_webview_pool(&self.inner);
        let mut site_id = None;

        if let Some(slot) = inner.slots.values_mut().find(|slot| slot.label == label) {
            slot.cf_active = active;
            site_id = Some(slot.site_id.clone());
        }

        let active_count = inner.slots.values().filter(|slot| slot.cf_active).count();
        CfStateSnapshot {
            site_id,
            active_count,
        }
    }

    /// 关闭所有刮削 WebView 窗口并释放所有槽位
    pub fn close_all(&self, app: &AppHandle) {
        let labels: Vec<String> = {
            let mut inner = lock_webview_pool(&self.inner);
            let labels: Vec<String> = inner.slots.values().map(|s| s.label.clone()).collect();
            inner.slots.clear();
            labels
        };
        for label in &labels {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.close();
            }
        }
        self.notify.notify_waiters();
    }
}

impl Fetcher {
    /// 创建新的获取器
    pub fn new(http_client: Client) -> Self {
        Self { http_client }
    }

    /// HTTP 模式获取网页 HTML
    ///
    /// 复用 client.rs 的 fetch_html，只返回 HTML 内容（忽略最终 URL）。
    pub async fn fetch_http(&self, url: &str) -> Result<String, String> {
        let (_final_url, html) = client::fetch_html(&self.http_client, url).await?;
        Ok(html)
    }

    /// WebView 模式获取网页 HTML
    ///
    /// 通过 Tauri WebView 窗口加载页面，等待渲染完成后提取完整 HTML。
    /// 步骤：
    /// 1. 创建或复用隐藏的 WebView 窗口
    /// 2. 导航到目标 URL
    /// 3. 遇到 Cloudflare 验证时自动显示窗口，验证完成后自动隐藏
    /// 4. 通过事件机制获取 document.documentElement.outerHTML
    /// 5. 超时 60 秒
    pub async fn fetch_webview(
        app: &AppHandle,
        url: &str,
        site: &ResourceSite,
        show_webview: bool,
        max_webview_windows: usize,
    ) -> Result<String, String> {
        use std::time::Instant;

        let pool = app.state::<WebviewPoolState>();
        let lease = pool.acquire(&site.id, max_webview_windows).await;
        let window = get_or_create_webview_window(
            app,
            url,
            &lease.label,
            &site.name,
            lease.evicted_label.as_deref(),
        )?;
        let effective_show_webview = should_keep_webview_visible(show_webview);
        webview_support::sync_window_visibility(&window, effective_show_webview);
        let snapshot = pool.update_cf_state(window.label(), false);
        webview_support::emit_cf_state(
            app,
            RESOURCE_SCRAPE_CF_STATE_EVENT,
            "idle",
            snapshot.site_id,
            snapshot.active_count,
        );

        let cf_event_name = webview_support::next_event_name("resource-scrape-cf-status");
        let html_event_name = webview_support::next_event_name("resource-scrape-html-result");
        let cf_listener_id = webview_support::listen_cf_visibility(
            app,
            &window,
            site,
            &cf_event_name,
            Some(RESOURCE_SCRAPE_CF_STATE_EVENT),
        );

        let cf_state = Arc::new(Mutex::new(CfChallengeState::default()));
        let cf_state_listener = cf_state.clone();
        let cf_state_listener_id = app.listen(cf_event_name.clone(), move |event| {
            let Ok(challenge_detected) = serde_json::from_str::<bool>(event.payload()) else {
                return;
            };

            let mut guard = match cf_state_listener.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };

            if challenge_detected {
                if !guard.active {
                    guard.active = true;
                    guard.detected_at = Some(Instant::now());
                }
            } else {
                guard.active = false;
                guard.detected_at = None;
            }
        });

        // 使用 oneshot channel 接收 HTML 结果
        let (tx, mut rx) = tokio::sync::oneshot::channel::<String>();
        let tx = std::sync::Mutex::new(Some(tx));

        // 监听 webview-html-result 事件（JS 端通过 __TAURI__.event.emit 发送）
        let listener_id = app.listen(html_event_name.clone(), move |event| {
            if let Some(tx) = tx.lock().unwrap().take() {
                // 事件 payload 是 JSON 字符串，需要反序列化
                let payload = event.payload().to_string();
                // payload 格式为 JSON 字符串 "\"<html>...\""，需要去掉外层引号
                let html = serde_json::from_str::<String>(&payload).unwrap_or(payload);
                let _ = tx.send(html);
            }
        });

        // 轮询等待页面就绪，然后通过 eval 触发事件发送 HTML
        let started_at = Instant::now();
        let js = webview_support::build_html_extract_script(&cf_event_name, &html_event_name);
        let mut attempt: u64 = 0;
        loop {
            attempt += 1;
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

            // 检测窗口是否被用户手动关闭
            if app.get_webview_window(window.label()).is_none() {
                println!("[WebView 获取] 窗口已被用户关闭，跳过该数据源");
                cleanup_webview_fetch_without_window(app, window.label(), listener_id, cf_listener_id, cf_state_listener_id, "failed");
                return Err("WebView 窗口已被用户关闭".to_string());
            }

            if let Err(e) = window.eval(&js) {
                if attempt % 20 == 0 {
                    println!("[WebView 获取] eval 失败 (第 {} 次): {}", attempt, e);
                }
                continue;
            }

            let (cf_active, cf_timeout_hit) = {
                let guard = match cf_state.lock() {
                    Ok(guard) => guard,
                    Err(_) => {
                        cleanup_webview_fetch(app, &window, listener_id, cf_listener_id, cf_state_listener_id, effective_show_webview, "failed");
                        return Err("WebView Cloudflare 状态同步失败".to_string());
                    }
                };

                let timeout_hit = guard.active
                    && guard
                        .detected_at
                        .map(|detected_at| detected_at.elapsed().as_secs() >= CF_MANUAL_TIMEOUT_SECS)
                        .unwrap_or(false);

                (guard.active, timeout_hit)
            };

            webview_support::sync_window_visibility(
                &window,
                effective_show_webview || cf_active,
            );

            if cf_timeout_hit {
                cleanup_webview_fetch(app, &window, listener_id, cf_listener_id, cf_state_listener_id, false, "timeout");
                return Err(format!("Cloudflare 手动验证超时（{}秒）", CF_MANUAL_TIMEOUT_SECS));
            }

            if !cf_active && started_at.elapsed().as_secs() >= WEBVIEW_TIMEOUT_SECS {
                cleanup_webview_fetch(app, &window, listener_id, cf_listener_id, cf_state_listener_id, false, "failed");
                return Err(format!("WebView 获取超时（{}秒）", WEBVIEW_TIMEOUT_SECS));
            }

            // 检查是否已收到结果
            match rx.try_recv() {
                Ok(html) => {
                    cleanup_webview_fetch(app, &window, listener_id, cf_listener_id, cf_state_listener_id, effective_show_webview, "idle");
                    return Ok(html);
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {
                    // 继续等待
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                    cleanup_webview_fetch(app, &window, listener_id, cf_listener_id, cf_state_listener_id, false, "failed");
                    return Err("WebView HTML 接收通道已关闭".to_string());
                }
            }
        }
    }

    /// 智能获取：始终先 HTTP，失败或内容明显不匹配时回退到 WebView
    ///
    /// 逻辑：
    /// 1. 始终先尝试 HTTP 获取
    /// 2. HTTP 失败且用户开启了 WebView 增强和回退 → 回退到 WebView
    /// 3. HTTP 成功但返回内容与目标番号明显不匹配 → 自动回退到 WebView
    pub async fn fetch(
        &self,
        app: &AppHandle,
        url: &str,
        site: &ResourceSite,
        options: FetchOptions,
    ) -> Result<String, String> {
        println!(
            "[获取] {} HTTP ({}) webview={} fallback={} visible={}",
            site.name,
            url,
            options.webview_enabled,
            options.webview_fallback_enabled,
            options.show_webview
        );

        match self.fetch_http(url).await {
            Ok(html) => {
                if let Some(reason) = webview_fallback_reason(url, &html) {
                    println!(
                        "[获取] {} HTTP 内容需要回退到 WebView: {}",
                        site.name,
                        reason,
                    );
                    if options.webview_fallback_enabled {
                        match Self::fetch_webview(
                            app,
                            url,
                            site,
                            options.show_webview,
                            options.max_webview_windows,
                        ).await {
                            Ok(webview_html) => Ok(webview_html),
                            Err(e) => {
                                println!(
                                    "[获取] {} WebView 回退失败，继续使用 HTTP 内容: {}",
                                    site.name,
                                    e
                                );
                                Ok(html)
                            }
                        }
                    } else {
                        println!(
                            "[获取] {} 已检测到需要 WebView，但未开启回退开关，继续使用 HTTP 内容",
                            site.name,
                        );
                        Ok(html)
                    }
                } else {
                    Ok(html)
                }
            }
            Err(err) => {
                // HTTP 4xx 客户端错误（如 404）表示资源不存在，WebView 重试无意义
                if is_http_client_error(&err) {
                    println!(
                        "[获取] {} HTTP 客户端错误，跳过 WebView 回退: {}",
                        site.name,
                        err
                    );
                    Err(err)
                } else if options.webview_fallback_enabled {
                    println!(
                        "[获取] {} HTTP 失败，回退到 WebView: {}",
                        site.name,
                        err
                    );
                    Self::fetch_webview(
                        app,
                        url,
                        site,
                        options.show_webview,
                        options.max_webview_windows,
                    ).await
                } else {
                    Err(err)
                }
            }
        }
    }
}

fn should_retry_with_webview(url: &str, html: &str) -> bool {
    let Some(designation) = extract_designation_from_url(url) else {
        return false;
    };

    let html_upper = html.to_uppercase();
    if html_upper.contains(&designation) {
        return false;
    }

    // 对于明确是番号详情页的 URL，如果返回 HTML 连目标番号都不包含，
    // 大概率是广告跳转页、反爬页或站点通用页。
    true
}

fn webview_fallback_reason(url: &str, html: &str) -> Option<&'static str> {
    if cf_detection::is_cloudflare_challenge_html(html) {
        return Some("命中 Cloudflare 验证页");
    }

    if should_retry_with_webview(url, html) {
        return Some("内容疑似错页或反爬页");
    }

    None
}

fn extract_designation_from_url(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let segment = parsed
        .path_segments()?
        .filter(|part| !part.is_empty())
        .next_back()?;
    if looks_like_designation(segment) {
        Some(segment.to_uppercase())
    } else {
        None
    }
}

fn looks_like_designation(value: &str) -> bool {
    value.contains('-')
        && value.chars().any(|c| c.is_ascii_alphabetic())
        && value.chars().any(|c| c.is_ascii_digit())
}

fn should_keep_webview_visible(show_webview: bool) -> bool {
    show_webview
}

#[derive(Debug, Default)]
struct CfChallengeState {
    active: bool,
    detected_at: Option<std::time::Instant>,
}

fn cleanup_webview_fetch(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    listener_id: tauri::EventId,
    cf_listener_id: tauri::EventId,
    cf_state_listener_id: tauri::EventId,
    keep_visible: bool,
    final_status: &'static str,
) {
    app.unlisten(listener_id);
    app.unlisten(cf_listener_id);
    app.unlisten(cf_state_listener_id);
    let pool = app.state::<WebviewPoolState>();
    let snapshot = pool.update_cf_state(window.label(), false);
    pool.release(window.label());
    webview_support::emit_cf_state(
        app,
        RESOURCE_SCRAPE_CF_STATE_EVENT,
        final_status,
        snapshot.site_id,
        snapshot.active_count,
    );
    if !keep_visible {
        let _ = window.close();
    } else {
        let _ = window.hide();
    }
}

/// 窗口已被关闭时的清理（无需再操作窗口本身）
fn cleanup_webview_fetch_without_window(
    app: &AppHandle,
    label: &str,
    listener_id: tauri::EventId,
    cf_listener_id: tauri::EventId,
    cf_state_listener_id: tauri::EventId,
    final_status: &'static str,
) {
    app.unlisten(listener_id);
    app.unlisten(cf_listener_id);
    app.unlisten(cf_state_listener_id);
    let pool = app.state::<WebviewPoolState>();
    let snapshot = pool.update_cf_state(label, false);
    pool.release(label);
    webview_support::emit_cf_state(
        app,
        RESOURCE_SCRAPE_CF_STATE_EVENT,
        final_status,
        snapshot.site_id,
        snapshot.active_count,
    );
}

/// 获取或创建隐藏的 WebView 窗口
///
/// 若窗口已存在则复用，通过 navigate 导航到新 URL，避免重复创建导致闪烁。
fn get_or_create_webview_window(
    app: &AppHandle,
    url: &str,
    label: &str,
    site_name: &str,
    evicted_label: Option<&str>,
) -> Result<tauri::WebviewWindow, String> {
    use tauri::WebviewUrl;
    use tauri::WebviewWindowBuilder;

    if let Some(evicted_label) = evicted_label {
        if let Some(window) = app.get_webview_window(evicted_label) {
            let _ = window.close();
        }
    }

    let parsed_url: url::Url = url.parse().map_err(|e: url::ParseError| {
        format!("URL 解析失败: {}", e)
    })?;

    // 复用已有窗口：直接导航到新 URL，保留 session/cookies
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.hide();
        window
            .navigate(parsed_url)
            .map_err(|e| format!("WebView 导航失败: {}", e))?;
        let _ = window.set_title(&format!("资源刮削 - {}", site_name));
        return Ok(window);
    }

    // 首次创建隐藏窗口
    let window = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::External(parsed_url),
    )
    .title(&format!("资源刮削 - {}", site_name))
    .inner_size(1024.0, 768.0)
    .visible(false)
    .build()
    .map_err(|e| format!("创建 WebView 窗口失败: {}", e))?;

    Ok(window)
}

fn next_webview_label(inner: &mut WebviewPoolInner) -> String {
    inner.next_window_id += 1;
    format!("scraper_window_{}", inner.next_window_id)
}

fn normalize_site_key(site_id: &str) -> String {
    site_id.trim().to_lowercase()
}

/// 判断错误信息是否为 HTTP 4xx 客户端错误
///
/// 4xx 状态码表示客户端请求有误或资源不存在（如 404），
/// 用 WebView 重试不会改变结果，应直接跳过回退。
fn is_http_client_error(err: &str) -> bool {
    if let Some(rest) = err.strip_prefix("HTTP ") {
        // 状态码格式："HTTP 404 Not Found" 或 "HTTP 403 Forbidden"
        rest.starts_with('4')
    } else {
        false
    }
}

fn lock_webview_pool(
    mutex: &Mutex<WebviewPoolInner>,
) -> std::sync::MutexGuard<'_, WebviewPoolInner> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resource_scrape::cf_detection;

    #[test]
    fn should_retry_when_detail_page_mismatches_designation() {
        let html = r#"
        <html>
            <head><title>广告落地页</title></head>
            <body>
                <div>buy now</div>
            </body>
        </html>
        "#;

        assert!(should_retry_with_webview(
            "https://example.com/video/SSIS-392",
            html,
        ));
    }

    #[test]
    fn should_not_retry_when_search_url_has_no_designation_segment() {
        let html = r#"
        <html>
            <head><title>搜索页</title></head>
            <body>
                <div>任意搜索结果内容</div>
            </body>
        </html>
        "#;

        assert!(!should_retry_with_webview(
            "https://www.javlibrary.com/cn/vl_searchbyid.php?keyword=SSIS-392",
            html,
        ));
    }

    #[test]
    fn should_fallback_when_http_returns_cloudflare_challenge() {
        let html = r#"
        <html>
            <head><title>Just a moment...</title></head>
            <body>
                <form class="challenge-form"></form>
                <div>Checking your browser before accessing</div>
            </body>
        </html>
        "#;

        assert!(cf_detection::is_cloudflare_challenge_html(html));
        assert_eq!(
            webview_fallback_reason("https://freejavbt.com/zh/FSDSS-496", html),
            Some("命中 Cloudflare 验证页")
        );
    }

    #[test]
    fn should_fallback_when_http_returns_mismatch_page() {
        let html = r#"
        <html>
            <head><title>广告落地页</title></head>
            <body><div>buy now</div></body>
        </html>
        "#;

        assert_eq!(
            webview_fallback_reason("https://freejavbt.com/zh/FSDSS-496", html),
            Some("内容疑似错页或反爬页")
        );
    }

    #[test]
    fn webview_stays_hidden_without_explicit_flag() {
        assert!(!should_keep_webview_visible(false));
    }

    #[test]
    fn cleanup_keeps_window_visible_when_requested() {
        assert!(should_keep_webview_visible(true));
    }

    #[test]
    fn should_detect_http_client_errors() {
        assert!(is_http_client_error("HTTP 404 Not Found"));
        assert!(is_http_client_error("HTTP 403 Forbidden"));
        assert!(is_http_client_error("HTTP 410 Gone"));
        assert!(is_http_client_error("HTTP 451 Unavailable For Legal Reasons"));
    }

    #[test]
    fn should_not_treat_server_errors_as_client_errors() {
        assert!(!is_http_client_error("HTTP 500 Internal Server Error"));
        assert!(!is_http_client_error("HTTP 502 Bad Gateway"));
        assert!(!is_http_client_error("HTTP 503 Service Unavailable"));
    }

    #[test]
    fn should_not_treat_network_errors_as_client_errors() {
        assert!(!is_http_client_error("请求失败: connection refused"));
        assert!(!is_http_client_error("请求失败: timeout"));
        assert!(!is_http_client_error("读取响应体失败: unexpected EOF"));
    }
}


