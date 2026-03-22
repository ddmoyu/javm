//! 双模式获取器
//!
//! 支持 HTTP 快速模式和 WebView 增强模式两种网页获取方式。
//! 根据资源网站配置和全局设置智能选择获取模式，
//! HTTP 失败时可自动回退到 WebView 模式。

use reqwest::Client;
use tauri::AppHandle;

use super::client;
use super::sources::{FetchMode, ResourceSite};
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

        let window = get_or_create_webview_window(app, url)?;
        webview_support::sync_window_visibility(&window, show_webview);
        webview_support::emit_cf_state(app, RESOURCE_SCRAPE_CF_STATE_EVENT, false);

        let cf_event_name = webview_support::next_event_name("resource-scrape-cf-status");
        let html_event_name = webview_support::next_event_name("resource-scrape-html-result");
        let cf_listener_id = webview_support::listen_cf_visibility(
            app,
            &window,
            &cf_event_name,
            show_webview,
            Some(RESOURCE_SCRAPE_CF_STATE_EVENT),
        );

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
        let max_attempts = WEBVIEW_TIMEOUT_SECS * 2; // 每 500ms 检查一次
        let js = webview_support::build_html_extract_script(&cf_event_name, &html_event_name);
        for attempt in 0..max_attempts {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

            if let Err(e) = window.eval(&js) {
                if attempt % 20 == 0 {
                    println!("[WebView 获取] eval 失败 (第 {} 次): {}", attempt, e);
                }
                continue;
            }

            // 检查是否已收到结果
            match rx.try_recv() {
                Ok(html) => {
                    app.unlisten(listener_id);
                    app.unlisten(cf_listener_id);
                    webview_support::emit_cf_state(app, RESOURCE_SCRAPE_CF_STATE_EVENT, false);
                    // 隐藏窗口以便复用
                    let _ = window.hide();
                    return Ok(html);
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {
                    // 继续等待
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                    app.unlisten(listener_id);
                    app.unlisten(cf_listener_id);
                    webview_support::emit_cf_state(app, RESOURCE_SCRAPE_CF_STATE_EVENT, false);
                    let _ = window.hide();
                    return Err("WebView HTML 接收通道已关闭".to_string());
                }
            }
        }

        // 超时
        app.unlisten(listener_id);
        app.unlisten(cf_listener_id);
        webview_support::emit_cf_state(app, RESOURCE_SCRAPE_CF_STATE_EVENT, false);
        let _ = window.hide();
        Err(format!("WebView 获取超时（{}秒）", WEBVIEW_TIMEOUT_SECS))
    }

    /// 智能获取：根据网站配置和全局设置选择获取模式
    ///
    /// 模式选择逻辑：
    /// 1. 网站 fetch_mode == WebViewOnly → 始终 WebView
    /// 2. 网站 fetch_mode == HttpOnly → 始终 HTTP
    /// 3. 网站 fetch_mode == Both 且 webview_enabled == true → WebView
    /// 4. 网站 fetch_mode == Both 且 webview_enabled == false → HTTP
    /// 5. HTTP 失败时，若允许回退且网站支持 WebView → 回退 WebView
    pub async fn fetch(
        &self,
        app: &AppHandle,
        url: &str,
        site: &ResourceSite,
        options: FetchOptions,
    ) -> Result<String, String> {
        let mode = select_fetch_mode(&site.fetch_mode, options.webview_enabled);
        println!(
            "[获取] {} 选择模式: {} ({}) fallback={} visible={}",
            site.name,
            mode.as_str(),
            url,
            options.webview_fallback_enabled,
            options.show_webview
        );

        match mode {
            ResolvedMode::Http => {
                let result = self.fetch_http(url).await;
                // HTTP 失败时尝试回退到 WebView
                if result.is_err()
                    && options.webview_fallback_enabled
                    && supports_webview(&site.fetch_mode)
                {
                    println!(
                        "[获取] {} HTTP 失败，回退到 WebView: {}",
                        site.name,
                        result.as_ref().unwrap_err()
                    );
                    Self::fetch_webview(app, url, options.show_webview).await
                } else {
                    result
                }
            }
            ResolvedMode::WebView => Self::fetch_webview(app, url, options.show_webview).await,
        }
    }
}

/// 解析后的获取模式（内部使用）
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ResolvedMode {
    Http,
    WebView,
}

impl ResolvedMode {
    fn as_str(&self) -> &'static str {
        match self {
            ResolvedMode::Http => "HTTP",
            ResolvedMode::WebView => "WebView",
        }
    }
}

/// 根据网站 FetchMode 和全局 webview_enabled 选择实际获取模式
///
/// 此函数为纯逻辑，方便单元测试和属性测试。
pub fn select_fetch_mode(fetch_mode: &FetchMode, webview_enabled: bool) -> ResolvedMode {
    match fetch_mode {
        FetchMode::WebViewOnly => ResolvedMode::WebView,
        FetchMode::HttpOnly => ResolvedMode::Http,
        FetchMode::Both => {
            if webview_enabled {
                ResolvedMode::WebView
            } else {
                ResolvedMode::Http
            }
        }
    }
}

/// 判断网站是否支持 WebView 模式
pub fn supports_webview(fetch_mode: &FetchMode) -> bool {
    matches!(fetch_mode, FetchMode::WebViewOnly | FetchMode::Both)
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
    fn test_select_fetch_mode_webview_only() {
        // WebViewOnly 始终选择 WebView，无论全局设置
        assert_eq!(
            select_fetch_mode(&FetchMode::WebViewOnly, false),
            ResolvedMode::WebView
        );
        assert_eq!(
            select_fetch_mode(&FetchMode::WebViewOnly, true),
            ResolvedMode::WebView
        );
    }

    #[test]
    fn test_select_fetch_mode_http_only() {
        // HttpOnly 始终选择 HTTP，无论全局设置
        assert_eq!(
            select_fetch_mode(&FetchMode::HttpOnly, false),
            ResolvedMode::Http
        );
        assert_eq!(
            select_fetch_mode(&FetchMode::HttpOnly, true),
            ResolvedMode::Http
        );
    }

    #[test]
    fn test_select_fetch_mode_both() {
        // Both 模式根据 webview_enabled 选择
        assert_eq!(
            select_fetch_mode(&FetchMode::Both, false),
            ResolvedMode::Http
        );
        assert_eq!(
            select_fetch_mode(&FetchMode::Both, true),
            ResolvedMode::WebView
        );
    }

    #[test]
    fn test_supports_webview() {
        assert!(!supports_webview(&FetchMode::HttpOnly));
        assert!(supports_webview(&FetchMode::WebViewOnly));
        assert!(supports_webview(&FetchMode::Both));
    }
}
