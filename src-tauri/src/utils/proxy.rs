//! 代理配置模块
//!
//! 根据用户设置自动解析代理 URL：
//! - "system"：从 Windows 注册表（或环境变量）读取系统代理
//! - "custom"：使用用户自定义的 host:port
//!
//! 应用启动时调用 `init` 缓存代理 URL，后续所有 HTTP 客户端统一读取。

use std::path::Path;
use std::sync::OnceLock;

/// 全局缓存的代理 URL（应用启动时初始化）
static PROXY_URL: OnceLock<Option<url::Url>> = OnceLock::new();

/// 初始化全局代理缓存（应在应用启动时调用一次）
pub fn init(config_dir: &Path) {
    let _ = PROXY_URL.set(resolve_proxy_url(config_dir));
}

/// 刷新全局代理缓存（用户修改代理设置后调用）
pub fn refresh(config_dir: &Path) {
    // OnceLock 不支持重新设置，用 parking_lot 或 std::sync 代替
    // 但因为代理修改频率极低，直接记录到环境变量作为 fallback
    if let Some(url) = resolve_proxy_url(config_dir) {
        std::env::set_var("JAVM_PROXY_URL", url.as_str());
    } else {
        std::env::remove_var("JAVM_PROXY_URL");
    }
}

/// 获取当前生效的代理 URL
pub fn get_proxy_url() -> Option<url::Url> {
    // 优先读环境变量（可能被 refresh 更新过）
    if let Ok(val) = std::env::var("JAVM_PROXY_URL") {
        if let Ok(url) = url::Url::parse(&val) {
            return Some(url);
        }
    }
    PROXY_URL.get().and_then(|v| v.clone())
}

/// 从设置文件读取代理 URL
pub fn resolve_proxy_url(config_dir: &Path) -> Option<url::Url> {
    let settings_path = config_dir.join("settings.json");
    if !settings_path.exists() {
        return get_system_proxy();
    }

    let content = std::fs::read_to_string(settings_path).ok()?;
    let settings: serde_json::Value = serde_json::from_str(&content).ok()?;

    let proxy_type = settings["theme"]["proxy"]["type"]
        .as_str()
        .unwrap_or("system");

    match proxy_type {
        "custom" => {
            let host = settings["theme"]["proxy"]["host"]
                .as_str()
                .unwrap_or("")
                .trim();
            let port = settings["theme"]["proxy"]["port"]
                .as_u64()
                .unwrap_or(7890);
            if host.is_empty() {
                return get_system_proxy();
            }
            url::Url::parse(&format!("http://{}:{}", host, port)).ok()
        }
        _ => get_system_proxy(),
    }
}

/// 为 reqwest::ClientBuilder 应用代理设置（从全局缓存读取）
pub fn apply_proxy_auto(
    builder: reqwest::ClientBuilder,
) -> Result<reqwest::ClientBuilder, String> {
    if let Some(proxy_url) = get_proxy_url() {
        let proxy = reqwest::Proxy::all(proxy_url.as_str())
            .map_err(|e| format!("代理配置无效: {e}"))?;
        Ok(builder.proxy(proxy))
    } else {
        Ok(builder)
    }
}

/// 为 reqwest::ClientBuilder 应用代理设置（从指定目录读取）
pub fn apply_proxy(
    builder: reqwest::ClientBuilder,
    config_dir: &Path,
) -> Result<reqwest::ClientBuilder, String> {
    if let Some(proxy_url) = resolve_proxy_url(config_dir) {
        let proxy = reqwest::Proxy::all(proxy_url.as_str())
            .map_err(|e| format!("代理配置无效: {e}"))?;
        Ok(builder.proxy(proxy))
    } else {
        Ok(builder)
    }
}

/// 从系统获取代理配置
#[cfg(target_os = "windows")]
fn get_system_proxy() -> Option<url::Url> {
    get_windows_system_proxy()
}

#[cfg(not(target_os = "windows"))]
fn get_system_proxy() -> Option<url::Url> {
    // 非 Windows 系统 reqwest 会自动读取环境变量
    std::env::var("HTTPS_PROXY")
        .or_else(|_| std::env::var("https_proxy"))
        .or_else(|_| std::env::var("ALL_PROXY"))
        .or_else(|_| std::env::var("all_proxy"))
        .ok()
        .and_then(|v| url::Url::parse(&v).ok())
}

/// 从 Windows 注册表读取系统代理
#[cfg(target_os = "windows")]
fn get_windows_system_proxy() -> Option<url::Url> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let internet_settings = hkcu
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()?;

    let proxy_enable: u32 = internet_settings.get_value("ProxyEnable").ok()?;
    if proxy_enable == 0 {
        return None;
    }

    let proxy_server: String = internet_settings.get_value("ProxyServer").ok()?;
    if proxy_server.is_empty() {
        return None;
    }

    // 格式可能是 "host:port" 或 "http=h:p;https=h:p;..."
    if proxy_server.contains('=') {
        for part in proxy_server.split(';') {
            let part = part.trim();
            if part.starts_with("https=") {
                let addr = part.trim_start_matches("https=");
                return url::Url::parse(&format!("http://{}", addr)).ok();
            }
        }
        // 没有 https 则取 http
        for part in proxy_server.split(';') {
            let part = part.trim();
            if part.starts_with("http=") {
                let addr = part.trim_start_matches("http=");
                return url::Url::parse(&format!("http://{}", addr)).ok();
            }
        }
        None
    } else {
        // 简单格式 "host:port"
        url::Url::parse(&format!("http://{}", proxy_server)).ok()
    }
}
