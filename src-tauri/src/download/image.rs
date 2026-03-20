//! 图片下载基础模块
//!
//! 提供统一的图片下载能力，包括：
//! - 单张图片下载
//! - 批量并发图片下载（信号量控制并发数）
//!
//! 所有需要下载图片的模块（media_assets、scraper 等）都应使用此模块，
//! 避免重复实现下载逻辑。

use std::path::Path;
use std::sync::Arc;

/// 默认最大并发下载数
const DEFAULT_MAX_CONCURRENT: usize = 5;

/// 默认请求超时时间（秒）
const DEFAULT_TIMEOUT_SECS: u64 = 30;

/// 默认 User-Agent
const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// 创建默认的 HTTP 客户端（自动应用代理）
fn default_client() -> Result<reqwest::Client, String> {
    crate::utils::proxy::apply_proxy_auto(
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(DEFAULT_TIMEOUT_SECS))
            .user_agent(DEFAULT_USER_AGENT),
    )?
    .build()
    .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))
}

/// 从 URL 中提取 origin 作为 Referer（防盗链）
fn extract_referer(url: &str) -> Option<String> {
    // 简单解析：取 scheme + host 部分
    if let Some(pos) = url.find("://") {
        let after_scheme = &url[pos + 3..];
        if let Some(slash) = after_scheme.find('/') {
            return Some(format!("{}/", &url[..pos + 3 + slash]));
        }
        return Some(format!("{}/", url));
    }
    None
}

/// 下载单张图片并保存到指定路径
///
/// 自动从 URL 提取 Referer 以绕过防盗链检查
pub async fn download_image(
    client: &reqwest::Client,
    url: &str,
    save_path: &Path,
) -> Result<String, String> {
    let mut req = client.get(url);

    // 添加 Referer 防盗链
    if let Some(referer) = extract_referer(url) {
        req = req.header("Referer", referer);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("下载失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("下载失败，HTTP 状态码: {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取数据失败: {}", e))?;

    if bytes.is_empty() {
        return Err("下载的数据为空".to_string());
    }

    let mut file =
        std::fs::File::create(save_path).map_err(|e| format!("创建文件失败: {}", e))?;

    std::io::Write::write_all(&mut file, &bytes)
        .map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(save_path.to_string_lossy().to_string())
}

/// 下载封面图片并保存到视频所在目录
///
/// 文件命名规则：`{视频文件名}-poster.jpg`
///
/// 支持三种 URL 格式：
/// - `data:image/...;base64,...` — 直接解码 base64 写入文件
/// - `http(s)://...` — 通过 HTTP 下载
/// - 本地文件路径 — 直接复制文件（搜索阶段代理缓存的结果）
pub async fn download_cover(
    video_path: &str,
    cover_url: &str,
    client: Option<&reqwest::Client>,
) -> Result<String, String> {
    if cover_url.trim().is_empty() {
        return Ok(String::new());
    }

    if video_path.trim().is_empty() {
        return Err("视频路径不能为空".to_string());
    }

    let video_path = Path::new(video_path);
    let parent_dir = video_path.parent().ok_or("无效的视频路径")?;
    let file_stem = video_path
        .file_stem()
        .ok_or("无效的文件名")?
        .to_string_lossy();

    let cover_filename = format!("{}-poster.jpg", file_stem);
    let cover_path = parent_dir.join(&cover_filename);

    // 处理 data URL（base64 编码的图片数据）
    if cover_url.starts_with("data:") {
        return save_data_url_to_file(cover_url, &cover_path);
    }

    // 处理 HTTP URL
    if cover_url.starts_with("http://") || cover_url.starts_with("https://") {
        let owned_client;
        let client = match client {
            Some(c) => c,
            None => {
                owned_client = default_client()?;
                &owned_client
            }
        };
        return download_image(client, cover_url, &cover_path).await;
    }

    // 处理本地缓存文件路径（搜索阶段代理下载的临时文件）
    let source_path = Path::new(cover_url);
    if source_path.exists() {
        std::fs::copy(source_path, &cover_path)
            .map_err(|e| format!("复制封面缓存文件失败: {}", e))?;
        return Ok(cover_path.to_string_lossy().to_string());
    }

    Err(format!("无法识别的封面 URL 格式: {}", &cover_url[..cover_url.len().min(100)]))
}

/// 将 data URL（base64）解码并保存为文件
fn save_data_url_to_file(data_url: &str, save_path: &Path) -> Result<String, String> {
    // 格式: data:image/jpeg;base64,/9j/4AAQ...
    let base64_data = data_url
        .find(",")
        .map(|i| &data_url[i + 1..])
        .ok_or("无效的 data URL 格式")?;

    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    if bytes.is_empty() {
        return Err("解码后的数据为空".to_string());
    }

    let mut file =
        std::fs::File::create(save_path).map_err(|e| format!("创建文件失败: {}", e))?;

    std::io::Write::write_all(&mut file, &bytes)
        .map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(save_path.to_string_lossy().to_string())
}

/// 批量并发下载缩略图
///
/// 使用信号量控制并发数，所有图片同时发起但最多 N 个并行下载。
/// 单张下载失败不会中断整个过程。
pub async fn download_images_batch(
    thumb_urls: &[String],
    save_dir: &Path,
    filename_prefix: &str,
    client: Option<&reqwest::Client>,
    max_concurrent: Option<usize>,
) -> Result<Vec<String>, String> {
    if thumb_urls.is_empty() {
        return Ok(Vec::new());
    }

    std::fs::create_dir_all(save_dir)
        .map_err(|e| format!("创建目录失败: {}", e))?;

    let owned_client;
    let client = match client {
        Some(c) => c,
        None => {
            owned_client = default_client()?;
            &owned_client
        }
    };

    let concurrent = max_concurrent.unwrap_or(DEFAULT_MAX_CONCURRENT);
    let semaphore = Arc::new(tokio::sync::Semaphore::new(concurrent));
    let client = Arc::new(client.clone());

    let tasks: Vec<(usize, String)> = thumb_urls
        .iter()
        .enumerate()
        .filter(|(_, url)| !url.trim().is_empty())
        .map(|(i, url)| (i, url.clone()))
        .collect();

    let prefix = filename_prefix.to_string();
    let handles: Vec<_> = tasks
        .into_iter()
        .map(|(index, url)| {
            let sem = semaphore.clone();
            let client = client.clone();
            let filename = format!("{}_{:03}.jpg", prefix, index + 1);
            let save_path = save_dir.join(&filename);

            tokio::spawn(async move {
                let _permit = sem
                    .acquire()
                    .await
                    .map_err(|e| format!("获取信号量失败: {}", e))?;
                download_image(&client, &url, &save_path).await
            })
        })
        .collect();

    let mut saved_paths = Vec::new();
    for handle in handles {
        match handle.await {
            Ok(Ok(path)) => saved_paths.push(path),
            Ok(Err(_e)) => {
            }
            Err(_e) => {
            }
        }
    }

    Ok(saved_paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[tokio::test]
    async fn test_download_cover_empty_url() {
        let result = download_cover("/test/video.mp4", "", None).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_download_cover_empty_path() {
        let result = download_cover("", "http://example.com/cover.jpg", None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("视频路径不能为空"));
    }

    #[tokio::test]
    async fn test_download_images_batch_empty_urls() {
        let dir = PathBuf::from("/tmp/test");
        let result = download_images_batch(&[], &dir, "thumb", None, None).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[test]
    fn test_cover_filename_generation() {
        let video_path = Path::new("/path/to/ABC-123.mp4");
        let file_stem = video_path.file_stem().unwrap().to_string_lossy();
        let cover_filename = format!("{}-poster.jpg", file_stem);
        assert_eq!(cover_filename, "ABC-123-poster.jpg");
    }

    #[test]
    fn test_thumb_filename_generation() {
        let filenames: Vec<String> = (1..=5)
            .map(|i| format!("thumb_{:03}.jpg", i))
            .collect();
        assert_eq!(filenames[0], "thumb_001.jpg");
        assert_eq!(filenames[4], "thumb_005.jpg");
    }
}
