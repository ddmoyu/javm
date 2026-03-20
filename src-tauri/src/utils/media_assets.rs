//! 视频媒体资源管理模块
//!
//! 统一处理视频相关的媒体资源操作，包括：
//! - NFO 元数据文件保存
//! - 封面图片下载/截取保存
//! - 视频帧截取（ffmpeg）
//! - 预览截图保存
//! - 文件回滚

use std::fs;
use std::path::{Path, PathBuf};

use crate::nfo::generator::NfoGenerator;
use crate::resource_scrape::types::ScrapeMetadata;

const EXTRAFANART_DIR_NAME: &str = "extrafanart";
const SUBTITLE_EXTENSIONS: &[&str] = &[
    "srt", "ass", "ssa", "vtt", "sub", "idx", "smi", "sup", "sbv", "dfxp", "ttml",
    "scc", "usf",
];

#[derive(Debug, Clone)]
pub struct RelocatedVideoAssets {
    pub original_video_path: String,
    pub video_path: String,
    pub dir_path: String,
    pub poster: Option<String>,
    pub thumb: Option<String>,
    pub fanart: Option<String>,
}

// ============================================================
// NFO 元数据
// ============================================================

/// 统一的 NFO 保存逻辑：检查本地封面是否存在，然后调用 NfoGenerator 生成 NFO 文件
///
/// 供 queue_manager、commands 等模块复用，避免重复实现。
pub fn save_nfo_for_video(video_path: &str, metadata: &ScrapeMetadata) -> Result<(), String> {
    let path = Path::new(video_path);
    let generator = NfoGenerator::new();

    let parent_dir = path.parent().ok_or("无效的视频路径")?;
    let file_stem = path
        .file_stem()
        .ok_or("无效的视频文件名")?
        .to_string_lossy();

    let poster_filename = format!("{}-poster.jpg", file_stem);
    let poster_path = parent_dir.join(&poster_filename);
    let local_poster = if poster_path.exists() {
        Some(poster_filename.as_str())
    } else {
        None
    };

    generator.save(metadata, path, local_poster).map(|_| ())
}

pub fn has_same_named_parent_dir(video_path: &Path) -> bool {
    let Some(parent_dir) = video_path.parent() else {
        return false;
    };
    let Some(parent_name) = parent_dir.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(file_stem) = video_path.file_stem().and_then(|name| name.to_str()) else {
        return false;
    };

    parent_name.eq_ignore_ascii_case(file_stem)
}

fn is_subtitle_suffix_separator(ch: char) -> bool {
    matches!(ch, '.' | '_' | '-' | ' ' | '[' | '(')
}

fn is_matching_subtitle_file(video_path: &Path, candidate: &Path) -> bool {
    let Some(video_parent) = video_path.parent() else {
        return false;
    };
    let Some(candidate_parent) = candidate.parent() else {
        return false;
    };
    if video_parent != candidate_parent {
        return false;
    }

    let Some(extension) = candidate.extension().and_then(|ext| ext.to_str()) else {
        return false;
    };
    if !SUBTITLE_EXTENSIONS
        .iter()
        .any(|item| item.eq_ignore_ascii_case(extension))
    {
        return false;
    }

    let Some(video_stem) = video_path.file_stem().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(candidate_stem) = candidate.file_stem().and_then(|name| name.to_str()) else {
        return false;
    };

    let video_stem_lower = video_stem.to_ascii_lowercase();
    let candidate_stem_lower = candidate_stem.to_ascii_lowercase();

    candidate_stem_lower == video_stem_lower
        || candidate_stem_lower
            .strip_prefix(&video_stem_lower)
            .is_some_and(|suffix| {
                suffix
                    .chars()
                    .next()
                    .is_some_and(is_subtitle_suffix_separator)
            })
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dest_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            fs::copy(entry.path(), &dest_path)?;
        }
    }
    Ok(())
}

fn move_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(src, dst)?;
            fs::remove_file(src)?;
            Ok(())
        }
    }
}

fn move_dir(src: &Path, dst: &Path) -> Result<(), String> {
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => {
            copy_dir_recursive(src, dst).map_err(|e| format!("复制目录失败: {}", e))?;
            fs::remove_dir_all(src).map_err(|e| format!("删除原目录失败: {}", e))?;
            Ok(())
        }
    }
}

fn resolve_asset_source(video_path: &Path, explicit_path: Option<&str>, suffix: &str) -> Option<PathBuf> {
    explicit_path
        .map(PathBuf::from)
        .filter(|path| path.exists() && path.is_file())
        .or_else(|| find_sibling_artwork(video_path, suffix).map(PathBuf::from))
}

fn move_optional_asset(source: Option<PathBuf>, target_dir: &Path, label: &str) -> Option<String> {
    let source = source?;
    let file_name = match source.file_name() {
        Some(file_name) => file_name,
        None => {
            eprintln!("移动{}失败: 无效的文件名 {:?}", label, source);
            return None;
        }
    };

    let target = target_dir.join(file_name);
    if target.exists() && !source.exists() {
        return Some(target.to_string_lossy().to_string());
    }

    if source == target {
        return Some(target.to_string_lossy().to_string());
    }

    if !source.exists() {
        return None;
    }

    match move_file(&source, &target) {
        Ok(()) => Some(target.to_string_lossy().to_string()),
        Err(error) => {
            eprintln!("移动{}失败 {:?} -> {:?}: {}", label, source, target, error);
            None
        }
    }
}

fn move_matching_subtitle_files(video_path: &Path, target_dir: &Path) {
    let Some(parent_dir) = video_path.parent() else {
        return;
    };

    let Ok(entries) = fs::read_dir(parent_dir) else {
        return;
    };

    for entry in entries.flatten() {
        let candidate = entry.path();
        if !is_matching_subtitle_file(video_path, &candidate) {
            continue;
        }

        let Some(file_name) = candidate.file_name() else {
            continue;
        };
        let target = target_dir.join(file_name);
        if let Err(error) = move_file(&candidate, &target) {
            eprintln!("移动字幕失败 {:?} -> {:?}: {}", candidate, target, error);
        }
    }
}

#[derive(Debug, Clone)]
struct PendingRenameOperation {
    source: PathBuf,
    target: PathBuf,
    is_dir: bool,
}

fn is_same_path_for_fs(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

fn sanitize_title_for_path(title: &str) -> Result<String, String> {
    let sanitized = title
        .trim()
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect::<String>()
        .trim()
        .trim_end_matches(['.', ' '])
        .to_string();

    if sanitized.is_empty() {
        return Err("标题为空或包含非法字符，无法作为文件名".to_string());
    }

    Ok(sanitized)
}

fn remap_path_after_dir_rename(path: &Path, old_dir: &Path, new_dir: &Path) -> PathBuf {
    match path.strip_prefix(old_dir) {
        Ok(relative) => new_dir.join(relative),
        Err(_) => path.to_path_buf(),
    }
}

fn build_artwork_target_path(source: &Path, target_dir: &Path, new_stem: &str, suffix: &str) -> Option<PathBuf> {
    let extension = source.extension()?.to_str()?;
    Some(target_dir.join(format!("{}-{}.{}", new_stem, suffix, extension)))
}

fn queue_optional_file_rename(
    operations: &mut Vec<PendingRenameOperation>,
    source: Option<PathBuf>,
    target: Option<PathBuf>,
) {
    let (Some(source), Some(target)) = (source, target) else {
        return;
    };

    if is_same_path_for_fs(&source, &target) {
        return;
    }

    operations.push(PendingRenameOperation {
        source,
        target,
        is_dir: false,
    });
}

fn queue_matching_subtitle_renames(
    operations: &mut Vec<PendingRenameOperation>,
    video_path: &Path,
    old_dir: &Path,
    target_dir: &Path,
    new_stem: &str,
    rename_parent_dir: bool,
) {
    let Some(parent_dir) = video_path.parent() else {
        return;
    };

    let Some(video_stem) = video_path.file_stem().and_then(|name| name.to_str()) else {
        return;
    };

    let Ok(entries) = fs::read_dir(parent_dir) else {
        return;
    };

    for entry in entries.flatten() {
        let source = entry.path();
        if !is_matching_subtitle_file(video_path, &source) {
            continue;
        }

        let extension = match source.extension().and_then(|ext| ext.to_str()) {
            Some(extension) => extension.to_string(),
            None => continue,
        };

        let candidate_stem = match source.file_stem().and_then(|name| name.to_str()) {
            Some(stem) => stem,
            None => continue,
        };

        let suffix = candidate_stem
            .strip_prefix(video_stem)
            .map(str::to_string)
            .or_else(|| {
                let video_stem_lower = video_stem.to_ascii_lowercase();
                let candidate_stem_lower = candidate_stem.to_ascii_lowercase();
                candidate_stem_lower
                    .strip_prefix(&video_stem_lower)
                    .map(|rest| candidate_stem[candidate_stem.len() - rest.len()..].to_string())
            })
            .unwrap_or_default();

        let remapped_source = if rename_parent_dir {
            remap_path_after_dir_rename(&source, old_dir, target_dir)
        } else {
            source.clone()
        };
        let target = target_dir.join(format!("{}{}.{}", new_stem, suffix, extension));

        if is_same_path_for_fs(&remapped_source, &target) {
            continue;
        }

        operations.push(PendingRenameOperation {
            source: remapped_source,
            target,
            is_dir: false,
        });
    }
}

fn rollback_rename_operations(completed: &[PendingRenameOperation]) {
    for operation in completed.iter().rev() {
        if !operation.target.exists() {
            continue;
        }

        if let Some(parent) = operation.source.parent() {
            let _ = fs::create_dir_all(parent);
        }

        let rollback_result = if operation.is_dir {
            move_dir(&operation.target, &operation.source)
        } else {
            move_file(&operation.target, &operation.source)
                .map_err(|error| format!("回滚文件失败: {}", error))
        };

        if let Err(error) = rollback_result {
            eprintln!(
                "回滚重命名失败 {:?} <- {:?}: {}",
                operation.source, operation.target, error
            );
        }
    }
}

fn execute_rename_operations(operations: &[PendingRenameOperation]) -> Result<(), String> {
    let mut completed = Vec::new();

    for operation in operations {
        if let Some(parent) = operation.target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
        }

        if operation.target.exists() && !is_same_path_for_fs(&operation.source, &operation.target) {
            rollback_rename_operations(&completed);
            return Err(format!("目标已存在，无法重命名: {}", operation.target.display()));
        }

        let result = if operation.is_dir {
            move_dir(&operation.source, &operation.target)
        } else {
            move_file(&operation.source, &operation.target)
                .map_err(|e| format!("重命名文件失败: {}", e))
        };

        if let Err(error) = result {
            rollback_rename_operations(&completed);
            return Err(format!(
                "重命名失败: {} -> {}: {}",
                operation.source.display(),
                operation.target.display(),
                error
            ));
        }

        completed.push(operation.clone());
    }

    Ok(())
}

pub fn rename_video_assets_with_title(
    video_path: &str,
    new_title: &str,
    poster: Option<&str>,
    thumb: Option<&str>,
    fanart: Option<&str>,
) -> Result<Option<RelocatedVideoAssets>, String> {
    let video_path_obj = Path::new(video_path);
    if !video_path_obj.exists() {
        return Err("源视频文件不存在".to_string());
    }

    let old_dir = video_path_obj.parent().ok_or("无效的视频路径")?;
    let old_stem = video_path_obj
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or("无效的视频文件名")?;
    let new_stem = sanitize_title_for_path(new_title)?;
    let current_parent_name = old_dir.file_name().and_then(|name| name.to_str());
    let already_in_target_parent = current_parent_name
        .is_some_and(|name| name.eq_ignore_ascii_case(&new_stem));

    let rename_parent_dir = old_dir
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case(old_stem));

    let target_dir = if already_in_target_parent {
        old_dir.to_path_buf()
    } else if rename_parent_dir {
        let parent_of_parent = old_dir.parent().ok_or("无效的父目录")?;
        parent_of_parent.join(&new_stem)
    } else {
        old_dir.join(&new_stem)
    };

    let current_video_path = if rename_parent_dir {
        remap_path_after_dir_rename(video_path_obj, old_dir, &target_dir)
    } else {
        video_path_obj.to_path_buf()
    };

    let new_file_name = match video_path_obj.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if !ext.is_empty() => format!("{}.{}", new_stem, ext),
        _ => new_stem.clone(),
    };
    let new_video_path = target_dir.join(new_file_name);

    if already_in_target_parent && is_same_path_for_fs(&current_video_path, &new_video_path) {
        return Ok(None);
    }

    let actual_poster_source = resolve_asset_source(video_path_obj, poster, "poster");
    let actual_thumb_source = resolve_asset_source(video_path_obj, thumb, "thumb");
    let actual_fanart_source = resolve_asset_source(video_path_obj, fanart, "fanart");

    let poster_source = actual_poster_source
        .as_ref()
        .map(|path| remap_path_after_dir_rename(path, old_dir, &target_dir));
    let thumb_source = actual_thumb_source
        .as_ref()
        .map(|path| remap_path_after_dir_rename(path, old_dir, &target_dir));
    let fanart_source = actual_fanart_source
        .as_ref()
        .map(|path| remap_path_after_dir_rename(path, old_dir, &target_dir));

    let poster_target = poster_source
        .as_ref()
        .and_then(|source| build_artwork_target_path(source, &target_dir, &new_stem, "poster"));
    let thumb_target = thumb_source
        .as_ref()
        .and_then(|source| build_artwork_target_path(source, &target_dir, &new_stem, "thumb"));
    let fanart_target = fanart_source
        .as_ref()
        .and_then(|source| build_artwork_target_path(source, &target_dir, &new_stem, "fanart"));

    let mut operations = Vec::new();
    if rename_parent_dir && !is_same_path_for_fs(old_dir, &target_dir) {
        operations.push(PendingRenameOperation {
            source: old_dir.to_path_buf(),
            target: target_dir.clone(),
            is_dir: true,
        });
    }

    if !is_same_path_for_fs(&current_video_path, &new_video_path) {
        operations.push(PendingRenameOperation {
            source: current_video_path.clone(),
            target: new_video_path.clone(),
            is_dir: false,
        });
    }

    let actual_nfo_source = video_path_obj.with_extension("nfo");
    let current_nfo = if rename_parent_dir {
        remap_path_after_dir_rename(&actual_nfo_source, old_dir, &target_dir)
    } else {
        actual_nfo_source.clone()
    };
    let new_nfo = new_video_path.with_extension("nfo");
    if actual_nfo_source.exists() && !is_same_path_for_fs(&current_nfo, &new_nfo) {
        operations.push(PendingRenameOperation {
            source: current_nfo,
            target: new_nfo,
            is_dir: false,
        });
    }

    queue_optional_file_rename(&mut operations, poster_source.clone(), poster_target.clone());
    queue_optional_file_rename(&mut operations, thumb_source.clone(), thumb_target.clone());
    queue_optional_file_rename(&mut operations, fanart_source.clone(), fanart_target.clone());

    if !rename_parent_dir {
        let extrafanart_source = old_dir.join(EXTRAFANART_DIR_NAME);
        let extrafanart_target = target_dir.join(EXTRAFANART_DIR_NAME);
        if extrafanart_source.exists() && extrafanart_source.is_dir()
            && !is_same_path_for_fs(&extrafanart_source, &extrafanart_target)
        {
            operations.push(PendingRenameOperation {
                source: extrafanart_source,
                target: extrafanart_target,
                is_dir: true,
            });
        }
    }

    queue_matching_subtitle_renames(
        &mut operations,
        video_path_obj,
        old_dir,
        &target_dir,
        &new_stem,
        rename_parent_dir,
    );

    if operations.is_empty() {
        return Ok(None);
    }

    execute_rename_operations(&operations)?;

    Ok(Some(RelocatedVideoAssets {
        original_video_path: video_path.to_string(),
        video_path: new_video_path.to_string_lossy().to_string(),
        dir_path: target_dir.to_string_lossy().to_string(),
        poster: poster_target
            .or(poster_source)
            .map(|path| path.to_string_lossy().to_string()),
        thumb: thumb_target
            .or(thumb_source)
            .map(|path| path.to_string_lossy().to_string()),
        fanart: fanart_target
            .or(fanart_source)
            .map(|path| path.to_string_lossy().to_string()),
    }))
}

pub fn ensure_video_in_named_parent_dir(
    video_path: &str,
    poster: Option<&str>,
    thumb: Option<&str>,
    fanart: Option<&str>,
) -> Result<Option<RelocatedVideoAssets>, String> {
    let video_path_obj = Path::new(video_path);
    if has_same_named_parent_dir(video_path_obj) {
        return Ok(None);
    }

    let parent_dir = video_path_obj.parent().ok_or("无效的视频路径")?;
    let file_stem = video_path_obj
        .file_stem()
        .ok_or("无效的视频文件名")?
        .to_string_lossy()
        .to_string();
    let file_name = video_path_obj.file_name().ok_or("无效的视频文件名")?;

    let target_dir = parent_dir.join(&file_stem);
    fs::create_dir_all(&target_dir).map_err(|e| format!("创建同名目录失败: {}", e))?;

    let new_video_path = target_dir.join(file_name);
    if new_video_path.exists() {
        return Err(format!(
            "目标目录已存在同名视频文件: {}",
            new_video_path.display()
        ));
    }

    move_file(video_path_obj, &new_video_path).map_err(|e| format!("移动视频文件失败: {}", e))?;

    let current_nfo = video_path_obj.with_extension("nfo");
    if current_nfo.exists() {
        let new_nfo = new_video_path.with_extension("nfo");
        if let Err(error) = move_file(&current_nfo, &new_nfo) {
            eprintln!("移动 NFO 失败 {:?} -> {:?}: {}", current_nfo, new_nfo, error);
        }
    }

    let new_poster = move_optional_asset(
        resolve_asset_source(video_path_obj, poster, "poster"),
        &target_dir,
        "poster",
    );
    let new_thumb = move_optional_asset(
        resolve_asset_source(video_path_obj, thumb, "thumb"),
        &target_dir,
        "thumb",
    );
    let new_fanart = move_optional_asset(
        resolve_asset_source(video_path_obj, fanart, "fanart"),
        &target_dir,
        "fanart",
    );

    let extrafanart_dir = parent_dir.join(EXTRAFANART_DIR_NAME);
    if extrafanart_dir.exists() && extrafanart_dir.is_dir() {
        let target_extrafanart_dir = target_dir.join(EXTRAFANART_DIR_NAME);
        if let Err(error) = move_dir(&extrafanart_dir, &target_extrafanart_dir) {
            eprintln!(
                "移动 extrafanart 目录失败 {:?} -> {:?}: {}",
                extrafanart_dir, target_extrafanart_dir, error
            );
        }
    }

    move_matching_subtitle_files(video_path_obj, &target_dir);

    Ok(Some(RelocatedVideoAssets {
        original_video_path: video_path.to_string(),
        video_path: new_video_path.to_string_lossy().to_string(),
        dir_path: target_dir.to_string_lossy().to_string(),
        poster: new_poster,
        thumb: new_thumb,
        fanart: new_fanart,
    }))
}

pub fn extrafanart_dir_for_video(video_path: &Path) -> Result<PathBuf, String> {
    let parent_dir = video_path.parent().ok_or("无效的视频路径")?;
    Ok(parent_dir.join(EXTRAFANART_DIR_NAME))
}

pub fn find_sibling_artwork(video_path: &Path, suffix: &str) -> Option<String> {
    let parent_dir = video_path.parent()?;
    let file_stem = video_path.file_stem()?.to_string_lossy();

    ["jpg", "jpeg", "png", "webp"]
        .iter()
        .map(|ext| parent_dir.join(format!("{}-{}.{}", file_stem, suffix, ext)))
        .find(|path| path.exists() && path.is_file())
        .map(|path| path.to_string_lossy().to_string())
}

fn is_supported_image_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png" | "webp"))
        .unwrap_or(false)
}

fn parse_fanart_index(path: &Path) -> Option<usize> {
    let stem = path.file_stem()?.to_str()?;
    let suffix = stem.strip_prefix("fanart")?;
    suffix.parse::<usize>().ok()
}

pub fn collect_extrafanart_paths(video_path: &Path) -> Vec<(usize, String)> {
    let extrafanart_dir = match extrafanart_dir_for_video(video_path) {
        Ok(dir) => dir,
        Err(_) => return Vec::new(),
    };

    if !extrafanart_dir.exists() || !extrafanart_dir.is_dir() {
        return Vec::new();
    }

    let mut paths = Vec::new();
    if let Ok(entries) = fs::read_dir(&extrafanart_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || !is_supported_image_file(&path) {
                continue;
            }

            if let Some(index) = parse_fanart_index(&path) {
                paths.push((index, path.to_string_lossy().to_string()));
            }
        }
    }
    paths.sort_by_key(|(index, _)| *index);
    paths
}

pub fn next_extrafanart_index(video_path: &Path) -> usize {
    collect_extrafanart_paths(video_path)
        .into_iter()
        .map(|(index, _)| index)
        .max()
        .unwrap_or(0)
        + 1
}

pub async fn sync_extrafanart_from_urls(
    video_path: &str,
    images: Vec<(usize, String)>,
) -> Result<Vec<String>, String> {
    if images.is_empty() {
        return Ok(Vec::new());
    }

    let video_path = Path::new(video_path);
    let extrafanart_dir = extrafanart_dir_for_video(video_path)?;
    fs::create_dir_all(&extrafanart_dir).map_err(|e| format!("创建 extrafanart 目录失败: {}", e))?;

    let client = crate::utils::proxy::apply_proxy_auto(
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .user_agent("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"),
    )
    .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?
    .build()
    .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let mut saved_paths = Vec::new();
    for (index, url) in images {
        let trimmed = url.trim();
        if trimmed.is_empty() {
            continue;
        }

        let save_path = extrafanart_dir.join(format!("fanart{}.jpg", index));
        if save_path.exists() {
            saved_paths.push(save_path.to_string_lossy().to_string());
            continue;
        }

        match crate::download::image::download_image(&client, trimmed, &save_path).await {
            Ok(path) => saved_paths.push(path),
            Err(e) => eprintln!("下载 extrafanart 图片失败 #{} {}: {}", index, trimmed, e),
        }
    }

    Ok(saved_paths)
}

// ============================================================
// 封面图片
// ============================================================

/// 将截取的视频帧保存为封面图片
///
/// # 参数
/// * `video_path` - 视频文件路径
/// * `frame_path` - 截取的帧图片路径
///
/// # 返回
/// * `Ok(String)` - 保存的封面图片路径
/// * `Err(String)` - 保存失败的错误信息
pub fn save_frame_as_cover_assets(
    video_path: &str,
    frame_path: &str,
) -> Result<(String, String), String> {
    let video_path_obj = Path::new(video_path);
    let parent_dir = video_path_obj.parent().ok_or("无效的视频路径")?;
    let file_stem = video_path_obj
        .file_stem()
        .ok_or("无效的文件名")?
        .to_string_lossy();

    let poster_filename = format!("{}-poster.jpg", file_stem);
    let poster_path = parent_dir.join(&poster_filename);
    let thumb_filename = format!("{}-thumb.jpg", file_stem);
    let thumb_path = parent_dir.join(&thumb_filename);

    fs::copy(frame_path, &poster_path).map_err(|e| format!("保存 poster 失败: {}", e))?;
    fs::copy(frame_path, &thumb_path).map_err(|e| format!("保存 thumb 失败: {}", e))?;

    Ok((
        poster_path.to_string_lossy().to_string(),
        thumb_path.to_string_lossy().to_string(),
    ))
}

pub fn save_frame_as_cover(video_path: &str, frame_path: &str) -> Result<String, String> {
    let (_, thumb_path) = save_frame_as_cover_assets(video_path, frame_path)?;
    Ok(thumb_path)
}

/// 将截取的多个视频帧保存到 extrafanart 目录
///
/// # 参数
/// * `video_path` - 视频文件路径
/// * `frame_paths` - 截取的帧图片路径列表
///
/// # 返回
/// * `Ok(Vec<String>)` - 保存的预览图路径列表
/// * `Err(String)` - 保存失败的错误信息
pub fn save_frames_to_extrafanart(
    video_path: &str,
    frame_paths: &[String],
) -> Result<Vec<String>, String> {
    let video_path_obj = Path::new(video_path);
    let extrafanart_dir = extrafanart_dir_for_video(video_path_obj)?;
    fs::create_dir_all(&extrafanart_dir).map_err(|e| format!("创建 extrafanart 目录失败: {}", e))?;

    let mut next_index = next_extrafanart_index(video_path_obj);
    let mut thumb_paths = Vec::new();

    for frame_path in frame_paths {
        let thumb_filename = format!("fanart{}.jpg", next_index);
        let thumb_path = extrafanart_dir.join(&thumb_filename);

        fs::copy(frame_path, &thumb_path)
            .map_err(|e| format!("保存预览图 {} 失败: {}", next_index, e))?;

        thumb_paths.push(thumb_path.to_string_lossy().to_string());
        next_index += 1;
    }

    Ok(thumb_paths)
}

// ============================================================
// 视频帧截取 (ffmpeg)
// ============================================================

/// 从视频中随机截取指定数量的帧
///
/// 将视频时长均匀分段，在每段内随机选择时间点，覆盖 0%~100% 范围。
/// 需要系统安装 ffmpeg。
///
/// # 参数
/// * `video_path` - 视频文件路径
/// * `count` - 要截取的帧数量
// 已抽离至 crate::utils::ffmpeg

// ============================================================
// 文件回滚
// ============================================================

/// 回滚文件操作，删除已创建的文件
///
/// 当数据库操作失败时调用此函数，以确保文件系统和数据库之间的数据一致性
#[allow(dead_code)]
pub fn rollback_files(
    nfo_path: Option<&std::path::PathBuf>,
    cover_path: Option<&str>,
    thumbs_dir: Option<&std::path::PathBuf>,
) {
    if let Some(nfo) = nfo_path {
        if nfo.exists() {
            match fs::remove_file(nfo) {
                Ok(_) => println!("回滚: 已删除 NFO 文件: {:?}", nfo),
                Err(e) => eprintln!("回滚: 删除 NFO 文件失败 {:?}: {}", nfo, e),
            }
        }
    }

    if let Some(cover) = cover_path {
        if !cover.trim().is_empty() {
            let cover_path_obj = Path::new(cover);
            if cover_path_obj.exists() {
                match fs::remove_file(cover_path_obj) {
                    Ok(_) => println!("回滚: 已删除封面图片: {}", cover),
                    Err(e) => eprintln!("回滚: 删除封面图片失败 {}: {}", cover, e),
                }
            }
        }
    }

    if let Some(thumbs) = thumbs_dir {
        if thumbs.exists() {
            match fs::remove_dir_all(thumbs) {
                Ok(_) => println!("回滚: 已删除缩略图目录: {:?}", thumbs),
                Err(e) => eprintln!("回滚: 删除缩略图目录失败 {:?}: {}", thumbs, e),
            }
        }
    }
}

// ============================================================
// 测试
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    #[test]
    fn test_rollback_files_deletes_nfo() {
        let temp_dir = std::env::temp_dir();
        let nfo_path = temp_dir.join("test_video.nfo");

        let mut file = fs::File::create(&nfo_path).unwrap();
        file.write_all(b"test nfo content").unwrap();
        drop(file);

        assert!(nfo_path.exists());
        rollback_files(Some(&nfo_path), None, None);
        assert!(!nfo_path.exists());
    }

    #[test]
    fn test_rollback_files_deletes_cover() {
        let temp_dir = std::env::temp_dir();
        let cover_path = temp_dir.join("test_video-poster.jpg");

        let mut file = fs::File::create(&cover_path).unwrap();
        file.write_all(b"fake image data").unwrap();
        drop(file);

        assert!(cover_path.exists());
        let cover_str = cover_path.to_string_lossy().to_string();
        rollback_files(None, Some(&cover_str), None);
        assert!(!cover_path.exists());
    }

    #[test]
    fn test_rollback_files_deletes_thumbs_directory() {
        let temp_dir = std::env::temp_dir();
        let thumbs_dir = temp_dir.join("test_thumbs");
        fs::create_dir_all(&thumbs_dir).unwrap();

        for i in 1..=3 {
            let thumb_path = thumbs_dir.join(format!("thumb_{:03}.jpg", i));
            let mut file = fs::File::create(&thumb_path).unwrap();
            file.write_all(b"fake thumb data").unwrap();
        }

        assert!(thumbs_dir.exists());
        assert_eq!(fs::read_dir(&thumbs_dir).unwrap().count(), 3);

        rollback_files(None, None, Some(&thumbs_dir));
        assert!(!thumbs_dir.exists());
    }

    #[test]
    fn test_rollback_files_deletes_all() {
        let temp_dir = std::env::temp_dir();
        let nfo_path = temp_dir.join("test_all.nfo");
        let cover_path = temp_dir.join("test_all-poster.jpg");
        let thumbs_dir = temp_dir.join("test_all_thumbs");

        fs::File::create(&nfo_path)
            .unwrap()
            .write_all(b"nfo")
            .unwrap();
        fs::File::create(&cover_path)
            .unwrap()
            .write_all(b"cover")
            .unwrap();
        fs::create_dir_all(&thumbs_dir).unwrap();
        fs::File::create(thumbs_dir.join("thumb_001.jpg"))
            .unwrap()
            .write_all(b"thumb")
            .unwrap();

        assert!(nfo_path.exists());
        assert!(cover_path.exists());
        assert!(thumbs_dir.exists());

        let cover_str = cover_path.to_string_lossy().to_string();
        rollback_files(Some(&nfo_path), Some(&cover_str), Some(&thumbs_dir));

        assert!(!nfo_path.exists());
        assert!(!cover_path.exists());
        assert!(!thumbs_dir.exists());
    }

    #[test]
    fn test_rollback_files_handles_nonexistent_files() {
        let temp_dir = std::env::temp_dir();
        let nonexistent_nfo = temp_dir.join("nonexistent.nfo");
        let nonexistent_cover = temp_dir.join("nonexistent-poster.jpg");
        let nonexistent_thumbs = temp_dir.join("nonexistent_thumbs");

        assert!(!nonexistent_nfo.exists());
        assert!(!nonexistent_cover.exists());
        assert!(!nonexistent_thumbs.exists());

        let cover_str = nonexistent_cover.to_string_lossy().to_string();
        rollback_files(
            Some(&nonexistent_nfo),
            Some(&cover_str),
            Some(&nonexistent_thumbs),
        );

        assert!(!nonexistent_nfo.exists());
        assert!(!nonexistent_cover.exists());
        assert!(!nonexistent_thumbs.exists());
    }
}
