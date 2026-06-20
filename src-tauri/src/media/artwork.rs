//! 标准化图集（媒体库对齐）
//!
//! 产出 Emby / Kodi / Jellyfin / JavSP 通用的图集文件集，媒体库按**文件名约定**发现
//! （本地文件优先于 NFO 内 URL）：
//! - `<stem>-poster.jpg` 竖版海报（2:3，海报墙主图）
//! - `<stem>-fanart.jpg` 横版背景大图（详情页背景）
//! - `<stem>-thumb.jpg`  横版缩略
//!
//! JAV 数据源几乎只提供横版大封面，竖版海报按行业做法从横版**右侧裁切**生成，
//! 保证 Emby/Kodi 海报墙有真实竖版文件可用（源若直接提供竖版则优先采用）。

use std::path::{Path, PathBuf};
use wreq::Client as HttpClient;

/// 竖版海报后缀
pub const POSTER_SUFFIX: &str = "poster";
/// 横版背景图后缀
pub const FANART_SUFFIX: &str = "fanart";
/// 横版缩略图后缀
pub const THUMB_SUFFIX: &str = "thumb";

/// 竖版海报宽高比（378:538，JAV 行业封面右侧裁切的标准比例，与前端 constants.ts 一致）
const POSTER_ASPECT_W_OVER_H: f32 = 378.0 / 538.0;

/// 产出的图集本地绝对路径（缺项为 None）
#[derive(Debug, Clone, Default)]
pub struct ArtworkResult {
    /// 竖版海报
    pub poster: Option<String>,
    /// 横版背景大图
    pub fanart: Option<String>,
    /// 横版缩略
    pub thumb: Option<String>,
}

impl ArtworkResult {
    /// 用于数据库封面尺寸的代表图：横版优先（默认展示），回退竖版
    pub fn primary_dimension_path(&self) -> Option<&str> {
        self.fanart.as_deref().or(self.thumb.as_deref()).or(self.poster.as_deref())
    }
}

/// 读取图片尺寸（仅读图头，开销小）。路径为空/读取失败返回 `(None, None)`。
pub fn read_image_dimensions(path: Option<&str>) -> (Option<i32>, Option<i32>) {
    match path {
        Some(p) if !p.trim().is_empty() => match image::image_dimensions(p) {
            Ok((w, h)) if w > 0 && h > 0 => (Some(w as i32), Some(h as i32)),
            _ => (None, None),
        },
        _ => (None, None),
    }
}

/// 图集文件路径：`<dir>/<stem>-<suffix>.jpg`
pub fn artwork_path(dir: &Path, stem: &str, suffix: &str) -> PathBuf {
    dir.join(format!("{}-{}.jpg", stem, suffix))
}

/// 从远程/缓存 URL 产出标准图集。
///
/// 流程：
/// 1. 下载横版大图（`cover_url` 优先，回退 `poster_url`）→ `fanart`。
/// 2. 复制 `fanart` → `thumb`。
/// 3. 竖版海报：源竖版优先（`poster_url` 与 `cover_url` 不同且下载后为竖版）→ 否则从横版右裁。
///
/// `dir` 须已存在。任一步失败不阻断其余步骤，缺项返回 None。
pub async fn produce_artwork(
    dir: &Path,
    stem: &str,
    cover_url: &str,
    poster_url: &str,
    client: Option<&HttpClient>,
) -> ArtworkResult {
    let mut result = ArtworkResult::default();

    // 1. 横版大图（fanart）：cover_url 优先，回退 poster_url
    let landscape_url = if !cover_url.trim().is_empty() {
        cover_url
    } else {
        poster_url
    };
    if landscape_url.trim().is_empty() {
        return result;
    }

    let fanart_path = artwork_path(dir, stem, FANART_SUFFIX);
    match crate::download::image::save_image_url_to(landscape_url, &fanart_path, client).await {
        Ok(path) if !path.is_empty() => result.fanart = Some(path),
        Ok(_) => return result,
        Err(e) => {
            log::error!("[artwork] event=fanart_download_failed stem={} error={}", stem, e);
            return result;
        }
    }
    let fanart_path = match result.fanart.as_deref() {
        Some(p) => PathBuf::from(p),
        None => return result,
    };

    // 2. 横版缩略（thumb）= 复制 fanart
    let thumb_path = artwork_path(dir, stem, THUMB_SUFFIX);
    match std::fs::copy(&fanart_path, &thumb_path) {
        Ok(_) => result.thumb = Some(thumb_path.to_string_lossy().to_string()),
        Err(e) => log::error!("[artwork] event=thumb_copy_failed stem={} error={}", stem, e),
    }

    // 3. 竖版海报（poster）：源竖版优先 → 横版右裁兜底
    let poster_path = artwork_path(dir, stem, POSTER_SUFFIX);
    let from_source = save_native_portrait(&poster_path, cover_url, poster_url, client).await;
    if from_source || crop_landscape_to_poster(&fanart_path, &poster_path) {
        result.poster = Some(poster_path.to_string_lossy().to_string());
    }

    result
}

/// 从本地横版图（如 ffmpeg 截帧）产出标准图集：横版作 fanart + thumb，竖版右裁自横版。
pub fn produce_artwork_from_local_image(dir: &Path, stem: &str, source: &Path) -> ArtworkResult {
    let mut result = ArtworkResult::default();

    let fanart_path = artwork_path(dir, stem, FANART_SUFFIX);
    if let Err(e) = std::fs::copy(source, &fanart_path) {
        log::error!("[artwork] event=fanart_copy_failed stem={} error={}", stem, e);
        return result;
    }
    result.fanart = Some(fanart_path.to_string_lossy().to_string());

    let thumb_path = artwork_path(dir, stem, THUMB_SUFFIX);
    match std::fs::copy(&fanart_path, &thumb_path) {
        Ok(_) => result.thumb = Some(thumb_path.to_string_lossy().to_string()),
        Err(e) => log::error!("[artwork] event=thumb_copy_failed stem={} error={}", stem, e),
    }

    let poster_path = artwork_path(dir, stem, POSTER_SUFFIX);
    if crop_landscape_to_poster(&fanart_path, &poster_path) {
        result.poster = Some(poster_path.to_string_lossy().to_string());
    }

    result
}

/// 若 `poster_url` 与 `cover_url` 不同，且下载后确为竖版（高>宽），则保存为真实竖版海报。
/// 成功返回 true（海报已落地于 `poster_path`）；否则清理并返回 false（交由裁切兜底）。
async fn save_native_portrait(
    poster_path: &Path,
    cover_url: &str,
    poster_url: &str,
    client: Option<&HttpClient>,
) -> bool {
    let poster_url = poster_url.trim();
    if poster_url.is_empty() || poster_url == cover_url.trim() {
        return false;
    }

    match crate::download::image::save_image_url_to(poster_url, poster_path, client).await {
        Ok(path) if !path.is_empty() => {
            let is_portrait = matches!(image::image_dimensions(poster_path), Ok((w, h)) if h > w);
            if is_portrait {
                true
            } else {
                // 横版/方形，弃用，交由裁切兜底
                let _ = std::fs::remove_file(poster_path);
                false
            }
        }
        _ => {
            let _ = std::fs::remove_file(poster_path);
            false
        }
    }
}

/// 从横版图右侧裁切出竖版海报（JAV 封面右半为正面竖版海报），保存为 JPEG。
fn crop_landscape_to_poster(src: &Path, dst: &Path) -> bool {
    // 按内容（magic bytes）而非扩展名判定格式：下载的封面可能是 webp/png 却命名为 .jpg
    let img = match image::ImageReader::open(src)
        .and_then(|reader| reader.with_guessed_format())
    {
        Ok(reader) => match reader.decode() {
            Ok(img) => img,
            Err(e) => {
                log::error!("[artwork] event=poster_decode_failed src={} error={}", src.display(), e);
                return false;
            }
        },
        Err(e) => {
            log::error!("[artwork] event=poster_open_failed src={} error={}", src.display(), e);
            return false;
        }
    };

    let (width, height) = (img.width(), img.height());
    if width == 0 || height == 0 {
        return false;
    }

    // 目标竖版宽 = 高 × 比例，右对齐裁切；已是竖版/更窄时取全宽
    let target_width = ((height as f32) * POSTER_ASPECT_W_OVER_H).round() as u32;
    let crop_width = target_width.clamp(1, width);
    let crop_x = width - crop_width;
    let cropped = img.crop_imm(crop_x, 0, crop_width, height);

    // JPEG 不支持 alpha，统一转 RGB8 再保存（透明 PNG/WebP 源否则会编码失败）
    match cropped.to_rgb8().save(dst) {
        Ok(_) => true,
        Err(e) => {
            log::error!("[artwork] event=poster_crop_save_failed dst={} error={}", dst.display(), e);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artwork_path_uses_stem_and_suffix() {
        let p = artwork_path(Path::new("/m/ABC-123 标题"), "ABC-123", POSTER_SUFFIX);
        assert_eq!(p, Path::new("/m/ABC-123 标题").join("ABC-123-poster.jpg"));
    }

    #[test]
    fn crop_landscape_to_poster_produces_portrait() {
        // 构造 800x538 横版图，裁切应得右侧约 378x538 竖版
        let dir = std::env::temp_dir();
        let src = dir.join(format!("javm-art-src-{}.png", std::process::id()));
        let dst = dir.join(format!("javm-art-dst-{}.jpg", std::process::id()));
        let img = image::RgbImage::from_pixel(800, 538, image::Rgb([10, 20, 30]));
        image::DynamicImage::ImageRgb8(img).save(&src).unwrap();

        assert!(crop_landscape_to_poster(&src, &dst));
        let (w, h) = image::image_dimensions(&dst).unwrap();
        assert!(h > w, "裁切结果应为竖版，实际 {}x{}", w, h);
        assert_eq!(h, 538);
        assert_eq!(w, 378);

        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn primary_dimension_path_prefers_fanart() {
        let art = ArtworkResult {
            poster: Some("p.jpg".into()),
            fanart: Some("f.jpg".into()),
            thumb: Some("t.jpg".into()),
        };
        assert_eq!(art.primary_dimension_path(), Some("f.jpg"));

        let art2 = ArtworkResult { poster: Some("p.jpg".into()), fanart: None, thumb: None };
        assert_eq!(art2.primary_dimension_path(), Some("p.jpg"));
    }
}
