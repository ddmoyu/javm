pub mod models;
pub use models::*;

use crate::error::{AppError, AppResult};
use rusqlite::{Connection, Result};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

mod actors;
mod directory;
mod facets;
mod metadata;
mod schema;
mod scrape_tasks;
mod videos;

// ==================== 数据库核心 ====================

/// 数据库 schema 版本号，不匹配时直接删除旧数据库并重建
const DB_SCHEMA_VERSION: i32 = 2;

/// 从番号提取系列/厂牌前缀（如 `SSIS-001` → `SSIS`）。
///
/// 规则与番号识别器 `is_valid_designation` 一致：大写后按 `-` 分两段，
/// 前缀长度 2-8 且至少含一个字母（排除纯数字无码番号、分辨率等）。
pub fn series_prefix_of(local_id: &str) -> Option<String> {
    let upper = local_id.trim().to_uppercase();
    let parts: Vec<&str> = upper.split('-').collect();
    if parts.len() != 2 {
        return None;
    }
    let prefix = parts[0];
    let number = parts[1];
    let len = prefix.chars().count();
    if !(2..=8).contains(&len) {
        return None;
    }
    // 前缀至少含一个字母（排除纯数字无码番号），数字段至少含一个数字（排除非番号文本）
    if !prefix.chars().any(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    if !number.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(prefix.to_string())
}

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
            let conn = Self::open_tuned(&db_path)?;
            f(conn)
        })
        .await
        .map_err(|e| AppError::TaskJoin(e.to_string()))?
    }

    pub fn get_connection(&self) -> Result<Connection> {
        Self::open_tuned(&self.path)
    }

    /// 打开连接并应用每连接调优：5 秒忙等避免并发写时 SQLITE_BUSY 立即失败。
    /// WAL 是数据库级持久设置，只在 `init()` 设置一次即对后续所有连接生效，
    /// 无需每次打开连接（全库 100+ 处调用，含高频路径）都重设。
    fn open_tuned(path: &std::path::Path) -> Result<Connection> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(conn)
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
                    log::warn!(
                        "[db] event=legacy_schema_detected db_path={} schema_version={} target_schema_version={}",
                        self.path.display(),
                        version,
                        DB_SCHEMA_VERSION
                    );
                    drop(conn); // 关闭连接后再删除文件
                    if let Err(e) = fs::remove_file(&self.path) {
                        log::error!(
                            "[db] event=legacy_db_delete_failed db_path={} error={}",
                            self.path.display(),
                            e
                        );
                    } else {
                        log::info!(
                            "[db] event=legacy_db_deleted db_path={} action=reinitialize",
                            self.path.display()
                        );
                    }
                }
            }
            Err(e) => {
                log::error!(
                    "[db] event=open_for_schema_check_failed db_path={} action=delete_and_rebuild error={}",
                    self.path.display(),
                    e
                );
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}
