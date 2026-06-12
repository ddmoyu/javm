use nom_exif::{EntryValue, MediaParser, MediaSource, TrackInfo, TrackInfoTag};
use std::path::Path;

use crate::media::ffmpeg::probe_video_info;

pub struct VideoMetadata {
    pub duration: Option<u64>, // Duration in seconds
    pub width: Option<u64>,
    pub height: Option<u64>,
}

fn val_to_u64(v: &EntryValue) -> Option<u64> {
    match v {
        EntryValue::U8(x) => Some(*x as u64),
        EntryValue::U16(x) => Some(*x as u64),
        EntryValue::U32(x) => Some(*x as u64),
        EntryValue::U64(x) => Some(*x),
        // If we encounter other types (Rational), we might need to handle them.
        // For video duration/dimensions, integer types are standard in nom-exif.
        _ => None,
    }
}

fn normalize_dimension(value: Option<u64>) -> Option<u64> {
    match value {
        Some(0) | None => None,
        other => other,
    }
}

fn normalize_duration(value: Option<u64>) -> Option<u64> {
    match value {
        Some(0) | None => None,
        other => other,
    }
}

pub fn extract_metadata(path: &Path) -> Result<VideoMetadata, String> {
    let mut metadata = match MediaSource::open(path) {
        Ok(ms) => {
            let mut parser = MediaParser::new();
            let parsed: Result<TrackInfo, _> = parser.parse_track(ms);
            match parsed {
                Ok(info) => VideoMetadata {
                    duration: normalize_duration(
                        info.get(TrackInfoTag::DurationMs)
                            .and_then(val_to_u64)
                            .map(|d| d / 1000),
                    ),
                    width: normalize_dimension(
                        info.get(TrackInfoTag::Width).and_then(val_to_u64),
                    ),
                    height: normalize_dimension(
                        info.get(TrackInfoTag::Height).and_then(val_to_u64),
                    ),
                },
                Err(_) => VideoMetadata {
                    duration: None,
                    width: None,
                    height: None,
                },
            }
        }
        Err(_) => VideoMetadata {
            duration: None,
            width: None,
            height: None,
        },
    };

    let path_str = path.to_string_lossy();

    // 时长或分辨率任一缺失，就用一次 ffmpeg 探测同时补齐两者（避免两次进程）
    if metadata.duration.is_none() || metadata.width.is_none() || metadata.height.is_none() {
        let (probed_duration, probed_resolution) = probe_video_info(path_str.as_ref());

        if metadata.duration.is_none() {
            if let Some(duration) = probed_duration {
                metadata.duration = Some(duration.round() as u64);
            }
        }
        if let Some((width, height)) = probed_resolution {
            if metadata.width.is_none() {
                metadata.width = Some(width as u64);
            }
            if metadata.height.is_none() {
                metadata.height = Some(height as u64);
            }
        }
    }

    if metadata.duration.is_some() || metadata.width.is_some() || metadata.height.is_some() {
        Ok(metadata)
    } else {
        Err("无法提取视频元数据".to_string())
    }
}
