//! 视频文件扫描服务
//!
//! 负责递归扫描指定目录，发现视频文件并将元数据写入数据库。
//! 支持解析同名 .nfo 文件中的元数据，检测已删除文件并清理数据库记录。
//! 扫描过程中对无封面的视频通过 channel 派发截帧任务，与扫描并行执行。

use crate::db::Database;
use crate::metadata;
use crate::nfo::parser::parse_nfo;
use crate::scanner::file_scanner::{
    count_video_files_async, is_skipped_directory, should_scan_as_video,
};
use chrono::Utc;
use rusqlite::Transaction;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::UNIX_EPOCH;
use tokio::fs;
use uuid::Uuid;

// ============================================================
// 数据结构
// ============================================================

pub struct ScannerService {
    db: Database,
}

/// 扫描进度信息，通过回调发送给前端
#[derive(Clone, serde::Serialize)]
pub struct ScanProgress {
    pub current: u32,
    pub total: u32,
    pub current_file: String,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct ScanSummary {
    pub success_count: u32,
    pub failed_count: u32,
}

/// 用于在扫描过程中向异步截帧 dispatcher 发送任务
pub type CoverTaskSender = tokio::sync::mpsc::UnboundedSender<(String, String)>;

// ============================================================
// ScannerService 实现
// ============================================================

impl ScannerService {
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    /// 异步扫描目录入口
    ///
    /// 先异步统计文件总数，再在阻塞线程中执行数据库写入操作。
    /// `cover_tx`: 可选的封面任务发送端，扫描时发现无封面的视频会通过此 channel 派发截帧任务。
    pub async fn scan_directory_async<F>(
        &self,
        path: &str,
        progress_callback: F,
        cover_tx: Option<CoverTaskSender>,
    ) -> Result<ScanSummary, String>
    where
        F: Fn(ScanProgress) + Send + Sync + 'static,
    {
        let path = path.trim();
        if path.is_empty() {
            return Err("目录路径不能为空".to_string());
        }

        let root_path = Path::new(path);

        // 检查目录是否存在且有效
        let meta = fs::symlink_metadata(root_path)
            .await
            .map_err(|e| format!("无法访问路径 '{}': {}", path, e))?;

        if meta.is_symlink() {
            return Err(format!("路径 '{}' 是符号链接，不支持直接扫描", path));
        }
        if !meta.is_dir() {
            return Err(format!("路径 '{}' 不是有效的目录", path));
        }

        if is_skipped_directory(root_path) {
            return Ok(ScanSummary::default());
        }

        // 发送初始进度
        progress_callback(ScanProgress {
            current: 0,
            total: 0,
            current_file: "正在统计文件数量...".to_string(),
        });

        // 异步统计视频文件总数
        let total_files = count_video_files_async(root_path).await?;

        progress_callback(ScanProgress {
            current: 0,
            total: total_files,
            current_file: String::new(),
        });

        // 预扫描：廉价遍历找出"内容已变更"的视频文件，随后并行预提取重活
        // （fast_hash + ffmpeg 元数据），把串行瓶颈摊到多核上。
        let db_pre = self.db.clone();
        let path_pre = path.to_string();
        let changed_files = tauri::async_runtime::spawn_blocking(
            move || -> Result<Vec<(String, u64, Option<i64>)>, String> {
                let conn = db_pre
                    .get_connection()
                    .map_err(|e| format!("获取数据库连接失败: {}", e))?;
                let existing_map = Database::get_existing_video_scan_info_map(&conn, &path_pre)
                    .map_err(|e| format!("预加载视频扫描信息失败: {}", e))?;
                let mut out = Vec::new();
                collect_changed_files(Path::new(&path_pre), &existing_map, &mut out);
                Ok(out)
            },
        )
        .await
        .map_err(|e| format!("预扫描任务执行失败: {}", e))??;

        let media_cache = build_media_cache(changed_files).await;

        // 数据库操作是同步的，放到阻塞线程中执行
        let db = self.db.clone();
        let path_string = path.to_string();
        let progress_callback = std::sync::Arc::new(progress_callback);

        let summary = tauri::async_runtime::spawn_blocking(move || {
            // cover_tx 被 move 进来，scan 结束后自动 drop → 关闭 channel
            Self::scan_directory_blocking(
                &db,
                &path_string,
                total_files,
                progress_callback,
                cover_tx,
                &media_cache,
            )
        })
        .await
        .map_err(|e| format!("扫描任务执行失败: {}", e))??;

        Ok(summary)
    }

    /// 阻塞式扫描（在 spawn_blocking 中运行）
    fn scan_directory_blocking<F>(
        db: &Database,
        path: &str,
        total_files: u32,
        progress_callback: std::sync::Arc<F>,
        cover_tx: Option<CoverTaskSender>,
        media_cache: &HashMap<String, PreparedMedia>,
    ) -> Result<ScanSummary, String>
    where
        F: Fn(ScanProgress) + Send + Sync + 'static,
    {
        let conn = db
            .get_connection()
            .map_err(|e| format!("获取数据库连接失败: {}", e))?;
        let root_path = Path::new(path);

        // 预加载目录下所有已有视频的扫描信息到 HashMap，避免逐个查询数据库
        let mut existing_map: HashMap<String, crate::db::ExistingVideoScanInfo> =
            Database::get_existing_video_scan_info_map(&conn, path)
                .map_err(|e| format!("预加载视频扫描信息失败: {}", e))?;

        // 获取数据库中已有的视频路径，用于检测已删除的文件
        let mut existing_paths: HashSet<String> = existing_map.keys().cloned().collect();

        let transaction = conn
            .unchecked_transaction()
            .map_err(|e| format!("开启事务失败: {}", e))?;

        let mut current_count = 0u32;
        let summary = Self::scan_recursive(
            root_path,
            &transaction,
            &mut existing_paths,
            &mut existing_map,
            &mut current_count,
            total_files,
            &*progress_callback,
            cover_tx.as_ref(),
            media_cache,
        )?;

        // 批量删除磁盘上已不存在的文件记录
        if !existing_paths.is_empty() {
            let missing: Vec<&str> = existing_paths.iter().map(|s| s.as_str()).collect();
            if let Err(e) = Database::batch_delete_videos_by_paths(&transaction, &missing) {
                log::error!(
                    "[scanner] event=cleanup_missing_records_failed root={} missing_count={} error={}",
                    path,
                    missing.len(),
                    e
                );
            } else {
                log::info!(
                    "[scanner] event=cleanup_missing_records_succeeded root={} missing_count={}",
                    path,
                    missing.len()
                );
            }
        }

        transaction
            .commit()
            .map_err(|e| format!("提交事务失败: {}", e))?;

        Ok(summary)
    }

    /// 同步递归扫描目录，处理每个视频文件
    fn scan_recursive(
        dir: &Path,
        tx: &Transaction,
        existing: &mut HashSet<String>,
        existing_map: &mut HashMap<String, crate::db::ExistingVideoScanInfo>,
        current: &mut u32,
        total: u32,
        progress_callback: &dyn Fn(ScanProgress),
        cover_tx: Option<&CoverTaskSender>,
        media_cache: &HashMap<String, PreparedMedia>,
    ) -> Result<ScanSummary, String> {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(e) => {
                log::error!(
                    "[scanner] event=read_dir_failed dir={} error={}",
                    dir.display(),
                    e
                );
                return Ok(ScanSummary::default());
            }
        };

        let mut summary = ScanSummary::default();

        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    log::warn!("[scanner] event=read_dir_entry_failed dir={} error={}", dir.display(), e);
                    continue;
                }
            };
            let path = entry.path();

            // 跳过符号链接，防止指向祖先目录的链接导致无限递归/栈溢出
            if entry
                .file_type()
                .map(|ft| ft.is_symlink())
                .unwrap_or(false)
            {
                continue;
            }

            // 跳过隐藏文件/目录
            if let Some(name) = path.file_name() {
                if name.to_string_lossy().starts_with('.') {
                    continue;
                }
            }

            if path.is_dir() && is_skipped_directory(&path) {
                continue;
            }

            if path.is_dir() {
                let child_summary =
                    Self::scan_recursive(&path, tx, existing, existing_map, current, total, progress_callback, cover_tx, media_cache)?;
                summary.success_count += child_summary.success_count;
                summary.failed_count += child_summary.failed_count;
            } else {
                match Self::process_file(&path, tx, existing, existing_map, cover_tx, media_cache) {
                    Ok(true) => {
                        summary.success_count += 1;
                        *current += 1;
                        progress_callback(ScanProgress {
                            current: *current,
                            total,
                            current_file: path.to_string_lossy().to_string(),
                        });
                    }
                    Ok(false) => {}
                    Err(e) => {
                        summary.failed_count += 1;
                        *current += 1;
                        log::error!(
                            "[scanner] event=process_file_failed path={} error={}",
                            path.display(),
                            e
                        );
                        progress_callback(ScanProgress {
                            current: *current,
                            total,
                            current_file: path.to_string_lossy().to_string(),
                        });
                    }
                }
            }
        }

        Ok(summary)
    }

    /// 处理单个视频文件：提取元数据并写入数据库
    ///
    /// 如果视频没有封面（poster 和 thumb 都不存在），
    /// 通过 `cover_tx` 发送截帧任务，由异步 dispatcher 并行生成封面。
    fn process_file(
        file_path: &Path,
        tx: &Transaction,
        existing_paths: &mut HashSet<String>,
        existing_map: &mut HashMap<String, crate::db::ExistingVideoScanInfo>,
        cover_tx: Option<&CoverTaskSender>,
        media_cache: &HashMap<String, PreparedMedia>,
    ) -> Result<bool, String> {
        if !should_scan_as_video(file_path) {
            return Ok(false);
        }

        let path_str = file_path.to_string_lossy().to_string();
        let parent_str = file_path
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let filename = file_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        if filename.is_empty() {
            return Ok(false);
        }

        let file_metadata = file_path
            .metadata()
            .map_err(|e| format!("获取文件元数据失败 '{}': {}", path_str, e))?;
        let file_size = file_metadata.len();
        let file_mtime = system_time_to_millis(file_metadata.modified().ok());

        // 跳过空文件
        if file_size == 0 {
            return Ok(false);
        }

        let existing = existing_map.remove(&path_str);

        let poster = crate::media::assets::find_sibling_artwork(file_path, "poster");
        let thumb = crate::media::assets::find_sibling_artwork(file_path, "thumb");
        let fanart = crate::media::assets::find_sibling_artwork(file_path, "fanart");
        let poster_mtime = poster.as_deref().and_then(path_mtime_from_str);
        let thumb_mtime = thumb.as_deref().and_then(path_mtime_from_str);
        let fanart_mtime = fanart.as_deref().and_then(path_mtime_from_str);
        // 封面尺寸取横版（默认展示）代表图，回退竖版
        let (cover_width, cover_height) =
            read_cover_dimensions(fanart.as_deref().or(thumb.as_deref()).or(poster.as_deref()));

        // 封面优先沿用库内已记录且仍存在的路径，再回退视频同级文件。
        // 跟随视频模式下二者本就是同一路径；独立目录模式下「库内记录」即独立目录里的图，
        // 优先它可避免被同级截帧图(刮削前扫描遗留)反向覆盖。仅保留仍存在的文件。
        let preserved_poster = existing
            .as_ref()
            .and_then(|e| e.poster.clone())
            .filter(|p| cover_path_exists(p))
            .or_else(|| poster.clone());
        let preserved_thumb = existing
            .as_ref()
            .and_then(|e| e.thumb.clone())
            .filter(|p| cover_path_exists(p))
            .or_else(|| thumb.clone());
        let preserved_fanart = existing
            .as_ref()
            .and_then(|e| e.fanart.clone())
            .filter(|p| cover_path_exists(p))
            .or_else(|| fanart.clone());
        let has_any_cover =
            preserved_poster.is_some() || preserved_thumb.is_some() || preserved_fanart.is_some();

        // 解析 NFO 文件
        let nfo_path = file_path.with_extension("nfo");
        let nfo_mtime = if nfo_path.exists() {
            path_mtime(&nfo_path)
        } else {
            None
        };

        if let Some(existing_info) = existing.as_ref() {
            let unchanged = existing_info.file_size == file_size
                && existing_info.file_mtime == file_mtime
                && existing_info.nfo_mtime == nfo_mtime
                && existing_info.poster_mtime == poster_mtime
                && existing_info.thumb_mtime == thumb_mtime
                && existing_info.fanart_mtime == fanart_mtime;

            if unchanged {
                existing_paths.remove(&path_str);
                // 文件没变且确实无任何封面（含库内独立目录记录）才派发截帧
                if !has_any_cover {
                    if let Some(sender) = cover_tx {
                        let video_id = existing_info.id.clone();
                        let _ = sender.send((video_id, path_str.clone()));
                    }
                }
                return Ok(true);
            }
        }

        let file_content_changed = existing
            .as_ref()
            .map(|existing_info| {
                existing_info.file_size != file_size || existing_info.file_mtime != file_mtime
            })
            .unwrap_or(true);

        let nfo_changed = existing
            .as_ref()
            .map(|existing_info| existing_info.nfo_mtime != nfo_mtime)
            .unwrap_or(true);

        // 内容变更时优先用预提取缓存（需大小/mtime 校验一致），否则当场计算
        let cached = if file_content_changed {
            media_cache
                .get(&path_str)
                .filter(|c| c.file_size == file_size && c.file_mtime == file_mtime)
        } else {
            None
        };

        let fast_hash = if file_content_changed {
            match cached {
                Some(c) => c.fast_hash.clone(),
                None => calculate_fast_hash(file_path)?,
            }
        } else {
            existing
                .as_ref()
                .and_then(|existing_info| existing_info.fast_hash.clone())
                .unwrap_or_default()
        };

        let mut duration = if file_content_changed {
            cached.and_then(|c| c.duration)
        } else {
            existing.as_ref().and_then(|existing_info| existing_info.duration)
        };

        let resolution = if file_content_changed {
            match cached {
                Some(c) => c.resolution.clone(),
                None => {
                    let media_meta =
                        metadata::extract_metadata(file_path).unwrap_or(metadata::VideoMetadata {
                            duration: None,
                            width: None,
                            height: None,
                        });
                    duration = media_meta.duration.map(|d| d as i32);
                    match (media_meta.width, media_meta.height) {
                        (Some(w), Some(h)) => Some(format!("{}x{}", w, h)),
                        _ => None,
                    }
                }
            }
        } else {
            existing
                .as_ref()
                .and_then(|existing_info| existing_info.resolution.clone())
        };

        let nfo = if nfo_mtime.is_some() && nfo_changed {
            parse_nfo(&nfo_path, &mut duration)
        } else {
            None
        };

        // 确定标题
        let title = resolve_nfo_field(
            nfo_mtime, nfo_changed,
            || nfo.as_ref().and_then(|n| n.title.clone()),
            || existing.as_ref().map(|e| e.title.clone()),
        ).unwrap_or_else(|| filename.clone());
        let original_title = resolve_nfo_field(
            nfo_mtime, nfo_changed,
            || nfo.as_ref().and_then(|n| n.original_title.clone()),
            || existing.as_ref().map(|e| e.original_title.clone()),
        ).unwrap_or_else(|| filename.clone());

        // 判断扫描状态：同时存在 .nfo 文件和 poster 即为已刮削（状态2）。
        // 独立目录模式下 NFO/封面不在视频同级、扫描看不到，故已刮削项保持状态不回退。
        let already_scraped = existing.as_ref().map(|e| e.scan_status == 2).unwrap_or(false);
        let scan_status = if (nfo_mtime.is_some() && poster.is_some()) || already_scraped {
            2
        } else {
            1
        };

        let local_id = resolve_nfo_field(
            nfo_mtime, nfo_changed,
            || nfo.as_ref().and_then(|n| n.local_id.clone()),
            || existing.as_ref().and_then(|e| e.local_id.clone()),
        );
        let studio = resolve_nfo_field(
            nfo_mtime, nfo_changed,
            || nfo.as_ref().and_then(|n| n.studio.clone()),
            || existing.as_ref().and_then(|e| e.studio.clone()),
        );
        let premiered = resolve_nfo_field(
            nfo_mtime, nfo_changed,
            || nfo.as_ref().and_then(|n| n.premiered.clone()),
            || existing.as_ref().and_then(|e| e.premiered.clone()),
        );
        let director = resolve_nfo_field(
            nfo_mtime, nfo_changed,
            || nfo.as_ref().and_then(|n| n.director.clone()),
            || existing.as_ref().and_then(|e| e.director.clone()),
        );
        let rating = resolve_nfo_field(
            nfo_mtime, nfo_changed,
            || nfo.as_ref().and_then(|n| n.rating),
            || existing.as_ref().and_then(|e| e.rating),
        );

        let now = Utc::now().to_rfc3339();

        // 检查数据库中是否已存在该路径
        let exists = existing.is_some();

        let video_id: String = if exists {
            let data = crate::db::VideoUpdateData {
                path_str: &path_str,
                title: &title,
                studio: studio.as_deref(),
                premiered: premiered.as_deref(),
                director: director.as_deref(),
                file_size,
                fast_hash: &fast_hash,
                original_title: &original_title,
                duration,
                resolution: resolution.clone(),
                local_id: local_id.as_deref(),
                rating,
                poster: preserved_poster.clone(),
                thumb: preserved_thumb.clone(),
                fanart: preserved_fanart.clone(),
                file_mtime,
                nfo_mtime,
                poster_mtime,
                thumb_mtime,
                fanart_mtime,
                scan_status,
                now: &now,
            };
            Database::update_video(tx, &data)
                .map_err(|e| format!("更新视频记录失败 '{}': {}", path_str, e))?;

            existing
                .as_ref()
                .map(|existing_info| existing_info.id.clone())
                .ok_or_else(|| format!("查询视频 ID 失败: 未找到 {} 的已有记录", path_str))?
        } else {
            let id = Uuid::new_v4().to_string();
            let data = crate::db::VideoInsertData {
                id: &id,
                local_id: local_id.as_deref(),
                path_str: &path_str,
                parent_str: &parent_str,
                title: &title,
                original_title: &original_title,
                studio: studio.as_deref(),
                premiered: premiered.as_deref(),
                director: director.as_deref(),
                file_size,
                fast_hash: &fast_hash,
                created_at: &now,
                scan_status,
                duration,
                resolution,
                rating,
                poster,
                thumb,
                fanart,
                file_mtime,
                nfo_mtime,
                poster_mtime,
                thumb_mtime,
                fanart_mtime,
                cover_width,
                cover_height,
            };
            Database::insert_video(tx, &data)
                .map_err(|e| format!("插入视频记录失败 '{}': {}", path_str, e))?;
            id
        };

        // 写入演员关联（仅当 NFO 变化且是已有视频时才清理旧关联）
        if nfo_changed {
            if exists {
                Database::clear_video_actors(tx, &video_id).map_err(|e| e.to_string())?;
                Database::clear_video_tags(tx, &video_id).map_err(|e| e.to_string())?;
                Database::clear_video_genres(tx, &video_id).map_err(|e| e.to_string())?;
            }

            if let Some(ref nfo) = nfo {
                if !nfo.actor_names.is_empty() {
                    for (idx, actor_name) in nfo.actor_names.iter().enumerate() {
                        let actor_id = get_or_create_metadata(tx, crate::db::MetadataTable::Actors, actor_name)?;
                        Database::add_video_actor(tx, &video_id, actor_id, idx)
                            .map_err(|e| e.to_string())?;
                    }
                }

                if !nfo.tag_names.is_empty() {
                    for tag_name in &nfo.tag_names {
                        let tag_id = get_or_create_metadata(tx, crate::db::MetadataTable::Tags, tag_name)?;
                        Database::add_video_tag(tx, &video_id, tag_id).map_err(|e| e.to_string())?;
                    }
                }

                if !nfo.genre_names.is_empty() {
                    for genre_name in &nfo.genre_names {
                        let genre_id = get_or_create_metadata(tx, crate::db::MetadataTable::Genres, genre_name)?;
                        Database::add_video_genre(tx, &video_id, genre_id)
                            .map_err(|e| e.to_string())?;
                    }
                }
            }

            // 维度关联（片商 / 系列 / 导演）：与 actors/genres 同步重建
            Database::sync_video_dimensions(
                tx,
                &video_id,
                studio.as_deref(),
                director.as_deref(),
                local_id.as_deref(),
            )
            .map_err(|e| e.to_string())?;
        }

        // 无封面 → 派发截帧任务（与扫描并行执行）；库内独立目录已有封面则跳过
        if !has_any_cover {
            if let Some(sender) = cover_tx {
                let _ = sender.send((video_id.clone(), path_str.clone()));
            }
        }

        // 从已有路径集合中移除，剩余的即为已删除文件
        existing_paths.remove(&path_str);

        Ok(true)
    }
}

// ============================================================
// 独立辅助函数
// ============================================================

/// 根据 NFO 变更状态决定字段值：有 NFO 时取新解析值或已有值，无 NFO 时返回 None
fn resolve_nfo_field<T>(
    nfo_mtime: Option<i64>,
    nfo_changed: bool,
    from_nfo: impl FnOnce() -> Option<T>,
    from_existing: impl FnOnce() -> Option<T>,
) -> Option<T> {
    if nfo_mtime.is_some() {
        if nfo_changed { from_nfo() } else { from_existing() }
    } else {
        None
    }
}

fn system_time_to_millis(time: Option<std::time::SystemTime>) -> Option<i64> {
    let duration = time?.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(duration.as_millis()).ok()
}

fn path_mtime(path: &Path) -> Option<i64> {
    system_time_to_millis(path.metadata().ok()?.modified().ok())
}

fn path_mtime_from_str(path: &str) -> Option<i64> {
    path_mtime(Path::new(path))
}

/// 封面路径是否指向存在的文件（用于判断库内已记录的封面是否仍有效）。
fn cover_path_exists(path: &str) -> bool {
    let trimmed = path.trim();
    !trimmed.is_empty() && Path::new(trimmed).exists()
}

/// 读取本地封面尺寸（仅读图头，开销小）。无封面或读取失败时返回 (None, None)。
fn read_cover_dimensions(path: Option<&str>) -> (Option<i32>, Option<i32>) {
    match path {
        Some(p) if !p.trim().is_empty() => match image::image_dimensions(p) {
            Ok((w, h)) if w > 0 && h > 0 => (Some(w as i32), Some(h as i32)),
            _ => (None, None),
        },
        _ => (None, None),
    }
}

/// Adler-32 校验和
fn adler32(data: &[u8], start: u32) -> u32 {
    let mut a = start & 0xFFFF;
    let mut b = (start >> 16) & 0xFFFF;
    for &byte in data {
        a = (a + byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

/// 预提取的重活结果（fast_hash + ffmpeg 时长/分辨率）
///
/// 以 (file_size, file_mtime) 作为有效性校验：预提取阶段与主扫描阶段之间
/// 文件若发生变化（大小或 mtime 不一致），主扫描会丢弃缓存改为当场计算，
/// 因此缓存仅影响并行加速程度，绝不影响结果正确性。
struct PreparedMedia {
    file_size: u64,
    file_mtime: Option<i64>,
    fast_hash: String,
    duration: Option<i32>,
    resolution: Option<String>,
}

/// 廉价遍历目录树，收集"内容已变更"（新增或大小/mtime 变化）的视频文件清单。
///
/// 只做 readdir + stat，不触碰 ffmpeg/哈希，供后续并行预提取使用。
/// 跳过规则与 `scan_recursive` 保持一致（符号链接、隐藏项、跳过目录、非视频、空文件）。
fn collect_changed_files(
    dir: &Path,
    existing_map: &HashMap<String, crate::db::ExistingVideoScanInfo>,
    out: &mut Vec<(String, u64, Option<i64>)>,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();

        // 跳过符号链接，防止无限递归
        if entry.file_type().map(|ft| ft.is_symlink()).unwrap_or(false) {
            continue;
        }

        // 跳过隐藏文件/目录
        if let Some(name) = path.file_name() {
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
        }

        if path.is_dir() {
            if is_skipped_directory(&path) {
                continue;
            }
            collect_changed_files(&path, existing_map, out);
        } else {
            if !should_scan_as_video(&path) {
                continue;
            }
            let meta = match path.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let size = meta.len();
            if size == 0 {
                continue;
            }
            let mtime = system_time_to_millis(meta.modified().ok());
            let path_str = path.to_string_lossy().to_string();
            let changed = existing_map
                .get(&path_str)
                .map(|info| info.file_size != size || info.file_mtime != mtime)
                .unwrap_or(true);
            if changed {
                out.push((path_str, size, mtime));
            }
        }
    }
}

/// 对变更文件清单做有界并发的重活预提取（fast_hash + ffmpeg 元数据）。
///
/// 返回按路径索引的缓存。哈希失败的文件不入缓存（主扫描会当场重算并正确报错）；
/// ffmpeg 元数据失败按"无元数据"处理（与原逻辑一致，不影响入缓存）。
async fn build_media_cache(
    files: Vec<(String, u64, Option<i64>)>,
) -> HashMap<String, PreparedMedia> {
    let concurrency = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(2, 8);
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(concurrency));
    let mut set: tokio::task::JoinSet<Option<(String, PreparedMedia)>> = tokio::task::JoinSet::new();

    for (path_str, size, mtime) in files {
        let sem = semaphore.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok()?;
            tokio::task::spawn_blocking(move || {
                let path = Path::new(&path_str);
                // 哈希失败则不缓存，交回主扫描当场处理（保持原有的失败语义）
                let fast_hash = calculate_fast_hash(path).ok()?;
                let (duration, resolution) = match metadata::extract_metadata(path) {
                    Ok(m) => (
                        m.duration.map(|d| d as i32),
                        match (m.width, m.height) {
                            (Some(w), Some(h)) => Some(format!("{}x{}", w, h)),
                            _ => None,
                        },
                    ),
                    Err(_) => (None, None),
                };
                Some((
                    path_str,
                    PreparedMedia {
                        file_size: size,
                        file_mtime: mtime,
                        fast_hash,
                        duration,
                        resolution,
                    },
                ))
            })
            .await
            .ok()
            .flatten()
        });
    }

    let mut map = HashMap::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(Some((path, prepared))) = joined {
            map.insert(path, prepared);
        }
    }
    map
}

/// 计算文件的快速哈希（基于文件大小 + 头尾各 4KB 的 Adler-32）
fn calculate_fast_hash(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("打开文件失败 '{}': {}", path.display(), e))?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();

    if len == 0 {
        return Ok("0".to_string());
    }

    let mut hash = 1u32;
    hash = adler32(&len.to_le_bytes(), hash);

    let mut buffer = [0u8; 4096];
    let bytes_read = file.read(&mut buffer).map_err(|e| e.to_string())?;
    hash = adler32(&buffer[..bytes_read], hash);

    if len > 4096 {
        let offset = if len < 8192 { 4096 } else { len - 4096 };
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let bytes_read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        hash = adler32(&buffer[..bytes_read], hash);
    }

    Ok(format!("{:08x}", hash))
}

/// 获取或创建元数据记录（演员/标签）- 委托给 Database 统一实现
fn get_or_create_metadata(tx: &Transaction, table: crate::db::MetadataTable, name: &str) -> Result<i64, String> {
    crate::db::Database::get_or_create_metadata(tx, table, name).map_err(|e| e.to_string())
}
