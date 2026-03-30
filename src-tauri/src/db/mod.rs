pub mod models;
pub use models::*;

use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension, Result};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

// ==================== 数据库核心 ====================

/// 数据库 schema 版本号，不匹配时直接删除旧数据库并重建
const DB_SCHEMA_VERSION: i32 = 2;

#[derive(Clone)]
pub struct Database {
    path: PathBuf,
}

impl Database {
    /// 创建数据库实例
    pub fn new(app: &AppHandle) -> std::result::Result<Self, AppError> {
        let app_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| AppError::Tauri(format!("无法获取应用数据目录: {}", e)))?;

        if !app_dir.exists() {
            fs::create_dir_all(&app_dir)?;
        }

        let path = app_dir.join("javm.db");
        Ok(Self { path })
    }

    /// 在阻塞线程中执行数据库操作，消除重复样板
    pub async fn run_blocking<F, T>(&self, f: F) -> AppResult<T>
    where
        F: FnOnce(Connection) -> AppResult<T> + Send + 'static,
        T: Send + 'static,
    {
        let db_path = self.path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = Connection::open(&db_path)?;
            f(conn)
        })
        .await
        .map_err(|e| AppError::TaskJoin(e.to_string()))?
    }

    pub fn get_connection(&self) -> Result<Connection> {
        Connection::open(&self.path)
    }

    /// 获取数据库路径
    pub fn get_database_path(&self) -> &PathBuf {
        &self.path
    }

    /// 检查数据库是否需要重置（从 v0.2.0 以下版本升级时清空重建）
    pub fn check_and_reset_if_needed(&self) {
        if !self.path.exists() {
            return; // 全新安装，无需处理
        }

        match Connection::open(&self.path) {
            Ok(conn) => {
                let version: i32 = conn
                    .pragma_query_value(None, "user_version", |row| row.get(0))
                    .unwrap_or(0);

                if version < DB_SCHEMA_VERSION {
                    println!(
                        "检测到旧版本数据库 (schema_version={}), 清空重建",
                        version
                    );
                    drop(conn); // 关闭连接后再删除文件
                    if let Err(e) = fs::remove_file(&self.path) {
                        eprintln!("删除旧数据库失败: {}", e);
                    } else {
                        println!("已删除旧版本数据库，将重新初始化");
                    }
                }
            }
            Err(e) => {
                eprintln!("打开数据库检查版本失败: {}，尝试删除重建", e);
                let _ = fs::remove_file(&self.path);
            }
        }
    }

    /// 初始化数据库表结构
    pub fn init(&self) -> Result<()> {
        println!("Initializing database at: {:?}", self.path);
        let conn = self.get_connection()?;
        println!("Database connection established");

        conn.execute("PRAGMA foreign_keys = ON", [])?;

        // 1. 元数据表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS actors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                avatar_path TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                category TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS genres (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // 2. 视频主表
        println!("Creating videos table...");

        conn.execute(
            "CREATE TABLE IF NOT EXISTS videos (
                id TEXT PRIMARY KEY,
                local_id TEXT,
                title TEXT,
                original_title TEXT,
                studio TEXT,
                director TEXT,
                premiered TEXT,
                duration INTEGER,
                rating REAL DEFAULT 0,
                video_path TEXT NOT NULL UNIQUE,
                dir_path TEXT NOT NULL,
                file_size INTEGER,
                fast_hash TEXT,
                poster TEXT,
                thumb TEXT,
                fanart TEXT,
                scan_status INTEGER DEFAULT 0,
                resolution TEXT,
                file_mtime INTEGER,
                nfo_mtime INTEGER,
                poster_mtime INTEGER,
                thumb_mtime INTEGER,
                fanart_mtime INTEGER,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                scraped_at TEXT
            )",
            [],
        )?;
        println!("Videos table created successfully");

        // 3. 关联表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS video_actors (
                video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
                actor_id INTEGER REFERENCES actors(id) ON DELETE CASCADE,
                priority INTEGER DEFAULT 0,
                PRIMARY KEY (video_id, actor_id)
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS video_tags (
                video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
                tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY (video_id, tag_id)
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS video_genres (
                video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
                genre_id INTEGER REFERENCES genres(id) ON DELETE CASCADE,
                PRIMARY KEY (video_id, genre_id)
            )",
            [],
        )?;

        // 4. 下载表
        // 状态码: 0=排队 1=准备 2=下载中 3=合并 4=刮削中 5=暂停 6=完成 7=失败 8=重试 9=取消
        println!("Creating downloads table...");
        conn.execute(
            "CREATE TABLE IF NOT EXISTS downloads (
                id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                save_path TEXT NOT NULL,
                temp_path TEXT,

                filename TEXT,
                total_bytes INTEGER,
                downloaded_bytes INTEGER DEFAULT 0,
                progress REAL DEFAULT 0.0,

                status INTEGER DEFAULT 0,
                error_message TEXT,

                downloader_type TEXT DEFAULT 'N_m3u8DL-RE',
                retry_count INTEGER DEFAULT 0,

                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                completed_at TEXT
            )",
            [],
        )?;
        println!("Downloads table created successfully");

        // 5. 刮削任务表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS scrape_tasks (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL,
                status TEXT NOT NULL,
                progress INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                started_at TEXT,
                completed_at TEXT
            )",
            [],
        )?;

        // 6. 目录表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS directories (
                id TEXT PRIMARY KEY,
                path TEXT UNIQUE NOT NULL,
                video_count INTEGER DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // 索引
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_videos_dir_path ON videos (dir_path)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_videos_studio ON videos (studio)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_videos_fast_hash ON videos (fast_hash)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_videos_local_id ON videos (local_id)",
            [],
        )?;
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_downloads_url ON downloads (url)",
            [],
        )?;

        // 标记当前数据库 schema 版本
        conn.pragma_update(None, "user_version", DB_SCHEMA_VERSION)?;

        Ok(())
    }

    // ==================== 元数据操作 ====================

    /// 获取或创建元数据（演员/标签），返回记录 ID
    ///
    /// 通用方法，供 scanner、database_writer 等模块复用。
    /// `Transaction` 可通过 `Deref` 自动转为 `&Connection`。
    pub fn get_or_create_metadata(conn: &Connection, table: MetadataTable, name: &str) -> Result<i64> {
        let table_name = table.as_str();
        let query_sql = format!("SELECT id FROM {} WHERE name = ?", table_name);
        let mut stmt = conn.prepare(&query_sql)?;
        let mut rows = stmt.query(rusqlite::params![name])?;

        if let Some(row) = rows.next()? {
            return Ok(row.get(0)?);
        }

        let insert_sql = format!("INSERT INTO {} (name) VALUES (?)", table_name);
        conn.execute(&insert_sql, rusqlite::params![name])?;
        Ok(conn.last_insert_rowid())
    }

    pub fn get_or_create_tag(conn: &Connection, name: &str) -> Result<i64> {
        Self::get_or_create_metadata(conn, MetadataTable::Tags, name)
    }

    pub fn get_or_create_actor(conn: &Connection, name: &str) -> Result<i64> {
        Self::get_or_create_metadata(conn, MetadataTable::Actors, name)
    }

    pub fn get_or_create_genre(conn: &Connection, name: &str) -> Result<i64> {
        Self::get_or_create_metadata(conn, MetadataTable::Genres, name)
    }

    // ==================== 刮削任务操作 ====================

    /// 批量创建刮削任务（使用事务）- 异步版本
    pub async fn create_scrape_tasks_batch(&self, tasks: Vec<(String, String)>) -> AppResult<usize> {
        self.run_blocking(move |conn| {
            // run_blocking 给的是 Connection，需要手动开事务
            // 因为 Transaction 需要 &mut Connection，这里用一个内部作用域
            let mut conn = conn;
            let tx = conn.transaction()?;

            let mut created_count = 0;
            for (id, path) in tasks {
                tx.execute(
                    "INSERT INTO scrape_tasks (id, path, status, progress) VALUES (?1, ?2, ?3, ?4)",
                    params![id, path, ScrapeStatus::Waiting.as_str(), 0],
                )?;
                created_count += 1;
            }

            tx.commit()?;
            Ok(created_count)
        })
        .await
    }

    /// 检查刮削任务是否存在（排除已完成的）
    pub fn scrape_task_exists_active(&self, path: &str) -> Result<bool> {
        let conn = self.get_connection()?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM scrape_tasks WHERE path = ?1 AND status != 'completed'",
            params![path],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// 检查视频是否已完全刮削
    pub fn is_video_completely_scraped(&self, video_path: &str) -> Result<bool> {
        use std::path::Path;

        let conn = self.get_connection()?;

        // 检查数据库状态
        let scan_status: Option<i32> = conn
            .query_row(
                "SELECT scan_status FROM videos WHERE video_path = ?",
                params![video_path],
                |row| row.get(0),
            )
            .optional()?;

        if scan_status != Some(2) {
            return Ok(false);
        }

        // 检查 NFO 文件是否存在
        let video_path_obj = Path::new(video_path);
        let nfo_path = video_path_obj.with_extension("nfo");

        Ok(nfo_path.exists())
    }

    /// 根据 ID 获取刮削任务
    pub fn get_scrape_task(&self, id: &str) -> Result<Option<ScrapeTask>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, path, status, progress, created_at, started_at, completed_at
             FROM scrape_tasks WHERE id = ?1",
        )?;

        let mut rows = stmt.query(params![id])?;

        if let Some(row) = rows.next()? {
            let status_str: String = row.get(2)?;
            let status =
                ScrapeStatus::from_str(&status_str).map_err(|_| rusqlite::Error::InvalidQuery)?;

            Ok(Some(ScrapeTask {
                id: row.get(0)?,
                path: row.get(1)?,
                status,
                progress: row.get(3)?,
                created_at: row.get(4)?,
                started_at: row.get(5)?,
                completed_at: row.get(6)?,
            }))
        } else {
            Ok(None)
        }
    }

    /// 获取所有刮削任务 - 异步版本
    pub async fn get_all_scrape_tasks(&self) -> AppResult<Vec<ScrapeTask>> {
        self.run_blocking(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, path, status, progress, created_at, started_at, completed_at
                 FROM scrape_tasks ORDER BY created_at DESC",
            )?;

            let tasks = stmt
                .query_map([], |row| {
                    let status_str: String = row.get(2)?;
                    let status = ScrapeStatus::from_str(&status_str)
                        .map_err(|_| rusqlite::Error::InvalidQuery)?;

                    Ok(ScrapeTask {
                        id: row.get(0)?,
                        path: row.get(1)?,
                        status,
                        progress: row.get(3)?,
                        created_at: row.get(4)?,
                        started_at: row.get(5)?,
                        completed_at: row.get(6)?,
                    })
                })?
                .collect::<Result<Vec<_>>>()?;

            Ok(tasks)
        })
        .await
    }

    /// 更新刮削任务状态 - 异步版本
    pub async fn update_scrape_task_status(
        &self,
        id: &str,
        status: ScrapeStatus,
        progress: Option<i32>,
    ) -> AppResult<()> {
        let id = id.to_string();

        self.run_blocking(move |conn| {
            let mut sql = String::from("UPDATE scrape_tasks SET status = ?1");
            let mut param_count = 2;

            if progress.is_some() {
                sql.push_str(&format!(", progress = ?{}", param_count));
                param_count += 1;
            }

            if status == ScrapeStatus::Running {
                sql.push_str(", started_at = CURRENT_TIMESTAMP");
            }

            if matches!(
                status,
                ScrapeStatus::Completed | ScrapeStatus::Partial | ScrapeStatus::Failed
            ) {
                sql.push_str(", completed_at = CURRENT_TIMESTAMP");
            }

            sql.push_str(&format!(" WHERE id = ?{}", param_count));

            if let Some(prog) = progress {
                conn.execute(&sql, params![status.as_str(), prog, id])?;
            } else {
                conn.execute(&sql, params![status.as_str(), id])?;
            }

            Ok(())
        })
        .await
    }

    /// 更新刮削任务进度
    pub fn update_scrape_task_progress(&self, id: &str, progress: i32) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "UPDATE scrape_tasks SET progress = ?1 WHERE id = ?2",
            params![progress, id],
        )?;
        Ok(())
    }

    /// 删除所有已完成的任务 - 异步版本
    pub async fn delete_completed_tasks(&self) -> AppResult<usize> {
        self.run_blocking(|conn| {
            Ok(conn.execute("DELETE FROM scrape_tasks WHERE status = 'completed'", [])?)
        }).await
    }

    /// 删除所有失败的刮削任务 - 异步版本
    pub async fn delete_failed_scrape_tasks(&self) -> AppResult<usize> {
        self.run_blocking(|conn| {
            Ok(conn.execute("DELETE FROM scrape_tasks WHERE status = 'failed'", [])?)
        }).await
    }

    /// 删除全部刮削任务 - 异步版本
    pub async fn delete_all_scrape_tasks(&self) -> AppResult<usize> {
        self.run_blocking(|conn| {
            Ok(conn.execute("DELETE FROM scrape_tasks", [])?)
        }).await
    }

    /// 删除刮削任务 - 异步版本
    pub async fn delete_scrape_task(&self, id: &str) -> AppResult<()> {
        let id = id.to_string();
        self.run_blocking(move |conn| {
            conn.execute("DELETE FROM scrape_tasks WHERE id = ?1", params![id])?;
            Ok(())
        }).await
    }

    /// 停止任务（设置为部分完成）- 异步版本
    pub async fn stop_task(&self, id: &str) -> AppResult<()> {
        let id = id.to_string();
        self.run_blocking(move |conn| {
            conn.execute(
                "UPDATE scrape_tasks SET status = 'partial', completed_at = datetime('now') WHERE id = ?1",
                params![id],
            )?;
            Ok(())
        }).await
    }

    /// 重置任务（清除所有进度）- 异步版本
    pub async fn reset_task(&self, id: &str) -> AppResult<()> {
        let id = id.to_string();
        self.run_blocking(move |conn| {
            conn.execute(
                "UPDATE scrape_tasks SET status = 'waiting', progress = 0, started_at = NULL, completed_at = NULL WHERE id = ?1",
                params![id],
            )?;
            Ok(())
        }).await
    }

    /// 检查视频是否有封面图
    pub fn has_cover_image(&self, video_path: &str) -> Result<bool> {
        let conn = self.get_connection()?;
        let has_cover: bool = conn
            .query_row(
                "SELECT poster IS NOT NULL
                 FROM videos WHERE video_path = ?1",
                params![video_path],
                |row| row.get(0),
            )
            .unwrap_or(false);
        Ok(has_cover)
    }

    pub fn update_video_cover_paths(
        conn: &Connection,
        video_id: &str,
        poster_path: &str,
        thumb_path: &str,
    ) -> Result<()> {
        conn.execute(
            "UPDATE videos SET poster = ?, thumb = ?, updated_at = datetime('now') WHERE id = ?",
            rusqlite::params![poster_path, thumb_path, video_id],
        )?;
        Ok(())
    }

    // ==================== 资源刮削写入相关操作 ====================

    pub fn get_video_duration(conn: &Connection, video_id: &str) -> Result<Option<i32>> {
        conn.query_row(
            "SELECT duration FROM videos WHERE id = ?",
            [video_id],
            |row| row.get(0),
        )
    }

    pub fn update_video_scrape_info(
        conn: &Connection,
        video_id: &str,
        data: &VideoScrapeUpdateData,
    ) -> Result<()> {
        conn.execute(
            "UPDATE videos SET
                title = ?,
                original_title = ?,
                studio = ?,
                director = ?,
                premiered = ?,
                duration = ?,
                rating = ?,
                poster = ?,
                local_id = ?,
                scan_status = 2,
                scraped_at = datetime('now'),
                updated_at = datetime('now')
            WHERE id = ?",
            rusqlite::params![
                data.title,
                data.original_title.unwrap_or(data.title),
                data.studio,
                data.director,
                data.premiered,
                data.duration,
                data.rating.unwrap_or(0.0),
                data.poster,
                data.local_id,
                video_id
            ],
        )?;
        Ok(())
    }

    pub fn update_video_file_location(
        conn: &Connection,
        video_id: &str,
        old_video_path: &str,
        new_video_path: &str,
        new_dir_path: &str,
        poster: Option<&str>,
        thumb: Option<&str>,
        fanart: Option<&str>,
    ) -> Result<()> {
        conn.execute(
            "UPDATE videos SET video_path = ?, dir_path = ?, poster = ?, thumb = ?, fanart = ?, updated_at = datetime('now') WHERE id = ?",
            rusqlite::params![new_video_path, new_dir_path, poster, thumb, fanart, video_id],
        )?;

        conn.execute(
            "UPDATE scrape_tasks SET path = ? WHERE path = ?",
            rusqlite::params![new_video_path, old_video_path],
        )?;

        Ok(())
    }

    pub fn update_video_file_location_tx(
        conn: &rusqlite::Transaction,
        video_id: &str,
        old_video_path: &str,
        new_video_path: &str,
        new_dir_path: &str,
        poster: Option<&str>,
        thumb: Option<&str>,
        fanart: Option<&str>,
    ) -> Result<()> {
        conn.execute(
            "UPDATE videos SET video_path = ?, dir_path = ?, poster = ?, thumb = ?, fanart = ?, updated_at = datetime('now') WHERE id = ?",
            rusqlite::params![new_video_path, new_dir_path, poster, thumb, fanart, video_id],
        )?;

        conn.execute(
            "UPDATE scrape_tasks SET path = ? WHERE path = ?",
            rusqlite::params![new_video_path, old_video_path],
        )?;

        Ok(())
    }

    // ==================== 扫描相关操作 ====================

    pub fn get_existing_video_paths(
        conn: &Connection,
        dir_path: &str,
    ) -> Result<std::collections::HashSet<String>> {
        let mut stmt =
            conn.prepare("SELECT video_path FROM videos WHERE dir_path LIKE ? || '%'")?;
        let rows = stmt.query_map([dir_path], |row| row.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 预加载目录下所有已有视频的扫描信息到 HashMap，避免逐个查询
    pub fn get_existing_video_scan_info_map(
        conn: &Connection,
        dir_path: &str,
    ) -> Result<std::collections::HashMap<String, ExistingVideoScanInfo>> {
        let mut stmt = conn.prepare(
            "SELECT
                video_path, id, title, original_title, studio, premiered, director,
                local_id, rating, file_size, fast_hash, duration, resolution,
                file_mtime, nfo_mtime, poster_mtime, thumb_mtime, fanart_mtime
            FROM videos
            WHERE dir_path LIKE ? || '%'"
        )?;
        let rows = stmt.query_map([dir_path], |row| {
            Ok((
                row.get::<_, String>(0)?,
                ExistingVideoScanInfo {
                    id: row.get(1)?,
                    title: row.get(2)?,
                    original_title: row.get(3)?,
                    studio: row.get(4)?,
                    premiered: row.get(5)?,
                    director: row.get(6)?,
                    local_id: row.get(7)?,
                    rating: row.get(8)?,
                    file_size: row.get::<_, Option<u64>>(9)?.unwrap_or(0),
                    fast_hash: row.get(10)?,
                    duration: row.get(11)?,
                    resolution: row.get(12)?,
                    file_mtime: row.get(13)?,
                    nfo_mtime: row.get(14)?,
                    poster_mtime: row.get(15)?,
                    thumb_mtime: row.get(16)?,
                    fanart_mtime: row.get(17)?,
                },
            ))
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// 批量删除视频记录（按路径列表）
    pub fn batch_delete_videos_by_paths(conn: &rusqlite::Transaction, paths: &[&str]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        // 分批处理，SQLite 参数上限为 999
        for chunk in paths.chunks(500) {
            let placeholders: Vec<&str> = chunk.iter().map(|_| "?").collect();
            let sql = format!(
                "DELETE FROM videos WHERE video_path IN ({})",
                placeholders.join(",")
            );
            let params: Vec<&dyn rusqlite::types::ToSql> = chunk
                .iter()
                .map(|s| s as &dyn rusqlite::types::ToSql)
                .collect();
            conn.execute(&sql, params.as_slice())?;
        }
        Ok(())
    }

    // ==================== 视频查重与辅助操作 ====================

    /// 根据番号 (local_id) 获取已存在的视频信息 (包含 id, title, video_path 等)
    pub async fn get_video_by_local_id(&self, local_id: &str) -> AppResult<Option<serde_json::Value>> {
        let local_id_upper = local_id.to_uppercase();

        self.run_blocking(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT id, title, video_path, file_size
                 FROM videos WHERE local_id = ?1 COLLATE NOCASE",
            )?;

            let mut rows = stmt.query(params![local_id_upper])?;

            if let Some(row) = rows.next()? {
                let id: String = row.get(0)?;
                let title: String = row.get(1)?;
                let video_path: String = row.get(2)?;
                let file_size: Option<i64> = row.get(3)?;

                Ok(Some(serde_json::json!({
                    "id": id,
                    "title": title,
                    "videoPath": video_path,
                    "fileSize": file_size
                })))
            } else {
                Ok(None)
            }
        }).await
    }

    pub fn delete_video_by_path(conn: &rusqlite::Transaction, video_path: &str) -> Result<()> {
        conn.execute(
            "DELETE FROM videos WHERE video_path = ?",
            params![video_path],
        )?;
        Ok(())
    }

    pub fn video_exists_by_path(conn: &rusqlite::Transaction, video_path: &str) -> Result<bool> {
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM videos WHERE video_path = ?",
                params![video_path],
                |_| Ok(true),
            )
            .unwrap_or(false);
        Ok(exists)
    }

    pub fn get_video_id_by_path(conn: &rusqlite::Transaction, video_path: &str) -> Result<String> {
        conn.query_row(
            "SELECT id FROM videos WHERE video_path = ?",
            params![video_path],
            |r| r.get(0),
        )
    }

    pub fn update_video(conn: &rusqlite::Transaction, data: &VideoUpdateData) -> Result<()> {
        conn.execute(
            "UPDATE videos SET
                updated_at = ?2,
                title = ?3,
                studio = ?4,
                premiered = ?5,
                director = ?6,
                file_size = ?7,
                fast_hash = ?8,
                original_title = ?9,
                duration = ?10,
                resolution = ?11,
                local_id = ?12,
                rating = ?13,
                poster = ?14,
                thumb = ?15,
                fanart = ?16,
                file_mtime = ?17,
                nfo_mtime = ?18,
                poster_mtime = ?19,
                thumb_mtime = ?20,
                fanart_mtime = ?21,
                scan_status = ?22
            WHERE video_path = ?1",
            params![
                data.path_str,
                data.now,
                data.title,
                data.studio,
                data.premiered,
                data.director,
                data.file_size,
                data.fast_hash,
                data.original_title,
                data.duration,
                data.resolution,
                data.local_id,
                data.rating,
                data.poster,
                data.thumb,
                data.fanart,
                data.file_mtime,
                data.nfo_mtime,
                data.poster_mtime,
                data.thumb_mtime,
                data.fanart_mtime,
                data.scan_status
            ],
        )?;
        Ok(())
    }

    pub fn insert_video(conn: &rusqlite::Transaction, data: &VideoInsertData) -> Result<()> {
        conn.execute(
            "INSERT INTO videos (
                id, local_id, video_path, dir_path, title, original_title,
                studio, premiered, director,
                file_size, fast_hash, created_at, updated_at, scan_status,
                duration, resolution, rating, poster, thumb, fanart,
                file_mtime, nfo_mtime, poster_mtime, thumb_mtime, fanart_mtime
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)",
            params![
                data.id,
                data.local_id,
                data.path_str,
                data.parent_str,
                data.title,
                data.original_title,
                data.studio,
                data.premiered,
                data.director,
                data.file_size,
                data.fast_hash,
                data.created_at,
                data.scan_status,
                data.duration,
                data.resolution,
                data.rating,
                data.poster,
                data.thumb,
                data.fanart,
                data.file_mtime,
                data.nfo_mtime,
                data.poster_mtime,
                data.thumb_mtime,
                data.fanart_mtime
            ],
        )?;
        Ok(())
    }

    pub fn get_video_scan_info(
        conn: &rusqlite::Transaction,
        video_path: &str,
    ) -> Result<Option<ExistingVideoScanInfo>> {
        conn.query_row(
            "SELECT
                id,
                title,
                original_title,
                studio,
                premiered,
                director,
                local_id,
                rating,
                file_size,
                fast_hash,
                duration,
                resolution,
                file_mtime,
                nfo_mtime,
                poster_mtime,
                thumb_mtime,
                fanart_mtime
            FROM videos
            WHERE video_path = ?",
            params![video_path],
            |row| {
                Ok(ExistingVideoScanInfo {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    original_title: row.get(2)?,
                    studio: row.get(3)?,
                    premiered: row.get(4)?,
                    director: row.get(5)?,
                    local_id: row.get(6)?,
                    rating: row.get(7)?,
                    file_size: row.get::<_, Option<u64>>(8)?.unwrap_or(0),
                    fast_hash: row.get(9)?,
                    duration: row.get(10)?,
                    resolution: row.get(11)?,
                    file_mtime: row.get(12)?,
                    nfo_mtime: row.get(13)?,
                    poster_mtime: row.get(14)?,
                    thumb_mtime: row.get(15)?,
                    fanart_mtime: row.get(16)?,
                })
            },
        )
        .optional()
    }

    pub fn clear_video_actors(conn: &rusqlite::Transaction, video_id: &str) -> Result<()> {
        conn.execute(
            "DELETE FROM video_actors WHERE video_id = ?",
            params![video_id],
        )?;
        Ok(())
    }

    pub fn add_video_actor(
        conn: &rusqlite::Transaction,
        video_id: &str,
        actor_id: i64,
        priority: usize,
    ) -> Result<()> {
        conn.execute(
            "INSERT INTO video_actors (video_id, actor_id, priority) VALUES (?, ?, ?)",
            params![video_id, actor_id, priority],
        )?;
        Ok(())
    }

    pub fn clear_video_tags(conn: &rusqlite::Transaction, video_id: &str) -> Result<()> {
        conn.execute(
            "DELETE FROM video_tags WHERE video_id = ?",
            params![video_id],
        )?;
        Ok(())
    }

    pub fn add_video_tag(conn: &rusqlite::Transaction, video_id: &str, tag_id: i64) -> Result<()> {
        conn.execute(
            "INSERT INTO video_tags (video_id, tag_id) VALUES (?, ?)",
            params![video_id, tag_id],
        )?;
        Ok(())
    }

    pub fn clear_video_genres(conn: &rusqlite::Transaction, video_id: &str) -> Result<()> {
        conn.execute(
            "DELETE FROM video_genres WHERE video_id = ?",
            params![video_id],
        )?;
        Ok(())
    }

    pub fn add_video_genre(
        conn: &rusqlite::Transaction,
        video_id: &str,
        genre_id: i64,
    ) -> Result<()> {
        conn.execute(
            "INSERT INTO video_genres (video_id, genre_id) VALUES (?, ?)",
            params![video_id, genre_id],
        )?;
        Ok(())
    }

    // ==================== 目录相关操作 ====================

    pub fn check_directory_exists(conn: &Connection, path: &str) -> Result<bool> {
        conn.query_row(
            "SELECT COUNT(*) > 0 FROM directories WHERE path = ?",
            params![path],
            |row| row.get(0),
        )
    }

    pub fn get_directory_video_count(
        conn: &Connection,
        path: &str,
        normalized_path: &str,
        path_pattern: &str,
    ) -> Result<i64> {
        conn.query_row(
            "SELECT COUNT(*) FROM videos WHERE
                dir_path = ? OR
                dir_path = ? OR
                REPLACE(dir_path, '\\', '/') LIKE ? OR
                REPLACE(dir_path, '\\', '/') = ?",
            params![path, normalized_path, path_pattern, normalized_path],
            |row| row.get(0),
        )
    }

    /// 规范化路径并统计目录下视频数量（封装路径规范化逻辑）
    pub fn count_videos_in_directory(conn: &Connection, path: &str) -> Result<i64> {
        let (normalized, pattern) = Self::normalize_dir_path(path);
        Self::get_directory_video_count(conn, path, &normalized, &pattern)
    }

    /// 删除指定目录及其子目录下的所有视频记录
    pub fn delete_videos_in_directory(conn: &Connection, path: &str) -> Result<usize> {
        let (normalized, pattern) = Self::normalize_dir_path(path);
        conn.execute(
            "DELETE FROM videos WHERE
                dir_path = ? OR
                dir_path = ? OR
                REPLACE(dir_path, '\\', '/') LIKE ? OR
                REPLACE(dir_path, '\\', '/') = ?",
            params![path, &normalized, &pattern, &normalized],
        )
    }

    /// 规范化目录路径：统一分隔符 + 构建 LIKE 模式
    fn normalize_dir_path(path: &str) -> (String, String) {
        let normalized = std::path::Path::new(path)
            .to_string_lossy()
            .replace('\\', "/");
        let pattern = if normalized.ends_with('/') {
            format!("{}%", normalized)
        } else {
            format!("{}/%", normalized)
        };
        (normalized, pattern)
    }

    pub fn update_directory_video_count(conn: &Connection, path: &str, count: i64) -> Result<()> {
        conn.execute(
            "UPDATE directories SET video_count = ?, updated_at = CURRENT_TIMESTAMP WHERE path = ?",
            params![count, path],
        )?;
        Ok(())
    }

    pub fn delete_video(conn: &Connection, video_id: &str) -> Result<()> {
        conn.execute("DELETE FROM videos WHERE id = ?", [video_id])?;
        Ok(())
    }

    pub fn get_waiting_scrape_task_id(conn: &Connection) -> Result<Option<String>> {
        conn.query_row(
            "SELECT id FROM scrape_tasks WHERE status = 'waiting' ORDER BY created_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
    }

    pub fn delete_scrape_task_by_id(conn: &Connection, task_id: &str) -> Result<()> {
        conn.execute("DELETE FROM scrape_tasks WHERE id = ?", [task_id])?;
        Ok(())
    }

    pub fn get_video_scan_status_by_path(
        conn: &Connection,
        video_path: &str,
    ) -> Result<Option<i32>> {
        conn.query_row(
            "SELECT scan_status FROM videos WHERE video_path = ?",
            [video_path],
            |row| row.get(0),
        )
        .optional()
    }
}
