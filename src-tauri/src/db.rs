use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

// ==================== 数据模型 ====================

/// 刮削任务状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ScrapeStatus {
    Waiting,
    Running,
    Completed,
    Partial,
    Failed,
}

impl ScrapeStatus {
    pub fn as_str(&self) -> &str {
        match self {
            ScrapeStatus::Waiting => "waiting",
            ScrapeStatus::Running => "running",
            ScrapeStatus::Completed => "completed",
            ScrapeStatus::Partial => "partial",
            ScrapeStatus::Failed => "failed",
        }
    }

    pub fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "waiting" => Ok(ScrapeStatus::Waiting),
            "running" => Ok(ScrapeStatus::Running),
            "completed" => Ok(ScrapeStatus::Completed),
            "partial" => Ok(ScrapeStatus::Partial),
            "failed" => Ok(ScrapeStatus::Failed),
            _ => Err(format!("Invalid scrape status: {}", s)),
        }
    }
}

/// 刮削任务模型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrapeTask {
    pub id: String,
    pub path: String,
    pub status: ScrapeStatus,
    pub progress: i32,
    pub created_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

pub struct VideoUpdateData<'a> {
    pub path_str: &'a str,
    pub title: &'a str,
    pub studio: Option<&'a str>,
    pub premiered: Option<&'a str>,
    pub director: Option<&'a str>,
    pub file_size: u64,
    pub fast_hash: &'a str,
    pub original_title: &'a str,
    pub duration: Option<i32>,
    pub resolution: Option<String>,
    pub local_id: Option<&'a str>,
    pub rating: Option<f64>,
    pub poster: Option<String>,
    pub thumb: Option<String>,
    pub fanart: Option<String>,
    pub scan_status: i32,
    pub now: &'a str,
}

pub struct VideoInsertData<'a> {
    pub id: &'a str,
    pub local_id: Option<&'a str>,
    pub path_str: &'a str,
    pub parent_str: &'a str,
    pub title: &'a str,
    pub original_title: &'a str,
    pub studio: Option<&'a str>,
    pub premiered: Option<&'a str>,
    pub director: Option<&'a str>,
    pub file_size: u64,
    pub fast_hash: &'a str,
    pub created_at: &'a str,
    pub scan_status: i32,
    pub duration: Option<i32>,
    pub resolution: Option<String>,
    pub rating: Option<f64>,
    pub poster: Option<String>,
    pub thumb: Option<String>,
    pub fanart: Option<String>,
}

pub struct VideoScrapeUpdateData<'a> {
    pub title: &'a str,
    pub original_title: Option<&'a str>,
    pub studio: Option<&'a str>,
    pub director: Option<&'a str>,
    pub premiered: Option<&'a str>,
    pub duration: Option<i32>,
    pub rating: Option<f64>,
    pub poster: &'a str,
    pub local_id: Option<&'a str>,
}

// ==================== 数据库核心 ====================

/// 数据库 schema 版本号，v0.2.0 起设为 1，旧版数据库默认为 0
const DB_SCHEMA_VERSION: i32 = 1;

#[derive(Clone)]
pub struct Database {
    path: PathBuf,
}

impl Database {
    /// 创建数据库实例
    pub fn new(app: &AppHandle) -> Self {
        let app_dir = app
            .path()
            .app_data_dir()
            .expect("Failed to get app data dir");

        if !app_dir.exists() {
            fs::create_dir_all(&app_dir).expect("Failed to create app data dir");
        }

        let path = app_dir.join("javm.db");
        Self { path }
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

        // 5.1 截图封面任务表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS cover_capture_tasks (
                id TEXT PRIMARY KEY,
                video_id TEXT NOT NULL,
                video_path TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'waiting',
                cover_path TEXT,
                error TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
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
    pub fn get_or_create_metadata(conn: &Connection, table: &str, name: &str) -> Result<i64> {
        let query_sql = format!("SELECT id FROM {} WHERE name = ?", table);
        let mut stmt = conn.prepare(&query_sql)?;
        let mut rows = stmt.query(rusqlite::params![name])?;

        if let Some(row) = rows.next()? {
            return Ok(row.get(0)?);
        }

        let insert_sql = format!("INSERT INTO {} (name) VALUES (?)", table);
        conn.execute(&insert_sql, rusqlite::params![name])?;
        Ok(conn.last_insert_rowid())
    }

    pub fn get_or_create_tag(conn: &Connection, name: &str) -> Result<i64> {
        Self::get_or_create_metadata(conn, "tags", name)
    }

    pub fn get_or_create_actor(conn: &Connection, name: &str) -> Result<i64> {
        Self::get_or_create_metadata(conn, "actors", name)
    }

    pub fn get_or_create_genre(conn: &Connection, name: &str) -> Result<i64> {
        Self::get_or_create_metadata(conn, "genres", name)
    }

    // ==================== 刮削任务操作 ====================

    /// 批量创建刮削任务（使用事务）- 异步版本
    pub async fn create_scrape_tasks_batch(&self, tasks: Vec<(String, String)>) -> Result<usize> {
        let db_path = self.path.clone();

        tokio::task::spawn_blocking(move || {
            let mut conn = rusqlite::Connection::open(&db_path)?;
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
        .map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            )))
        })?
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
    pub async fn get_all_scrape_tasks(&self) -> Result<Vec<ScrapeTask>> {
        let db_path = self.path.clone();

        tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(&db_path)?;
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
        .map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            )))
        })?
    }

    /// 更新刮削任务状态 - 异步版本
    pub async fn update_scrape_task_status(
        &self,
        id: &str,
        status: ScrapeStatus,
        progress: Option<i32>,
    ) -> Result<()> {
        let db_path = self.path.clone();
        let id = id.to_string();

        tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(&db_path)?;

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
        .map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            )))
        })?
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
    pub async fn delete_completed_tasks(&self) -> Result<usize> {
        let db_path = self.path.clone();

        tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(&db_path)?;
            let count = conn.execute("DELETE FROM scrape_tasks WHERE status = 'completed'", [])?;
            Ok(count)
        })
        .await
        .map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            )))
        })?
    }

    /// 删除所有失败的刮削任务 - 异步版本
    pub async fn delete_failed_scrape_tasks(&self) -> Result<usize> {
        let db_path = self.path.clone();

        tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(&db_path)?;
            let count = conn.execute("DELETE FROM scrape_tasks WHERE status = 'failed'", [])?;
            Ok(count)
        })
        .await
        .map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            )))
        })?
    }

    /// 删除全部刮削任务 - 异步版本
    pub async fn delete_all_scrape_tasks(&self) -> Result<usize> {
        let db_path = self.path.clone();

        tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(&db_path)?;
            let count = conn.execute("DELETE FROM scrape_tasks", [])?;
            Ok(count)
        })
        .await
        .map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            )))
        })?
    }

    /// 删除刮削任务 - 异步版本
    pub async fn delete_scrape_task(&self, id: &str) -> Result<()> {
        let db_path = self.path.clone();
        let id = id.to_string();

        tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(&db_path)?;
            conn.execute("DELETE FROM scrape_tasks WHERE id = ?1", params![id])?;
            Ok(())
        })
        .await
        .map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            )))
        })?
    }

    /// 停止任务（设置为部分完成）- 异步版本
    pub async fn stop_task(&self, id: &str) -> Result<()> {
        let db_path = self.path.clone();
        let id = id.to_string();

        tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(&db_path)?;
            conn.execute(
                "UPDATE scrape_tasks SET status = 'partial', completed_at = datetime('now') WHERE id = ?1",
                params![id],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))))?
    }

    /// 重置任务（清除所有进度）- 异步版本
    pub async fn reset_task(&self, id: &str) -> Result<()> {
        let db_path = self.path.clone();
        let id = id.to_string();

        tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(&db_path)?;
            conn.execute(
                "UPDATE scrape_tasks SET status = 'waiting', progress = 0, started_at = NULL, completed_at = NULL WHERE id = ?1",
                params![id],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))))?
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

    // ==================== 截图封面任务操作 ====================

    /// 批量创建截图封面任务
    pub async fn create_cover_capture_tasks_batch(
        &self,
        tasks: Vec<(String, String, String)>, // (id, video_id, video_path)
    ) -> Result<usize> {
        let db_path = self.path.clone();

        tokio::task::spawn_blocking(move || {
            let mut conn = rusqlite::Connection::open(&db_path)?;
            let tx = conn.transaction()?;

            let mut created = 0;
            for (id, video_id, video_path) in tasks {
                // 跳过已存在的（按 video_id 去重）
                let exists: bool = tx
                    .query_row(
                        "SELECT COUNT(*) > 0 FROM cover_capture_tasks WHERE video_id = ?1 AND status != 'completed'",
                        params![video_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(false);

                if !exists {
                    tx.execute(
                        "INSERT INTO cover_capture_tasks (id, video_id, video_path, status) VALUES (?1, ?2, ?3, 'waiting')",
                        params![id, video_id, video_path],
                    )?;
                    created += 1;
                }
            }

            tx.commit()?;
            Ok(created)
        })
        .await
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))))?
    }

    /// 获取所有截图封面任务
    pub async fn get_all_cover_capture_tasks(&self) -> Result<Vec<serde_json::Value>> {
        let db_path = self.path.clone();

        tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(&db_path)?;
            let mut stmt = conn.prepare(
                "SELECT id, video_id, video_path, status, cover_path, error, created_at, completed_at
                 FROM cover_capture_tasks ORDER BY created_at DESC"
            )?;

            let rows = stmt.query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "videoId": row.get::<_, String>(1)?,
                    "videoPath": row.get::<_, String>(2)?,
                    "status": row.get::<_, String>(3)?,
                    "coverPath": row.get::<_, Option<String>>(4)?,
                    "error": row.get::<_, Option<String>>(5)?,
                    "createdAt": row.get::<_, Option<String>>(6)?,
                    "completedAt": row.get::<_, Option<String>>(7)?,
                }))
            })?;

            let mut tasks = Vec::new();
            for row in rows {
                tasks.push(row?);
            }
            Ok(tasks)
        })
        .await
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))))?
    }

    /// 更新截图封面任务状态
    pub fn update_cover_capture_task(
        &self,
        video_id: &str,
        status: &str,
        cover_path: Option<&str>,
        error: Option<&str>,
    ) -> Result<()> {
        let conn = self.get_connection()?;
        let completed_at = if status == "completed" || status == "failed" {
            Some(chrono::Utc::now().to_rfc3339())
        } else {
            None
        };

        conn.execute(
            "UPDATE cover_capture_tasks SET status = ?1, cover_path = ?2, error = ?3, completed_at = ?4 WHERE video_id = ?5 AND status != 'completed'",
            params![status, cover_path, error, completed_at, video_id],
        )?;
        Ok(())
    }

    /// 删除已完成的截图封面任务
    pub async fn delete_completed_cover_capture_tasks(&self) -> Result<usize> {
        let db_path = self.path.clone();

        tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(&db_path)?;
            let count = conn.execute(
                "DELETE FROM cover_capture_tasks WHERE status = 'completed'",
                [],
            )?;
            Ok(count)
        })
        .await
        .map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            )))
        })?
    }

    /// 将所有运行中的截图封面任务重置为等待
    pub fn reset_running_cover_capture_tasks(&self) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "UPDATE cover_capture_tasks SET status = 'waiting', error = NULL WHERE status = 'running'",
            [],
        )?;
        Ok(())
    }

    /// 删除失败的截图封面任务
    #[allow(dead_code)]
    pub async fn delete_failed_cover_capture_tasks(&self) -> Result<usize> {
        let db_path = self.path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(&db_path)?;
            let count = conn.execute(
                "DELETE FROM cover_capture_tasks WHERE status = 'failed'",
                [],
            )?;
            Ok(count)
        })
        .await
        .map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            )))
        })?
    }

    /// 删除全部截图封面任务
    pub async fn delete_all_cover_capture_tasks(&self) -> Result<usize> {
        let db_path = self.path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(&db_path)?;
            let count = conn.execute("DELETE FROM cover_capture_tasks", [])?;
            Ok(count)
        })
        .await
        .map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            )))
        })?
    }

    /// 删除单个截图封面任务
    pub async fn delete_cover_capture_task(&self, video_id: &str) -> Result<usize> {
        let db_path = self.path.clone();
        let video_id = video_id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(&db_path)?;
            let count = conn.execute(
                "DELETE FROM cover_capture_tasks WHERE video_id = ?1",
                rusqlite::params![video_id],
            )?;
            Ok(count)
        })
        .await
        .map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            )))
        })?
    }

    /// 重试单个截图封面任务（重置为等待状态）
    pub async fn retry_cover_capture_task(&self, video_id: &str) -> Result<()> {
        let db_path = self.path.clone();
        let video_id = video_id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(&db_path)?;
            conn.execute(
                "UPDATE cover_capture_tasks SET status = 'waiting', error = NULL, completed_at = NULL WHERE video_id = ?1 AND status = 'failed'",
                rusqlite::params![video_id],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))))?
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
    // ==================== 视频查重与辅助操作 ====================

    /// 根据番号 (local_id) 获取已存在的视频信息 (包含 id, title, video_path 等)
    pub async fn get_video_by_local_id(&self, local_id: &str) -> Result<Option<serde_json::Value>> {
        let db_path = self.path.clone();
        let local_id_upper = local_id.to_uppercase();

        tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(&db_path)?;
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
        })
        .await
        .map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            )))
        })?
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
                title = coalesce(?3, title),
                studio = coalesce(?4, studio),
                premiered = coalesce(?5, premiered),
                director = coalesce(?6, director),
                file_size = ?7,
                fast_hash = ?8,
                original_title = coalesce(?9, original_title),
                duration = coalesce(?10, duration),
                resolution = coalesce(?11, resolution),
                local_id = coalesce(?12, local_id),
                rating = coalesce(?13, rating),
                poster = coalesce(?14, poster),
                thumb = coalesce(?15, thumb),
                fanart = coalesce(?16, fanart),
                scan_status = ?17
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
                duration, resolution, rating, poster, thumb, fanart
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
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
                data.fanart
            ],
        )?;
        Ok(())
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

    pub fn update_directory_video_count(conn: &Connection, path: &str, count: i64) -> Result<()> {
        conn.execute(
            "UPDATE directories SET video_count = ?, updated_at = CURRENT_TIMESTAMP WHERE path = ?",
            params![count, path],
        )?;
        Ok(())
    }

    pub fn get_failed_cover_capture_tasks(conn: &Connection) -> Result<Vec<(String, String)>> {
        let mut stmt = conn.prepare(
            "SELECT video_id, video_path FROM cover_capture_tasks WHERE status = 'failed'",
        )?;

        let failed_tasks: Vec<(String, String)> = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(failed_tasks)
    }

    pub fn reset_failed_cover_capture_tasks(conn: &Connection) -> Result<()> {
        conn.execute(
            "UPDATE cover_capture_tasks SET status = 'waiting', error = NULL WHERE status = 'failed'",
            [],
        )?;
        Ok(())
    }

    pub fn get_video_id_and_cover(
        conn: &Connection,
        video_path: &str,
    ) -> Result<(String, Option<String>)> {
        conn.query_row(
            "SELECT id, COALESCE(thumb, poster) FROM videos WHERE video_path = ?",
            [video_path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
    }

    pub fn get_video_poster_path(conn: &Connection, video_id: &str) -> Result<Option<String>> {
        conn.query_row(
            "SELECT poster FROM videos WHERE id = ?",
            [video_id],
            |row| row.get(0),
        )
    }

    pub fn delete_video(conn: &Connection, video_id: &str) -> Result<()> {
        conn.execute("DELETE FROM videos WHERE id = ?", [video_id])?;
        Ok(())
    }

    pub fn delete_failed_cover_capture_tasks_sync(conn: &Connection) -> Result<()> {
        conn.execute(
            "DELETE FROM cover_capture_tasks WHERE status = 'failed'",
            [],
        )?;
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
