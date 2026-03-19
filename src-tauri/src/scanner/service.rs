//! 视频文件扫描服务
//!
//! 负责递归扫描指定目录，发现视频文件并将元数据写入数据库。
//! 支持解析同名 .nfo 文件中的元数据，检测已删除文件并清理数据库记录。

use crate::db::Database;
use crate::metadata;
use crate::nfo::parser::parse_nfo;
use crate::scanner::file_scanner::{
    count_video_files_async, is_skipped_directory, should_scan_as_video,
};
use chrono::Utc;
use rusqlite::Transaction;
use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
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
    pub async fn scan_directory_async<F>(
        &self,
        path: &str,
        progress_callback: F,
    ) -> Result<u32, String>
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
            return Ok(0);
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

        // 数据库操作是同步的，放到阻塞线程中执行
        let db = self.db.clone();
        let path_string = path.to_string();
        let progress_callback = std::sync::Arc::new(progress_callback);

        let count = tauri::async_runtime::spawn_blocking(move || {
            Self::scan_directory_blocking(&db, &path_string, total_files, progress_callback)
        })
        .await
        .map_err(|e| format!("扫描任务执行失败: {}", e))??;

        Ok(count)
    }

    /// 阻塞式扫描（在 spawn_blocking 中运行）
    fn scan_directory_blocking<F>(
        db: &Database,
        path: &str,
        total_files: u32,
        progress_callback: std::sync::Arc<F>,
    ) -> Result<u32, String>
    where
        F: Fn(ScanProgress) + Send + Sync + 'static,
    {
        let conn = db
            .get_connection()
            .map_err(|e| format!("获取数据库连接失败: {}", e))?;
        let root_path = Path::new(path);

        // 获取数据库中已有的视频路径，用于检测已删除的文件
        let mut existing_paths: HashSet<String> =
            Database::get_existing_video_paths(&conn, path)
                .map_err(|e| format!("查询已有路径失败: {}", e))?;

        let transaction = conn
            .unchecked_transaction()
            .map_err(|e| format!("开启事务失败: {}", e))?;

        let mut current_count = 0u32;
        let scanned_count = Self::scan_recursive(
            root_path,
            &transaction,
            &mut existing_paths,
            &mut current_count,
            total_files,
            &*progress_callback,
        )?;

        // 删除磁盘上已不存在的文件记录
        for missing_path in &existing_paths {
            if let Err(e) = Database::delete_video_by_path(&transaction, missing_path) {
                eprintln!("删除缺失文件记录失败 '{}': {}", missing_path, e);
            } else {
                println!("已清理缺失文件记录: {}", missing_path);
            }
        }

        transaction
            .commit()
            .map_err(|e| format!("提交事务失败: {}", e))?;

        Ok(scanned_count)
    }

    /// 同步递归扫描目录，处理每个视频文件
    fn scan_recursive(
        dir: &Path,
        tx: &Transaction,
        existing: &mut HashSet<String>,
        current: &mut u32,
        total: u32,
        progress_callback: &dyn Fn(ScanProgress),
    ) -> Result<u32, String> {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("无法读取目录 '{}': {}", dir.display(), e);
                return Ok(0);
            }
        };

        let mut count = 0u32;

        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    eprintln!("读取目录项失败: {}", e);
                    continue;
                }
            };
            let path = entry.path();

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
                count +=
                    Self::scan_recursive(&path, tx, existing, current, total, progress_callback)?;
            } else if Self::process_file(&path, tx, existing)? {
                count += 1;
                *current += 1;
                progress_callback(ScanProgress {
                    current: *current,
                    total,
                    current_file: path.to_string_lossy().to_string(),
                });
            }
        }

        Ok(count)
    }

    /// 处理单个视频文件：提取元数据并写入数据库
    fn process_file(
        file_path: &Path,
        tx: &Transaction,
        existing_paths: &mut HashSet<String>,
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

        let file_size = file_path
            .metadata()
            .map_err(|e| format!("获取文件元数据失败 '{}': {}", path_str, e))?
            .len();

        // 跳过空文件
        if file_size == 0 {
            return Ok(false);
        }

        let fast_hash = calculate_fast_hash(file_path)?;

        // 提取视频流元数据（时长、分辨率）
        let media_meta = metadata::extract_metadata(file_path).unwrap_or(metadata::VideoMetadata {
            duration: None,
            width: None,
            height: None,
        });
        let mut duration = media_meta.duration.map(|d| d as i32);
        let resolution = match (media_meta.width, media_meta.height) {
            (Some(w), Some(h)) => Some(format!("{}x{}", w, h)),
            _ => None,
        };

        let poster = crate::utils::media_assets::find_sibling_artwork(file_path, "poster");
        let thumb = crate::utils::media_assets::find_sibling_artwork(file_path, "thumb");
        let fanart = crate::utils::media_assets::find_sibling_artwork(file_path, "fanart");

        // 解析 NFO 文件
        let nfo_path = file_path.with_extension("nfo");
        let nfo = if nfo_path.exists() {
            parse_nfo(&nfo_path, &mut duration)
        } else {
            None
        };

        // 确定标题
        let title = nfo
            .as_ref()
            .and_then(|n| n.title.clone())
            .unwrap_or_else(|| filename.clone());
        let original_title = nfo
            .as_ref()
            .and_then(|n| n.original_title.clone())
            .unwrap_or_else(|| filename.clone());

        // 判断扫描状态：同时存在 .nfo 文件和 poster 即为已刮削（状态2）
        let scan_status = if nfo.is_some() && poster.is_some() {
            2
        } else {
            1
        };

        let local_id = nfo.as_ref().and_then(|n| n.local_id.clone());
        let studio = nfo.as_ref().and_then(|n| n.studio.clone());
        let premiered = nfo.as_ref().and_then(|n| n.premiered.clone());
        let director = nfo.as_ref().and_then(|n| n.director.clone());
        let rating = nfo.as_ref().and_then(|n| n.rating);

        let now = Utc::now().to_rfc3339();

        // 检查数据库中是否已存在该路径
        let exists: bool = Database::video_exists_by_path(tx, &path_str).unwrap_or(false);

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
                poster: poster.clone(),
                thumb: thumb.clone(),
                fanart: fanart.clone(),
                scan_status,
                now: &now,
            };
            Database::update_video(tx, &data)
                .map_err(|e| format!("更新视频记录失败 '{}': {}", path_str, e))?;

            Database::get_video_id_by_path(tx, &path_str)
                .map_err(|e| format!("查询视频 ID 失败: {}", e))?
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
            };
            Database::insert_video(tx, &data)
                .map_err(|e| format!("插入视频记录失败 '{}': {}", path_str, e))?;
            id
        };

        // 写入演员关联
        if let Some(ref nfo) = nfo {
            if !nfo.actor_names.is_empty() {
                Database::clear_video_actors(tx, &video_id).map_err(|e| e.to_string())?;
                for (idx, actor_name) in nfo.actor_names.iter().enumerate() {
                    let actor_id = get_or_create_metadata(tx, "actors", actor_name)?;
                    Database::add_video_actor(tx, &video_id, actor_id, idx)
                        .map_err(|e| e.to_string())?;
                }
            }

            // 写入标签关联
            if !nfo.tag_names.is_empty() {
                Database::clear_video_tags(tx, &video_id).map_err(|e| e.to_string())?;
                for tag_name in &nfo.tag_names {
                    let tag_id = get_or_create_metadata(tx, "tags", tag_name)?;
                    Database::add_video_tag(tx, &video_id, tag_id).map_err(|e| e.to_string())?;
                }
            }

            if !nfo.genre_names.is_empty() {
                Database::clear_video_genres(tx, &video_id).map_err(|e| e.to_string())?;
                for genre_name in &nfo.genre_names {
                    let genre_id = get_or_create_metadata(tx, "genres", genre_name)?;
                    Database::add_video_genre(tx, &video_id, genre_id)
                        .map_err(|e| e.to_string())?;
                }
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
fn get_or_create_metadata(tx: &Transaction, table: &str, name: &str) -> Result<i64, String> {
    crate::db::Database::get_or_create_metadata(tx, table, name).map_err(|e| e.to_string())
}
