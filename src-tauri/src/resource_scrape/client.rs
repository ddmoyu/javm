//! 资源刮削模块共享 HTTP 客户端

use reqwest::Client;
use std::time::Duration;

/// 默认 User-Agent
const USER_AGENT: &str = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// 请求超时（秒）
const TIMEOUT_SECS: u64 = 30;

/// 创建搜索用 HTTP 客户端（启用 cookie 支持，解决防盗链，自动应用代理）
pub fn create_client() -> Result<Client, String> {
    crate::utils::proxy::apply_proxy_auto(
        Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(TIMEOUT_SECS))
            .connect_timeout(Duration::from_secs(15))
            .cookie_store(true),
    )?
    .build()
    .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))
}

/// 创建搜索用 HTTP 客户端（启用 cookie 支持，解决防盗链，指定目录读取代理）
pub fn create_client_with_proxy(config_dir: &std::path::Path) -> Result<Client, String> {
    let builder = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(15))
        .cookie_store(true);

    crate::utils::proxy::apply_proxy(builder, config_dir)?
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))
}

/// 请求指定 URL 并返回 (最终URL, HTML文本)
pub async fn fetch_html(client: &Client, url: &str) -> Result<(String, String), String> {
    let resp = client
        .get(url)
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .header("Sec-Fetch-Dest", "document")
        .header("Sec-Fetch-Mode", "navigate")
        .header("Sec-Fetch-Site", "none")
        .header("Sec-Fetch-User", "?1")
        .header("Upgrade-Insecure-Requests", "1")
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = resp.status();
    let final_url = resp.url().to_string();

    if !status.is_success() {
        return Err(format!("HTTP {}", status));
    }

    let html = resp.text()
        .await
        .map_err(|e| format!("读取响应体失败: {}", e))?;

    Ok((final_url, html))
}
