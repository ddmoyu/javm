//! 元数据存储布局与刮削产物落地
//!
//! 决定 NFO / 图集 / 预览图写到哪里——跟随视频同级，或独立元数据目录 `<root>/<番号 标题>/` + `.strm`——
//! 并提供三处刮削流程（详情保存 / 队列 / 下载后自动刮削）共用的统一落地编排 [`write_scraped_media`]。

use std::fs;
use std::path::{Path, PathBuf};

use crate::media::artwork::ArtworkResult;
use crate::resource_scrape::types::ScrapeMetadata;

// ============================================================
// 存储配置与落地目标
// ============================================================

/// 元数据存储配置，从 `AppSettings.metadata` 派生
#[derive(Debug, Clone)]
pub struct MetadataStorageConfig {
    /// 是否启用独立目录模式
    pub independent: bool,
    /// 独立目录模式下的元数据根目录
    pub root_dir: String,
}

impl MetadataStorageConfig {
    pub fn from_settings(settings: &crate::settings::AppSettings) -> Self {
        Self {
            independent: settings.metadata.is_independent(),
            root_dir: settings.metadata.root_dir.trim().to_string(),
        }
    }
}

/// 独立目录模式下需写入的 .strm 规格
#[derive(Debug, Clone)]
pub struct StrmSpec {
    /// .strm 文件路径
    pub path: PathBuf,
    /// 单行内容：视频真实绝对路径
    pub video_abs_path: String,
}

/// 元数据资产落地目标：NFO / 图片 / extrafanart 写到哪里、用什么文件名 stem
#[derive(Debug, Clone)]
pub struct MediaAssetTarget {
    /// NFO / poster / fanart / extrafanart 的落地目录
    pub dir: PathBuf,
    /// 文件名 stem（NFO = `<stem>.nfo`，封面 = `<stem>-poster.jpg`）
    pub stem: String,
    /// 独立目录模式下需写入的 .strm（跟随视频模式为 None）
    pub strm: Option<StrmSpec>,
}

/// 清洗为合法路径片段：替换 Windows 非法字符、折叠空白、截断长度、去尾部点/空格。
/// 永不返回错误，空串回退到 `fallback`。
fn sanitize_path_component(raw: &str, fallback: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let folded = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    // 截断到安全长度（按字符），避免 Windows 路径过长
    let truncated: String = folded.chars().take(100).collect();
    let trimmed = truncated.trim().trim_end_matches(['.', ' ']).to_string();
    if trimmed.is_empty() {
        fallback.trim().trim_end_matches(['.', ' ']).to_string()
    } else {
        trimmed
    }
}

/// 构造独立目录名：`番号 标题`（标题为空时退化为纯番号）
fn build_independent_folder_name(local_id: &str, title: &str) -> String {
    let id = local_id.trim();
    let title = title.trim();
    let raw = if title.is_empty() {
        id.to_string()
    } else {
        format!("{} {}", id, title)
    };
    sanitize_path_component(&raw, id)
}

/// 解析元数据资产落地目标。
///
/// - 跟随视频模式：目录 = 视频父目录，stem = 视频文件名，无 .strm。
/// - 独立目录模式（开启 + 根目录非空 + 番号非空）：目录 = `<root>/<番号 标题>/`，
///   stem = 番号，并附带指向视频真实路径的 .strm。条件不满足时自动回退到跟随视频。
pub fn resolve_asset_target(
    video_path: &str,
    local_id: &str,
    title: &str,
    cfg: &MetadataStorageConfig,
) -> Result<MediaAssetTarget, String> {
    let video = Path::new(video_path);
    let video_parent = video.parent().ok_or("无效的视频路径")?;
    let video_stem = video
        .file_stem()
        .ok_or("无效的视频文件名")?
        .to_string_lossy()
        .to_string();

    let local_id = local_id.trim();

    if cfg.independent && !cfg.root_dir.is_empty() && !local_id.is_empty() {
        let folder = build_independent_folder_name(local_id, title);
        let dir = Path::new(&cfg.root_dir).join(folder);
        let stem = sanitize_path_component(local_id, &video_stem);
        let strm = StrmSpec {
            path: dir.join(format!("{}.strm", stem)),
            video_abs_path: video_path.to_string(),
        };
        Ok(MediaAssetTarget {
            dir,
            stem,
            strm: Some(strm),
        })
    } else {
        Ok(MediaAssetTarget {
            dir: video_parent.to_path_buf(),
            stem: video_stem,
            strm: None,
        })
    }
}

/// 确保目标目录存在；独立目录模式下写入（或更新）.strm（内容为视频真实绝对路径，幂等）。
pub fn ensure_asset_dir_and_strm(target: &MediaAssetTarget) -> Result<(), String> {
    fs::create_dir_all(&target.dir)
        .map_err(|e| format!("创建元数据目录失败 {}: {}", target.dir.display(), e))?;

    if let Some(strm) = &target.strm {
        write_strm_if_changed(&strm.path, &strm.video_abs_path)?;
    }
    Ok(())
}

/// 跟随视频模式的落地目录与文件名 stem。
fn follow_video_dir_stem(video_path: &str) -> (PathBuf, String) {
    let p = Path::new(video_path);
    (
        p.parent().map(|x| x.to_path_buf()).unwrap_or_default(),
        p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
    )
}

/// 幂等写入 .strm：内容与目标路径不同才写。
fn write_strm_if_changed(strm_path: &Path, video_abs_path: &str) -> Result<(), String> {
    let want = video_abs_path.trim();
    let need_write = match fs::read_to_string(strm_path) {
        Ok(existing) => existing.trim() != want,
        Err(_) => true,
    };
    if need_write {
        fs::write(strm_path, want)
            .map_err(|e| format!("写入 .strm 文件失败 {}: {}", strm_path.display(), e))?;
    }
    Ok(())
}

// ============================================================
// 独立目录定位（移动/重命名/手动编辑后回写）
// ============================================================

/// 在元数据根目录下定位某番号现有的独立子目录（含 `<番号>.strm`）。
///
/// 子目录名为「番号 标题」可能随标题变化，故按番号前缀筛选、再以 `<番号>.strm` 存在性确认。
/// 返回 `(子目录路径, 文件名 stem)`；非独立模式 / 未配置 / 未找到时返回 None。
fn find_independent_dir(cfg: &MetadataStorageConfig, local_id: &str) -> Option<(PathBuf, String)> {
    if !cfg.independent {
        return None;
    }
    let root = cfg.root_dir.trim();
    let local_id = local_id.trim();
    if root.is_empty() || local_id.is_empty() {
        return None;
    }

    let stem = sanitize_path_component(local_id, local_id);
    let strm_name = format!("{}.strm", stem);
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        if !entry.file_type().map(|ty| ty.is_dir()).unwrap_or(false) {
            continue;
        }
        if !entry.file_name().to_string_lossy().starts_with(&stem) {
            continue;
        }
        let dir = entry.path();
        if dir.join(&strm_name).exists() {
            return Some((dir, stem));
        }
    }
    None
}

/// 解析视频对应的「现有资产目录」与文件名 stem，供读取预览图、截帧落地等流程共用。
///
/// 独立目录模式下优先按番号定位**已存在**的独立子目录（`<root>/<番号 …>/`，以 `<番号>.strm` 确认），
/// 命中则返回 `(独立子目录, 番号)`；未开启 / 未配置 / 番号为空 / **独立目录里找不到该番号子目录**时，
/// 一律回退到视频所在目录 `(视频父目录, 视频文件名)` 作为兜底。
pub fn resolve_existing_asset_dir(
    video_path: &str,
    local_id: &str,
    cfg: &MetadataStorageConfig,
) -> (PathBuf, String) {
    find_independent_dir(cfg, local_id).unwrap_or_else(|| follow_video_dir_stem(video_path))
}

/// 视频移动/重命名后，同步独立目录里对应番号子目录的 `.strm` 内容为新的视频绝对路径。
/// 非独立模式 / 未找到 `.strm` 时静默跳过（不视为错误）。
pub fn sync_independent_strm(
    cfg: &MetadataStorageConfig,
    local_id: &str,
    new_video_path: &str,
) -> Result<(), String> {
    let Some((dir, stem)) = find_independent_dir(cfg, local_id) else {
        return Ok(());
    };
    write_strm_if_changed(&dir.join(format!("{}.strm", stem)), new_video_path)
}

/// 独立目录模式下，把更新后的 NFO 写回视频对应的独立元数据目录（按番号定位现有子目录、
/// 引用该目录内已有图集的本地文件名）。
///
/// 返回 `Ok(true)` = 已写入独立目录；`Ok(false)` = 非独立模式或未找到独立目录（调用方应回退写视频同级）。
pub fn save_nfo_to_independent_dir(
    cfg: &MetadataStorageConfig,
    local_id: &str,
    metadata: &ScrapeMetadata,
) -> Result<bool, String> {
    let Some((dir, stem)) = find_independent_dir(cfg, local_id) else {
        return Ok(false);
    };
    crate::media::assets::save_nfo_to(&dir, &stem, metadata)?;
    Ok(true)
}

// ============================================================
// 刮削产物统一落地
// ============================================================

/// 刮削媒体落地结果（不含数据库写入，由调用方用 `artwork` 写库）。
pub struct MediaWriteOutcome {
    /// 最终图集（本次产出，或失败时的回退图集）
    pub artwork: ArtworkResult,
    /// 本次是否实际产出了新封面
    pub cover_produced: bool,
    /// NFO 是否写入成功
    pub nfo_saved: bool,
    /// 非致命错误（供调用方收集/展示）
    pub errors: Vec<String>,
}

/// 刮削产物统一落地：解析存储目标(独立目录/.strm) → 标准图集 → 预览图 → NFO。
///
/// 三处刮削流程共用。各步失败均不中断、记入 `errors`。本次未产出封面时采用 `fallback_artwork`
/// （保留已有封面，避免清空）。不写数据库——调用方用返回的 `artwork` 写库。
pub async fn write_scraped_media(
    app: &tauri::AppHandle,
    video_path: &str,
    metadata: &ScrapeMetadata,
    fallback_artwork: ArtworkResult,
) -> MediaWriteOutcome {
    let mut errors = Vec::new();

    // 1. 解析落地目标（独立目录 → <root>/<番号 标题>/ + .strm；否则视频同级）
    let settings = crate::settings::get_settings(app.clone()).await.unwrap_or_default();
    let cfg = MetadataStorageConfig::from_settings(&settings);
    let target = resolve_asset_target(video_path, &metadata.local_id, &metadata.title, &cfg)
        .map_err(|e| log::error!("[media] event=resolve_asset_target_failed path={} error={}", video_path, e))
        .ok();
    if let Some(t) = target.as_ref() {
        if let Err(e) = ensure_asset_dir_and_strm(t) {
            log::error!("[media] event=metadata_dir_prepare_failed path={} error={}", video_path, e);
            errors.push(format!("元数据目录/.strm 准备失败: {}", e));
        }
    }
    let (dir, stem) = target
        .as_ref()
        .map(|t| (t.dir.clone(), t.stem.clone()))
        .unwrap_or_else(|| follow_video_dir_stem(video_path));

    // 2. 标准图集 poster(竖)/fanart(横)/thumb(横)
    let produced = crate::media::artwork::produce_artwork(
        &dir,
        &stem,
        &metadata.cover_url,
        &metadata.poster_url,
        None,
    )
    .await;
    let cover_produced = produced.fanart.is_some() || produced.poster.is_some();
    log::info!(
        "[media] event=artwork_done path={} produced={} poster={} fanart={} thumb={}",
        video_path, cover_produced, produced.poster.is_some(), produced.fanart.is_some(), produced.thumb.is_some()
    );
    let artwork = if cover_produced { produced } else { fallback_artwork };

    // 3. 预览图 → extrafanart/
    if !metadata.thumbs.is_empty() {
        let items: Vec<(usize, String)> = metadata
            .thumbs
            .iter()
            .enumerate()
            .map(|(i, url)| (i + 1, url.clone()))
            .collect();
        if let Err(e) = crate::media::assets::sync_extrafanart_to_dir(&dir, items).await {
            log::error!("[media] event=extrafanart_sync_failed path={} error={}", video_path, e);
            errors.push(format!("预览图下载失败: {}", e));
        }
    }

    // 4. NFO（按已落地图集引用本地文件名）
    let nfo_saved = match crate::media::assets::save_nfo_to(&dir, &stem, metadata) {
        Ok(_) => true,
        Err(e) => {
            log::error!("[media] event=nfo_save_failed path={} error={}", video_path, e);
            errors.push(format!("NFO 生成失败: {}", e));
            false
        }
    };

    MediaWriteOutcome { artwork, cover_produced, nfo_saved, errors }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_asset_target_follow_video_mode() {
        let cfg = MetadataStorageConfig { independent: false, root_dir: String::new() };
        let target = resolve_asset_target("/videos/ABC-123.mp4", "ABC-123", "标题", &cfg).unwrap();
        assert_eq!(target.dir, Path::new("/videos"));
        assert_eq!(target.stem, "ABC-123");
        assert!(target.strm.is_none());
    }

    #[test]
    fn resolve_asset_target_independent_mode() {
        let cfg = MetadataStorageConfig { independent: true, root_dir: "/meta".to_string() };
        let target = resolve_asset_target("/videos/raw_name.mp4", "ABC-123", "标题 X", &cfg).unwrap();
        assert_eq!(target.dir, Path::new("/meta").join("ABC-123 标题 X"));
        assert_eq!(target.stem, "ABC-123");
        let strm = target.strm.expect("独立模式应生成 .strm");
        assert_eq!(strm.path, Path::new("/meta").join("ABC-123 标题 X").join("ABC-123.strm"));
        assert_eq!(strm.video_abs_path, "/videos/raw_name.mp4");
    }

    #[test]
    fn resolve_asset_target_independent_falls_back_without_root_or_id() {
        // 根目录为空 → 回退跟随视频
        let cfg_no_root = MetadataStorageConfig { independent: true, root_dir: String::new() };
        let t1 = resolve_asset_target("/videos/ABC-123.mp4", "ABC-123", "标题", &cfg_no_root).unwrap();
        assert!(t1.strm.is_none());
        assert_eq!(t1.dir, Path::new("/videos"));

        // 番号为空 → 回退跟随视频
        let cfg = MetadataStorageConfig { independent: true, root_dir: "/meta".to_string() };
        let t2 = resolve_asset_target("/videos/ABC-123.mp4", "  ", "标题", &cfg).unwrap();
        assert!(t2.strm.is_none());
        assert_eq!(t2.stem, "ABC-123");
    }

    #[test]
    fn build_independent_folder_name_handles_empty_title() {
        assert_eq!(build_independent_folder_name("ABC-123", ""), "ABC-123");
        assert_eq!(build_independent_folder_name("ABC-123", "  "), "ABC-123");
        assert_eq!(build_independent_folder_name("ABC-123", "Hello"), "ABC-123 Hello");
    }

    #[test]
    fn sanitize_path_component_replaces_illegal_chars_and_folds_space() {
        assert_eq!(sanitize_path_component("a/b:c*d?", "fallback"), "a_b_c_d_");
        assert_eq!(sanitize_path_component("   ", "fallback"), "fallback");
        assert_eq!(sanitize_path_component("a   b", "fb"), "a b");
    }

    #[test]
    fn sync_independent_strm_rewrites_matching_strm() {
        let root = std::env::temp_dir().join(format!("javm-strm-test-{}", std::process::id()));
        let sub = root.join("ABC-123 标题文字");
        fs::create_dir_all(&sub).unwrap();
        let strm = sub.join("ABC-123.strm");
        fs::write(&strm, "D:\\old\\ABC-123.mp4").unwrap();

        let cfg = MetadataStorageConfig {
            independent: true,
            root_dir: root.to_string_lossy().to_string(),
        };
        sync_independent_strm(&cfg, "ABC-123", "E:\\new\\ABC-123.mp4").unwrap();
        assert_eq!(fs::read_to_string(&strm).unwrap().trim(), "E:\\new\\ABC-123.mp4");

        // 非独立模式：跳过，不改动
        let cfg_off = MetadataStorageConfig {
            independent: false,
            root_dir: root.to_string_lossy().to_string(),
        };
        sync_independent_strm(&cfg_off, "ABC-123", "X").unwrap();
        assert_eq!(fs::read_to_string(&strm).unwrap().trim(), "E:\\new\\ABC-123.mp4");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_existing_asset_dir_locates_independent_dir() {
        let root = std::env::temp_dir().join(format!("javm-existdir-test-{}", std::process::id()));
        let sub = root.join("ABC-123 标题文字");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("ABC-123.strm"), "D:\\v\\raw_name.mp4").unwrap();

        let cfg = MetadataStorageConfig {
            independent: true,
            root_dir: root.to_string_lossy().to_string(),
        };

        // 命中：独立目录存在 → 返回 (独立子目录, 番号)
        let (dir, stem) = resolve_existing_asset_dir("D:\\v\\raw_name.mp4", "ABC-123", &cfg);
        assert_eq!(dir, sub);
        assert_eq!(stem, "ABC-123");

        // 找不到该番号的独立目录 → 回退视频所在目录(stem=视频文件名)
        let (dir2, stem2) = resolve_existing_asset_dir("D:\\v\\raw_name.mp4", "ZZZ-999", &cfg);
        assert_eq!(dir2, Path::new("D:\\v"));
        assert_eq!(stem2, "raw_name");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_existing_asset_dir_falls_back_when_not_independent() {
        // 未开启独立模式 → 恒回退视频所在目录
        let cfg = MetadataStorageConfig {
            independent: false,
            root_dir: String::new(),
        };
        let (dir, stem) = resolve_existing_asset_dir("/videos/ABC-123.mp4", "ABC-123", &cfg);
        assert_eq!(dir, Path::new("/videos"));
        assert_eq!(stem, "ABC-123");
    }

    #[test]
    fn save_nfo_to_independent_dir_writes_into_located_dir() {
        let root = std::env::temp_dir().join(format!("javm-indnfo-test-{}", std::process::id()));
        let sub = root.join("ABC-123 标题");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("ABC-123.strm"), "D:\\v\\ABC-123.mp4").unwrap();

        let cfg = MetadataStorageConfig {
            independent: true,
            root_dir: root.to_string_lossy().to_string(),
        };
        let meta = ScrapeMetadata {
            local_id: "ABC-123".to_string(),
            title: "标题".to_string(),
            ..Default::default()
        };

        // 独立目录存在 → 写入 <番号>.nfo 并返回 true
        assert!(save_nfo_to_independent_dir(&cfg, "ABC-123", &meta).unwrap());
        assert!(sub.join("ABC-123.nfo").exists());

        // 非独立模式 → 返回 false，不写
        let cfg_off = MetadataStorageConfig {
            independent: false,
            root_dir: root.to_string_lossy().to_string(),
        };
        assert!(!save_nfo_to_independent_dir(&cfg_off, "ABC-123", &meta).unwrap());

        let _ = fs::remove_dir_all(&root);
    }
}
