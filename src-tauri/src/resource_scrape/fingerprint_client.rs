//! 基于 wreq 的 TLS 指纹伪装 HTTP 客户端
//!
//! 使用 wreq 库模拟 Chrome 浏览器的 TLS 指纹（JA4 + Akamai），
//! 可以绕过大部分 Cloudflare 等反爬检测，减少对 WebView 回退的依赖。
//!
//! 本模块是最底层的 HTTP 请求层：负责按「指纹 + 代理」构建 client、发起请求并归类
//! 错误。限速、重试、代理池、镜像轮换等反爬编排在上层 `anti_block` 引擎完成。

use std::time::Duration;
use wreq::Client;
use wreq_util::Emulation;

use super::anti_block;

/// 请求超时（秒）
const TIMEOUT_SECS: u64 = 30;

/// 按指定指纹 + 代理构建 wreq client。
///
/// 刻意不跟随重定向（wreq 默认即如此）：本项目把 3xx（如年龄验证门 302）视为
/// 「该回退 WebView」的信号；若跟随重定向，会把年龄门/反爬页静默解析成垃圾。
pub fn build_client(emulation: Emulation, proxy_url: Option<url::Url>) -> Result<Client, String> {
    let mut builder = Client::builder()
        .emulation(emulation)
        .timeout(Duration::from_secs(TIMEOUT_SECS));

    if let Some(proxy_url) = proxy_url {
        let proxy = wreq::Proxy::all(proxy_url.as_str())
            .map_err(|e| format!("wreq 代理配置失败: {}", e))?;
        builder = builder.proxy(proxy);
    }

    builder
        .build()
        .map_err(|e| format!("创建 wreq 客户端失败: {}", e))
}

/// 进程级共享 Client：复用连接池/TLS session，避免每次刮削/搜索/下载重建指纹
/// Client（BoringSSL 指纹构建较贵）。委托给反爬引擎按「系统/自定义代理 + 默认指纹」
/// 缓存复用，代理变更时引擎会重建。
pub fn shared_client() -> Result<Client, String> {
    anti_block::engine().default_client()
}

/// 单次 HTTP 请求错误，携带状态码与 Retry-After，供上层判断是否重试与退避时长。
#[derive(Debug, Clone)]
pub struct RequestError {
    /// 与历史错误字符串格式一致（如 `HTTP 404 Not Found`、`请求失败: ...`）
    pub message: String,
    /// HTTP 状态码（网络层错误为 `None`）
    pub status: Option<u16>,
    /// 429 响应携带的 Retry-After 等待时长
    pub retry_after: Option<Duration>,
}

impl RequestError {
    fn network(message: String) -> Self {
        Self {
            message,
            status: None,
            retry_after: None,
        }
    }

    /// 是否值得在反爬引擎内重试。
    ///
    /// - 网络错误 / 408 / 429 / 5xx：可重试（换代理、镜像、退避后再试）。
    /// - 其它 4xx（含 403/404）：不在此重试。403 多为 CF/反爬拦截，交由上层 WebView
    ///   回退处理；404 等为资源不存在，重试无意义。
    pub fn is_retryable(&self) -> bool {
        match self.status {
            Some(408) | Some(429) => true,
            Some(code) if code >= 500 => true,
            Some(_) => false,
            None => true,
        }
    }

    /// 计算第 `attempt`（从 0 起）次失败后的退避时长。
    pub fn backoff_delay(&self, attempt: u32) -> Duration {
        // 429：优先采用 Retry-After，封顶 15s 避免长时间占用并发槽
        if self.status == Some(429) {
            return self
                .retry_after
                .unwrap_or_else(|| Duration::from_secs(10))
                .min(Duration::from_secs(15));
        }
        // 5xx 退避更激进，其它（网络错误等）较短；随 attempt 线性递增，封顶 30s
        let base = if self.status.map_or(false, |code| code >= 500) {
            5
        } else {
            3
        };
        Duration::from_secs((base * (attempt as u64 + 1)).min(30))
    }
}

/// 发起一次 GET 请求并返回 HTML 文本，错误归类为 [`RequestError`]。
pub async fn request_text(client: &Client, url: &str) -> Result<String, RequestError> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| RequestError::network(format!("请求失败: {}", e)))?;

    let status = resp.status();
    if !status.is_success() {
        // Retry-After 仅解析「秒数」形式，HTTP-date 形式忽略
        let retry_after = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        return Err(RequestError {
            message: format!("HTTP {}", status),
            status: Some(status.as_u16()),
            retry_after,
        });
    }

    resp.text()
        .await
        .map_err(|e| RequestError::network(format!("读取响应失败: {}", e)))
}

/// 请求指定 URL 并返回 HTML 文本（兼容旧调用方：图片代理、HLS 分析等）。
pub async fn fetch_html(client: &Client, url: &str) -> Result<String, String> {
    request_text(client, url).await.map_err(|e| e.message)
}

/// 请求指定 URL 并返回原始字节（用于图片下载等）
pub async fn fetch_bytes(client: &Client, url: &str) -> Result<Vec<u8>, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;
    Ok(bytes.to_vec())
}
