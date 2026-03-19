use std::future::Future;
use std::path::Path;
use std::pin::Pin;

use tokio::fs;

const SKIPPED_DIRECTORY_NAMES: &[&str] = &[
    "behind the scenes",
    "backdrops",
];

/// 支持的视频文件扩展名
pub const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "3gp", "ts",
];

const CONTENT_PROBED_VIDEO_EXTENSIONS: &[&str] = &["ts"];

/// 判断文件是否为支持的视频格式
pub fn is_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn should_probe_video_content(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| CONTENT_PROBED_VIDEO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// 判断文件是否应当作为视频参与扫描。
///
/// 对扩展名存在歧义的文件（当前是 .ts）进一步做元数据探测，
/// 避免将 TypeScript 源文件当成视频扫描入库。
pub fn should_scan_as_video(path: &Path) -> bool {
    if !is_video_file(path) {
        return false;
    }

    if !should_probe_video_content(path) {
        return true;
    }

    crate::metadata::extract_metadata(path).is_ok()
}

pub fn is_skipped_directory(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            SKIPPED_DIRECTORY_NAMES
                .iter()
                .any(|skipped| name.eq_ignore_ascii_case(skipped))
        })
        .unwrap_or(false)
}

/// 异步递归统计目录下视频文件数量
pub fn count_video_files_async(
    dir: &Path,
) -> Pin<Box<dyn Future<Output = Result<u32, String>> + Send + '_>> {
    Box::pin(async move {
        let mut count = 0u32;
        let mut entries = fs::read_dir(dir)
            .await
            .map_err(|e| format!("无法读取目录 '{}': {}", dir.display(), e))?;

        while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
            let path = entry.path();

            // 跳过隐藏文件/目录
            if let Some(name) = path.file_name() {
                if name.to_string_lossy().starts_with('.') {
                    continue;
                }
            }

            if is_skipped_directory(&path) {
                continue;
            }

            let meta = match entry.metadata().await {
                Ok(m) => m,
                Err(_) => continue,
            };

            if meta.is_dir() {
                count += count_video_files_async(&path).await?;
            } else if should_scan_as_video(&path) {
                count += 1;
            }
        }

        Ok(count)
    })
}


/// 扫描指定目录下的视频文件
///
/// # 参数
/// - `path`: 要扫描的根目录路径
/// - `depth`: 最大递归深度（0 表示仅扫描根目录，不递归子目录）
///
/// # 返回
/// - 成功时返回视频文件路径列表
/// - 失败时返回错误描述
pub async fn find_video_files(path: &str, depth: usize) -> Result<Vec<String>, String> {
    // 校验路径不能为空
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("目录路径不能为空".to_string());
    }

    let root_path = Path::new(trimmed);

    // 校验路径是否存在
    let metadata = fs::symlink_metadata(root_path)
        .await
        .map_err(|e| format!("无法访问路径 '{}': {}", trimmed, e))?;

    // 拒绝符号链接，避免循环引用
    if metadata.is_symlink() {
        return Err(format!("路径 '{}' 是符号链接，不支持直接扫描", trimmed));
    }

    // 校验路径是否为目录
    if !metadata.is_dir() {
        return Err(format!("路径 '{}' 不是有效的目录", trimmed));
    }

    if is_skipped_directory(root_path) {
        return Ok(Vec::new());
    }

    /// 递归扫描目录中的视频文件
    fn scan<'a>(
        dir: &'a Path,
        files: &'a mut Vec<String>,
        current_depth: usize,
        max_depth: usize,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            let mut entries = fs::read_dir(dir)
                .await
                .map_err(|e| format!("无法读取目录 '{}': {}", dir.display(), e))?;

            while let Some(entry) = entries
                .next_entry()
                .await
                .map_err(|e| format!("读取目录项失败 '{}': {}", dir.display(), e))?
            {
                let path = entry.path();

                // 跳过隐藏文件和目录（以 '.' 开头）
                if let Some(name) = path.file_name() {
                    if name.to_string_lossy().starts_with('.') {
                        continue;
                    }
                }

                if is_skipped_directory(&path) {
                    continue;
                }

                // 获取元数据，跳过符号链接以避免循环引用
                let metadata = match fs::symlink_metadata(&path).await {
                    Ok(m) => m,
                    Err(_) => continue, // 无法读取元数据的条目直接跳过
                };

                if metadata.is_symlink() {
                    continue; // 跳过符号链接
                }

                if metadata.is_dir() {
                    // 未达到最大深度时递归扫描子目录
                    if current_depth < max_depth {
                        scan(&path, files, current_depth + 1, max_depth).await?;
                    }
                } else if metadata.is_file() && should_scan_as_video(&path) {
                    files.push(path.to_string_lossy().to_string());
                }
            }
            Ok(())
        })
    }

    let mut files = Vec::new();
    // 从深度 0 开始扫描，确保 depth=0 时也能扫描根目录下的文件
    scan(root_path, &mut files, 0, depth).await?;
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::{is_video_file, should_scan_as_video};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn keeps_common_video_extensions_fast_path() {
        assert!(is_video_file(std::path::Path::new("movie.mp4")));
        assert!(should_scan_as_video(std::path::Path::new("movie.mp4")));
    }

    #[test]
    fn skips_typescript_source_with_ts_extension() {
        let dir = tempdir().expect("创建临时目录失败");
        let file_path = dir.path().join("index.ts");
        fs::write(&file_path, "export const answer: number = 42;\n")
            .expect("写入测试文件失败");

        assert!(is_video_file(&file_path));
        assert!(!should_scan_as_video(&file_path));
    }
}