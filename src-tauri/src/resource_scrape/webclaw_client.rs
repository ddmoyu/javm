//! 基于 webclaw-http 的 TLS 指纹伪装 HTTP 客户端
//!
//! 使用 webclaw-http 库模拟 Chrome 浏览器的 TLS 指纹（JA4 + Akamai），
//! 可以绕过大部分 Cloudflare 等反爬检测，减少对 WebView 回退的依赖。

use std::time::Duration;
use webclaw_http::Client as WebclawClient;

/// 请求超时（秒）
const TIMEOUT_SECS: u64 = 30;

/// 创建 webclaw HTTP 客户端（Chrome TLS 指纹 + 代理）
pub fn create_client() -> Result<WebclawClient, String> {
    let mut builder = WebclawClient::builder()
        .chrome()
        .timeout(Duration::from_secs(TIMEOUT_SECS));

    if let Some(proxy_url) = crate::utils::proxy::get_proxy_url() {
        builder = builder
            .proxy(proxy_url.as_str())
            .map_err(|e| format!("webclaw 代理配置失败: {}", e))?;
    }

    builder
        .build()
        .map_err(|e| format!("创建 webclaw 客户端失败: {}", e))
}

/// 请求指定 URL 并返回 HTML 文本
pub async fn fetch_html(client: &WebclawClient, url: &str) -> Result<String, String> {
    let resp = client
        .get(url)
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = resp.status();
    if !resp.is_success() {
        return Err(format!("HTTP {}", status));
    }

    Ok(resp.text().to_string())
}

/// 请求指定 URL 并返回原始字节（用于图片下载等）
pub async fn fetch_bytes(client: &WebclawClient, url: &str) -> Result<Vec<u8>, String> {
    let resp = client
        .get(url)
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    Ok(resp.body().to_vec())
}
