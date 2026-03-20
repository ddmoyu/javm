use std::time::Duration;
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};
use urlencoding::encode;
use uuid::Uuid;

const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

pub async fn open_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let path_obj = std::path::Path::new(&path);
        if path_obj.is_dir() {
            std::process::Command::new("explorer")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("explorer")
                .arg("/select,")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let path_obj = std::path::Path::new(&path);
        if path_obj.is_dir() {
            std::process::Command::new("xdg-open")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        } else if let Some(parent) = path_obj.parent() {
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("xdg-open")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Open file with default system player/application
///
/// # Arguments
/// * `path` - Path to the file to open
///
/// # Platform Support
/// - Windows: Uses `explorer` (opens with default application)
/// - macOS: Uses `open`
/// - Linux: Uses `xdg-open`
pub async fn open_with_player(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub async fn open_video_player_window(
    app: AppHandle,
    video_url: String,
    title: String,
    is_hls: bool,
) -> Result<(), String> {
    let window_label = format!("video_player_{}", Uuid::new_v4().simple());

    // 我们需要对 url 和 title 进行编码，作为查询参数传递
    let encoded_url = encode(&video_url);
    let encoded_title = encode(&title);
    let url_str = format!(
        "/video-player?url={}&title={}&is_hls={}",
        encoded_url, encoded_title, is_hls
    );

    let url = WebviewUrl::App(url_str.into());

    use crate::settings::get_settings;

    // 获取配置
    let settings = get_settings(app.clone()).await.unwrap_or_default();
    let vp_settings = settings.video_player;

    let builder = WebviewWindowBuilder::new(&app, window_label, url)
        .title("视频播放")
        .decorations(false) // 这是一个无边框窗口
        .min_inner_size(400.0, 300.0)
        .always_on_top(vp_settings.always_on_top)
        .visible(false);

    let window = builder.build().map_err(|e| e.to_string())?;

    if let (Some(w), Some(h)) = (vp_settings.width, vp_settings.height) {
        let _ = window.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
    } else {
        let _ = window.set_size(tauri::LogicalSize::new(800.0, 600.0));
    }

    let mut position_set = false;
    if let (Some(x), Some(y)) = (vp_settings.x, vp_settings.y) {
        let mut is_visible = false;
        if let Ok(monitors) = window.available_monitors() {
            for m in monitors {
                let pos = m.position();
                let size = m.size();
                if (x as i32) < pos.x + size.width as i32 - 100
                    && (x as i32) + 100 > pos.x
                    && (y as i32) < pos.y + size.height as i32 - 100
                    && (y as i32) + 100 > pos.y
                {
                    is_visible = true;
                    break;
                }
            }
        } else {
            is_visible = true; // 获取失败则假定可见
        }

        if is_visible {
            let _ = window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
            position_set = true;
        }
    }

    if !position_set {
        let _ = window.center();
    }

    let _ = window.show();

    Ok(())
}

/// 代理 HLS 请求，绕过浏览器 CORS 限制
/// 返回 (base64_data, content_type)
pub async fn proxy_hls_request(
    url: String,
    referer: Option<String>,
) -> Result<(String, String), String> {
    let client = crate::utils::proxy::apply_proxy_auto(
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .use_rustls_tls()
            .user_agent(DEFAULT_USER_AGENT),
    )
    .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?
    .build()
    .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let mut req = client.get(&url);

    if let Some(ref r) = referer {
        req = req.header("Referer", r);
        req = req.header("Origin", r.trim_end_matches('/'));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("代理请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("代理请求失败，HTTP 状态码: {}", resp.status()));
    }

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取响应数据失败: {}", e))?;

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

    Ok((b64, content_type))
}
