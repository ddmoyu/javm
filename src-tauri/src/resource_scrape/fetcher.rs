//! 双模式获取器
//!
//! 支持 HTTP 快速模式和 WebView 增强模式两种网页获取方式。
//! 根据资源网站配置和全局设置智能选择获取模式，
//! HTTP 失败时可自动回退到 WebView 模式。

use reqwest::Client;
use tauri::AppHandle;
use tauri::Listener;

use super::client;
use super::sources::ResourceSite;
use super::webview_support;

#[derive(Debug, Clone, Copy)]
pub struct FetchOptions {
    pub webview_enabled: bool,
    pub webview_fallback_enabled: bool,
    pub show_webview: bool,
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

/// WebView 窗口标识
const WEBVIEW_WINDOW_LABEL: &str = "scraper_window";

/// 前端刮削 CF 状态事件
const RESOURCE_SCRAPE_CF_STATE_EVENT: &str = "resource-scrape-cf-state";

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
        show_webview: bool,
    ) -> Result<String, String> {
        use tauri::Listener;
        use std::sync::{Arc, Mutex};
        use std::time::Instant;

        let window = get_or_create_webview_window(app, url)?;
        let effective_show_webview = should_keep_webview_visible(show_webview);
        webview_support::sync_window_visibility(&window, effective_show_webview);
        webview_support::emit_cf_state(app, RESOURCE_SCRAPE_CF_STATE_EVENT, "idle");

        let cf_event_name = webview_support::next_event_name("resource-scrape-cf-status");
        let html_event_name = webview_support::next_event_name("resource-scrape-html-result");
        let cf_listener_id = webview_support::listen_cf_visibility(
            app,
            &window,
            &cf_event_name,
            effective_show_webview,
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
                if should_retry_with_webview(url, &html) {
                    println!(
                        "[获取] {} HTTP 内容疑似错页，自动回退到 WebView",
                        site.name,
                    );
                    match Self::fetch_webview(app, url, options.show_webview).await {
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
                    Ok(html)
                }
            }
            Err(err) => {
                if options.webview_enabled && options.webview_fallback_enabled {
                    println!(
                        "[获取] {} HTTP 失败，回退到 WebView: {}",
                        site.name,
                        err
                    );
                    Self::fetch_webview(app, url, options.show_webview).await
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
    cfg!(debug_assertions) || show_webview
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
    webview_support::emit_cf_state(app, RESOURCE_SCRAPE_CF_STATE_EVENT, final_status);
    if !keep_visible {
        let _ = window.hide();
    }
}

/// 获取或创建隐藏的 WebView 窗口
///
/// 若窗口已存在则复用，通过 navigate 导航到新 URL，避免重复创建导致闪烁。
fn get_or_create_webview_window(
    app: &AppHandle,
    url: &str,
) -> Result<tauri::WebviewWindow, String> {
    use tauri::Manager;
    use tauri::WebviewUrl;
    use tauri::WebviewWindowBuilder;

    let parsed_url: url::Url = url.parse().map_err(|e: url::ParseError| {
        format!("URL 解析失败: {}", e)
    })?;

    // 复用已有窗口：直接导航到新 URL，保留 session/cookies
    if let Some(window) = app.get_webview_window(WEBVIEW_WINDOW_LABEL) {
        window
            .navigate(parsed_url)
            .map_err(|e| format!("WebView 导航失败: {}", e))?;
        return Ok(window);
    }

    // 首次创建隐藏窗口
    let window = WebviewWindowBuilder::new(
        app,
        WEBVIEW_WINDOW_LABEL,
        WebviewUrl::External(parsed_url),
    )
    .title("资源刮削 - WebView")
    .inner_size(1024.0, 768.0)
    .visible(false)
    .build()
    .map_err(|e| format!("创建 WebView 窗口失败: {}", e))?;

    Ok(window)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn debug_build_keeps_webview_visible() {
        let visible = should_keep_webview_visible(false);
        if cfg!(debug_assertions) {
            assert!(visible);
        } else {
            assert!(!visible);
        }
    }

    #[test]
    fn cleanup_keeps_window_visible_when_requested() {
        assert!(should_keep_webview_visible(true));
    }
}


