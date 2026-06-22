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

    /// 初始化数据库表结构
    pub fn init(&self) -> Result<()> {
        log::info!("[db] event=init_started db_path={}", self.path.display());
        let conn = self.get_connection()?;
        log::info!("[db] event=connection_established db_path={}", self.path.display());

        // WAL 是数据库级持久设置，启动初始化时设置一次即对后续所有连接长期生效
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.execute("PRAGMA foreign_keys = ON", [])?;

        // 1. 元数据表
        // 演员表含档案字段（头像/别名/资料），演员中心模块使用；旧库由下方 ALTER 循环补列。
        conn.execute(
            "CREATE TABLE IF NOT EXISTS actors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                avatar_path TEXT,
                avatar_url TEXT,
                aliases TEXT,
                gender TEXT,
                height INTEGER,
                bust INTEGER,
                waist INTEGER,
                hip INTEGER,
                cup TEXT,
                birthday TEXT,
                debut_date TEXT,
                nationality TEXT,
                blood_type TEXT,
                summary TEXT,
                work_count INTEGER,
                profile_source TEXT,
                star_codes TEXT,
                profile_updated_at TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;
        // 兼容旧库：为已存在的 actors 表补演员档案列（列已存在则忽略错误，不升库版本、不丢数据）。
        for col in [
            "avatar_url TEXT",
            "aliases TEXT",
            "gender TEXT",
            "height INTEGER",
            "bust INTEGER",
            "waist INTEGER",
            "hip INTEGER",
            "cup TEXT",
            "birthday TEXT",
            "debut_date TEXT",
            "nationality TEXT",
            "blood_type TEXT",
            "summary TEXT",
            "work_count INTEGER",
            "profile_source TEXT",
            "star_codes TEXT",
            "profile_updated_at TEXT",
        ] {
            let _ = conn.execute(&format!("ALTER TABLE actors ADD COLUMN {}", col), []);
        }

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

        // 多维度浏览：片商 / 系列(番号前缀) / 导演 独立维度表（沿用 actors/genres 模式）。
        // 旧库由 IF NOT EXISTS 自动补建，存量数据由 backfill_video_dimensions 一次性回填。
        conn.execute(
            "CREATE TABLE IF NOT EXISTS studios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS series (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS directors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // 收藏：按（维度类型, 取值名）记一条。维度值列表是按名聚合派生的，故收藏也按名归属，
        // 演员/片商/系列/导演/分类 五类统一。entity_type ∈ actor/studio/series/director/genre。
        conn.execute(
            "CREATE TABLE IF NOT EXISTS favorites (
                entity_type TEXT NOT NULL,
                name TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (entity_type, name)
            )",
            [],
        )?;

        // 跨语言别名表（覆盖 actor/studio/tag）：同一实体的多语言/多写法名归并到同一
        // entity_id（按 entity_type 各自独立的合成簇 id）。name_norm 为归一化匹配键。
        conn.execute(
            "CREATE TABLE IF NOT EXISTS entity_aliases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_type TEXT NOT NULL,
                entity_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                name_norm TEXT NOT NULL,
                lang TEXT NOT NULL DEFAULT 'unknown',
                is_canonical INTEGER NOT NULL DEFAULT 0,
                source TEXT,
                confidence REAL NOT NULL DEFAULT 1.0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(entity_type, name_norm)
            )",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_entity_aliases_entity
             ON entity_aliases(entity_type, entity_id)",
            [],
        )?;

        // 番号→实体 绑定：作为「同番号关联」跨源/跨时间的累积桥，
        // studio 每片唯一、actor 仅单人作时绑定（多人作不绑定，避免误并合演者）。
        conn.execute(
            "CREATE TABLE IF NOT EXISTS designation_entities (
                designation TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id INTEGER NOT NULL,
                PRIMARY KEY (designation, entity_type)
            )",
            [],
        )?;

        // 别名原始证据（append-only）：每条 = 某数据源在某番号给出的某名字。
        // 别名簇(entity_aliases/designation_entities)是由它 + overrides 推导出的投影，可随时重建。
        // 清洗脏数据 = 删掉对应证据/源 → rebuild，合并因此可逆。
        conn.execute(
            "CREATE TABLE IF NOT EXISTS alias_evidence (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                designation TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                name TEXT NOT NULL,
                name_norm TEXT NOT NULL,
                source TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(designation, entity_type, name_norm, source)
            )",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_alias_evidence_lookup
             ON alias_evidence(entity_type, designation)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_alias_evidence_source
             ON alias_evidence(source)",
            [],
        )?;

        // 人工/种子校正规则（rebuild 与实时关联都尊重，避免重刮覆盖修正）：
        // kind='merge'：同 group_key 的名字强制归并；'block'：该名字永不入簇；'canonical'：锁定展示名。
        conn.execute(
            "CREATE TABLE IF NOT EXISTS alias_overrides (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                group_key TEXT,
                name TEXT NOT NULL,
                name_norm TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_alias_overrides_lookup
             ON alias_overrides(entity_type, kind)",
            [],
        )?;

        // 通用 KV 元信息表（如别名种子导入版本），供幂等迁移/一次性导入使用。
        conn.execute(
            "CREATE TABLE IF NOT EXISTS app_meta (
                key TEXT PRIMARY KEY,
                value TEXT
            )",
            [],
        )?;

        // 2. 视频主表
    log::info!("[db] event=create_videos_table_started");

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
                cover_width INTEGER,
                cover_height INTEGER,
                is_uncensored INTEGER DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                scraped_at TEXT
            )",
            [],
        )?;
        // 兼容旧库：为已存在的 videos 表补封面尺寸列（瀑布流等高画廊布局/虚拟化需要）。
        // 列已存在时会报错，忽略即可——不必升库版本、不丢用户数据。
        let _ = conn.execute("ALTER TABLE videos ADD COLUMN cover_width INTEGER", []);
        let _ = conn.execute("ALTER TABLE videos ADD COLUMN cover_height INTEGER", []);
        // 兼容旧库：补有码/无码标记列（有码无码分轨：识别为无码作品的视频置 1）。
        let _ = conn.execute("ALTER TABLE videos ADD COLUMN is_uncensored INTEGER DEFAULT 0", []);
        log::info!("[db] event=create_videos_table_succeeded");

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

        // 多维度关联表（片商 / 系列 / 导演）
        conn.execute(
            "CREATE TABLE IF NOT EXISTS video_studios (
                video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
                studio_id INTEGER REFERENCES studios(id) ON DELETE CASCADE,
                PRIMARY KEY (video_id, studio_id)
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS video_series (
                video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
                series_id INTEGER REFERENCES series(id) ON DELETE CASCADE,
                PRIMARY KEY (video_id, series_id)
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS video_directors (
                video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
                director_id INTEGER REFERENCES directors(id) ON DELETE CASCADE,
                PRIMARY KEY (video_id, director_id)
            )",
            [],
        )?;

        // 演员作品全集表（演员中心模块）：一个演员的全部作品（本地有 local_video_id 非空 / 缺失为空）。
        // status: local 本地已有 / missing 缺失（信息已补）/ scraping / downloading / downloaded / failed
        conn.execute(
            "CREATE TABLE IF NOT EXISTS actor_works (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_id INTEGER NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
                code TEXT NOT NULL,
                title TEXT,
                cover_url TEXT,
                release_date TEXT,
                source TEXT,
                local_video_id TEXT REFERENCES videos(id) ON DELETE SET NULL,
                status TEXT NOT NULL DEFAULT 'missing',
                is_uncensored INTEGER DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (actor_id, code)
            )",
            [],
        )?;

        // 维度作品全集表（片商/系列/导演通用，facet_type 区分；与 actor_works 同构）
        conn.execute(
            "CREATE TABLE IF NOT EXISTS facet_works (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                facet_type TEXT NOT NULL,
                facet_id INTEGER NOT NULL,
                code TEXT NOT NULL,
                title TEXT,
                cover_url TEXT,
                release_date TEXT,
                source TEXT,
                local_video_id TEXT REFERENCES videos(id) ON DELETE SET NULL,
                status TEXT NOT NULL DEFAULT 'missing',
                is_uncensored INTEGER DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (facet_type, facet_id, code)
            )",
            [],
        )?;
        // 维度表缓存其在数据源的 id（如 javbus `/studio/{id}`），用于抓全集
        for t in ["studios", "series", "directors", "genres"] {
            let _ = conn.execute(&format!("ALTER TABLE {} ADD COLUMN source_id TEXT", t), []);
        }

        // 4. 下载表
        // 状态码: 0=排队 1=准备 2=下载中 3=合并 4=刮削中 5=暂停 6=完成 7=失败 8=重试 9=取消
        log::info!("[db] event=create_downloads_table_started");
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
                source_site TEXT,

                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                completed_at TEXT
            )",
            [],
        )?;
        // 兼容旧库：为已存在的 downloads 表补 source_site 列（记录下载链接来源站点，用于下载源评分）。
        // 列已存在时会报错，忽略即可——不必升库版本、不丢用户数据。
        let _ = conn.execute("ALTER TABLE downloads ADD COLUMN source_site TEXT", []);
        log::info!("[db] event=create_downloads_table_succeeded");

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
        // 维度关联表反向索引：支撑「某片商/系列/导演的全部作品」查询
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_video_studios_studio ON video_studios (studio_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_video_series_series ON video_series (series_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_video_directors_director ON video_directors (director_id)",
            [],
        )?;
        // 演员作品全集：按演员取作品、按番号做本地匹配
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_actor_works_actor ON actor_works (actor_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_actor_works_code ON actor_works (code)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_facet_works_facet ON facet_works (facet_type, facet_id)",
            [],
        )?;

        // 存量视频维度回填（一次性，按 app_meta 标记幂等）
        let dim_backfilled: i64 = conn.query_row(
            "SELECT COUNT(*) FROM app_meta WHERE key = 'dim_backfill_v1'",
            [],
            |r| r.get(0),
        )?;
        if dim_backfilled == 0 {
            Self::backfill_video_dimensions(&conn)?;
            conn.execute(
                "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('dim_backfill_v1', '1')",
                [],
            )?;
            log::info!("[db] event=dimension_backfill_completed");
        }

        // 标记当前数据库 schema 版本
        conn.pragma_update(None, "user_version", DB_SCHEMA_VERSION)?;

        log::info!(
            "[db] event=init_completed db_path={} schema_version={}",
            self.path.display(),
            DB_SCHEMA_VERSION
        );

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

    /// 重建单个视频的维度关联（片商 / 系列 / 导演）。
    ///
    /// 先清后插，与 actors/genres 同样的「清空+重填」语义。片商/导演取文本字段，
    /// 系列由番号前缀派生（`series_prefix_of`）。空值/无效番号则该维度留空。
    /// 在三处写入路径复用：刮削落地（`write_all`）、手动编辑（`update_video`）、扫描（NFO 变更）。
    pub fn sync_video_dimensions(
        conn: &Connection,
        video_id: &str,
        studio: Option<&str>,
        director: Option<&str>,
        local_id: Option<&str>,
    ) -> Result<()> {
        conn.execute("DELETE FROM video_studios WHERE video_id = ?", params![video_id])?;
        conn.execute("DELETE FROM video_series WHERE video_id = ?", params![video_id])?;
        conn.execute("DELETE FROM video_directors WHERE video_id = ?", params![video_id])?;

        if let Some(name) = studio.map(str::trim).filter(|s| !s.is_empty()) {
            let id = Self::get_or_create_metadata(conn, MetadataTable::Studios, name)?;
            conn.execute(
                "INSERT OR IGNORE INTO video_studios (video_id, studio_id) VALUES (?, ?)",
                params![video_id, id],
            )?;
        }

        if let Some(name) = director.map(str::trim).filter(|s| !s.is_empty()) {
            let id = Self::get_or_create_metadata(conn, MetadataTable::Directors, name)?;
            conn.execute(
                "INSERT OR IGNORE INTO video_directors (video_id, director_id) VALUES (?, ?)",
                params![video_id, id],
            )?;
        }

        if let Some(name) = local_id.and_then(series_prefix_of) {
            let id = Self::get_or_create_metadata(conn, MetadataTable::Series, &name)?;
            conn.execute(
                "INSERT OR IGNORE INTO video_series (video_id, series_id) VALUES (?, ?)",
                params![video_id, id],
            )?;
        }

        // 新视频（番号）入库 → 把全集里同番号的缺失作品回填为本地（演员/维度面板即时转本地）。
        // 副作用，失败不应阻断维度同步本身（如全集表尚未建/异常），best-effort。
        if let Some(code) = local_id.map(str::trim).filter(|s| !s.is_empty()) {
            let _ = Self::relink_works_for_code(conn, code, video_id);
        }

        Ok(())
    }

    /// 写入/更新演员作品全集中的一部作品（按 `UNIQUE(actor_id, code)` 幂等）。
    ///
    /// 冲突时仅以非空新值覆盖（`COALESCE`），便于多源补全；不改 `local_video_id`/`status`
    /// （由 `relink_actor_works_local` 统一按本地库匹配维护）。
    pub fn upsert_actor_work(conn: &Connection, w: &ActorWorkInput) -> Result<()> {
        conn.execute(
            "INSERT INTO actor_works
                (actor_id, code, title, cover_url, release_date, source, is_uncensored, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP)
             ON CONFLICT(actor_id, code) DO UPDATE SET
                title = COALESCE(excluded.title, actor_works.title),
                cover_url = COALESCE(excluded.cover_url, actor_works.cover_url),
                release_date = COALESCE(excluded.release_date, actor_works.release_date),
                source = COALESCE(excluded.source, actor_works.source),
                is_uncensored = excluded.is_uncensored,
                updated_at = CURRENT_TIMESTAMP",
            params![
                w.actor_id,
                w.code,
                w.title,
                w.cover_url,
                w.release_date,
                w.source,
                w.is_uncensored as i64,
            ],
        )?;
        Ok(())
    }

    /// 将某演员的作品全集与本地库按番号匹配：命中本地视频则 `local_video_id` 回填且 `status='local'`，
    /// 否则 `status='missing'`。仅触碰 `local`/`missing` 行，不干扰下载中等中间态。
    pub fn relink_actor_works_local(conn: &Connection, actor_id: i64) -> Result<usize> {
        let affected = conn.execute(
            "UPDATE actor_works
             SET local_video_id = (
                     SELECT v.id FROM videos v
                     WHERE UPPER(TRIM(v.local_id)) = UPPER(TRIM(actor_works.code))
                     LIMIT 1
                 ),
                 status = CASE WHEN EXISTS (
                     SELECT 1 FROM videos v
                     WHERE UPPER(TRIM(v.local_id)) = UPPER(TRIM(actor_works.code))
                 ) THEN 'local' ELSE 'missing' END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE actor_id = ?1 AND status IN ('local', 'missing')",
            params![actor_id],
        )?;
        Ok(affected)
    }

    // ==================== 维度（片商/系列/导演）作品全集 ====================

    /// 维度类型 → (维度表, 关联表, 关联列)。白名单，防注入；非法类型返回 None。
    fn facet_tables(facet_type: &str) -> Option<(&'static str, &'static str, &'static str)> {
        match facet_type {
            "studio" => Some(("studios", "video_studios", "studio_id")),
            "series" => Some(("series", "video_series", "series_id")),
            "director" => Some(("directors", "video_directors", "director_id")),
            "genre" => Some(("genres", "video_genres", "genre_id")),
            _ => None,
        }
    }

    /// 写入/更新维度作品全集中的一部作品（按 `UNIQUE(facet_type, facet_id, code)` 幂等，COALESCE 多源补全）。
    pub fn upsert_facet_work(conn: &Connection, w: &FacetWorkInput) -> Result<()> {
        conn.execute(
            "INSERT INTO facet_works
                (facet_type, facet_id, code, title, cover_url, release_date, source, is_uncensored, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP)
             ON CONFLICT(facet_type, facet_id, code) DO UPDATE SET
                title = COALESCE(excluded.title, facet_works.title),
                cover_url = COALESCE(excluded.cover_url, facet_works.cover_url),
                release_date = COALESCE(excluded.release_date, facet_works.release_date),
                source = COALESCE(excluded.source, facet_works.source),
                is_uncensored = excluded.is_uncensored,
                updated_at = CURRENT_TIMESTAMP",
            params![
                w.facet_type,
                w.facet_id,
                w.code,
                w.title,
                w.cover_url,
                w.release_date,
                w.source,
                w.is_uncensored as i64,
            ],
        )?;
        Ok(())
    }

    /// 维度作品全集与本地库按番号匹配（同 `relink_actor_works_local`，按 facet 维度）。
    pub fn relink_facet_works_local(
        conn: &Connection,
        facet_type: &str,
        facet_id: i64,
    ) -> Result<usize> {
        let affected = conn.execute(
            "UPDATE facet_works
             SET local_video_id = (
                     SELECT v.id FROM videos v
                     WHERE UPPER(TRIM(v.local_id)) = UPPER(TRIM(facet_works.code)) LIMIT 1
                 ),
                 status = CASE WHEN EXISTS (
                     SELECT 1 FROM videos v
                     WHERE UPPER(TRIM(v.local_id)) = UPPER(TRIM(facet_works.code))
                 ) THEN 'local' ELSE 'missing' END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE facet_type = ?1 AND facet_id = ?2 AND status IN ('local', 'missing')",
            params![facet_type, facet_id],
        )?;
        Ok(affected)
    }

    /// 切换收藏（不存在则加、存在则删），返回切换后的收藏态（true=已收藏）。
    pub fn toggle_favorite(conn: &Connection, entity_type: &str, name: &str) -> Result<bool> {
        let name = name.trim();
        let exists = conn
            .query_row(
                "SELECT 1 FROM favorites WHERE entity_type = ?1 AND name = ?2",
                params![entity_type, name],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if exists {
            conn.execute(
                "DELETE FROM favorites WHERE entity_type = ?1 AND name = ?2",
                params![entity_type, name],
            )?;
            Ok(false)
        } else {
            conn.execute(
                "INSERT OR IGNORE INTO favorites (entity_type, name) VALUES (?1, ?2)",
                params![entity_type, name],
            )?;
            Ok(true)
        }
    }

    /// 某维度类型下的全部收藏取值名（按收藏时间倒序）。
    pub fn list_favorites(conn: &Connection, entity_type: &str) -> Result<Vec<String>> {
        let mut stmt = conn.prepare(
            "SELECT name FROM favorites WHERE entity_type = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(params![entity_type], |r| r.get::<_, String>(0))?;
        rows.collect()
    }

    /// 新视频（番号）入库后：把全集里同番号的「缺失」作品回填为本地（演员 + 维度全集一并处理）。
    ///
    /// 仅触碰 `local`/`missing` 行，不干扰下载中等中间态。下载/扫描入库后，演员/维度面板里
    /// 这部作品即从「缺失」转「本地」并关联到该视频，无需重新抓取全集。
    pub fn relink_works_for_code(conn: &Connection, code: &str, video_id: &str) -> Result<usize> {
        let code = code.trim();
        if code.is_empty() {
            return Ok(0);
        }
        let mut affected = conn.execute(
            "UPDATE actor_works
             SET local_video_id = ?2, status = 'local', updated_at = CURRENT_TIMESTAMP
             WHERE UPPER(TRIM(code)) = UPPER(TRIM(?1)) AND status IN ('local', 'missing')",
            params![code, video_id],
        )?;
        affected += conn.execute(
            "UPDATE facet_works
             SET local_video_id = ?2, status = 'local', updated_at = CURRENT_TIMESTAMP
             WHERE UPPER(TRIM(code)) = UPPER(TRIM(?1)) AND status IN ('local', 'missing')",
            params![code, video_id],
        )?;
        Ok(affected)
    }

    /// 缓存维度在数据源的 id（如 javbus `/studio/{id}`）。
    pub fn set_facet_source_id(
        conn: &Connection,
        facet_type: &str,
        facet_id: i64,
        source_id: &str,
    ) -> Result<()> {
        let (table, _, _) = Self::facet_tables(facet_type)
            .ok_or_else(|| rusqlite::Error::InvalidParameterName(facet_type.to_string()))?;
        conn.execute(
            &format!("UPDATE {} SET source_id = ?2 WHERE id = ?1", table),
            params![facet_id, source_id],
        )?;
        Ok(())
    }

    /// 读取维度已缓存的数据源 id。
    pub fn get_facet_source_id(
        conn: &Connection,
        facet_type: &str,
        facet_id: i64,
    ) -> Result<Option<String>> {
        let (table, _, _) = Self::facet_tables(facet_type)
            .ok_or_else(|| rusqlite::Error::InvalidParameterName(facet_type.to_string()))?;
        conn.query_row(
            &format!("SELECT source_id FROM {} WHERE id = ?", table),
            params![facet_id],
            |r| r.get(0),
        )
        .optional()
        .map(|opt| opt.flatten())
    }

    /// 某番号对应本地视频的全部分类名（分类数据源 id「排除法对应」用）。
    pub fn get_local_video_genres(conn: &Connection, code: &str) -> Result<Vec<String>> {
        let mut stmt = conn.prepare(
            "SELECT g.name FROM video_genres vg
             JOIN genres g ON g.id = vg.genre_id
             JOIN videos v ON v.id = vg.video_id
             WHERE UPPER(TRIM(v.local_id)) = UPPER(TRIM(?1))",
        )?;
        let rows = stmt.query_map(params![code], |r| r.get::<_, String>(0))?;
        rows.collect()
    }

    /// 按番号取本地视频 id（番号在线搜索：在线结果与本地库按番号匹配标 local/missing，结果不落库）。
    pub fn find_local_video_id_by_code(conn: &Connection, code: &str) -> Result<Option<String>> {
        conn.query_row(
            "SELECT id FROM videos WHERE UPPER(TRIM(local_id)) = UPPER(TRIM(?1)) LIMIT 1",
            params![code],
            |r| r.get(0),
        )
        .optional()
    }

    /// 找该维度下任一本地视频的番号（用于刮其详情页解析维度的数据源 id）。
    pub fn find_local_code_for_facet(
        conn: &Connection,
        facet_type: &str,
        facet_id: i64,
    ) -> Result<Option<String>> {
        let (_, rel_table, rel_col) = Self::facet_tables(facet_type)
            .ok_or_else(|| rusqlite::Error::InvalidParameterName(facet_type.to_string()))?;
        conn.query_row(
            &format!(
                "SELECT v.local_id FROM videos v
                 JOIN {rel} r ON r.video_id = v.id
                 WHERE r.{col} = ?1 AND v.local_id IS NOT NULL AND TRIM(v.local_id) <> ''
                 LIMIT 1",
                rel = rel_table,
                col = rel_col
            ),
            params![facet_id],
            |r| r.get(0),
        )
        .optional()
        .map(|opt| opt.flatten())
    }

    /// 把对某番号刮到的标题/封面存回作品全集条目（actor_works + facet_works，按番号大小写不敏感）。
    /// 供「缺失作品」预览刮削后持久化——非空才覆盖，关窗也不丢。
    pub fn save_scraped_work_meta(
        conn: &Connection,
        code: &str,
        title: &str,
        cover_url: &str,
    ) -> Result<()> {
        for table in ["actor_works", "facet_works"] {
            conn.execute(
                &format!(
                    "UPDATE {} SET
                        title = COALESCE(NULLIF(?2, ''), title),
                        cover_url = COALESCE(NULLIF(?3, ''), cover_url),
                        updated_at = CURRENT_TIMESTAMP
                     WHERE UPPER(TRIM(code)) = UPPER(TRIM(?1))",
                    table
                ),
                params![code, title, cover_url],
            )?;
        }
        Ok(())
    }

    /// 用详情页抓取的头像信息补全演员档案（仅当演员已存在，按名匹配）。
    ///
    /// `avatar_url` 非空才覆盖（旧值保留）；`star_code` 为字母数字时以 `{"javbus":"code"}` 存入 `star_codes`。
    /// 二者皆空则不更新时间戳。
    pub fn update_actor_avatar(
        conn: &Connection,
        name: &str,
        avatar_url: &str,
        star_code: &str,
    ) -> Result<()> {
        let avatar = avatar_url.trim();
        let sc = star_code.trim();
        let star_codes_json = if !sc.is_empty()
            && sc.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            Some(format!(r#"{{"javbus":"{}"}}"#, sc))
        } else {
            None
        };
        conn.execute(
            "UPDATE actors SET
                avatar_url = COALESCE(NULLIF(?2, ''), avatar_url),
                star_codes = COALESCE(?3, star_codes),
                profile_updated_at = CASE WHEN ?2 <> '' OR ?3 IS NOT NULL
                    THEN CURRENT_TIMESTAMP ELSE profile_updated_at END
             WHERE name = ?1",
            params![name, avatar, star_codes_json],
        )?;
        Ok(())
    }

    /// 写入演员档案（star 页解析结果）。各字段 None 时 `COALESCE` 保留已有值（多源/分次补全）。
    pub fn update_actor_profile(
        conn: &Connection,
        actor_id: i64,
        p: &ActorProfileInput,
    ) -> Result<()> {
        conn.execute(
            "UPDATE actors SET
                avatar_url = COALESCE(?2, avatar_url),
                birthday = COALESCE(?3, birthday),
                height = COALESCE(?4, height),
                cup = COALESCE(?5, cup),
                bust = COALESCE(?6, bust),
                waist = COALESCE(?7, waist),
                hip = COALESCE(?8, hip),
                profile_source = 'javbus',
                profile_updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1",
            params![
                actor_id,
                p.avatar_url,
                p.birthday,
                p.height,
                p.cup,
                p.bust,
                p.waist,
                p.hip,
            ],
        )?;
        Ok(())
    }

    /// 读取演员的数据源 star code（从 `star_codes` JSON 的 `javbus` 键）。
    pub fn get_actor_star_code(conn: &Connection, actor_id: i64) -> Result<Option<String>> {
        let raw: Option<String> = conn
            .query_row(
                "SELECT star_codes FROM actors WHERE id = ?",
                params![actor_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        Ok(raw
            .as_deref()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
            .and_then(|v| v.get("javbus").and_then(|x| x.as_str()).map(String::from)))
    }

    /// 记录演员作品全集总数。
    pub fn set_actor_work_count(conn: &Connection, actor_id: i64, count: i64) -> Result<()> {
        conn.execute(
            "UPDATE actors SET work_count = ?2 WHERE id = ?1",
            params![actor_id, count],
        )?;
        Ok(())
    }

    /// 一次性回填：为所有存量视频重建维度关联。由 `init()` 按 app_meta 标记仅执行一次。
    fn backfill_video_dimensions(conn: &Connection) -> Result<()> {
        let rows: Vec<(String, Option<String>, Option<String>, Option<String>)> = {
            let mut stmt =
                conn.prepare("SELECT id, studio, director, local_id FROM videos")?;
            let mapped = stmt.query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?;
            mapped.collect::<Result<Vec<_>>>()?
        };

        for (id, studio, director, local_id) in rows {
            Self::sync_video_dimensions(
                conn,
                &id,
                studio.as_deref(),
                director.as_deref(),
                local_id.as_deref(),
            )?;
        }
        Ok(())
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
        // 任一标准图集列存在即视为有封面（竖裁失败时可能仅有横版 fanart/thumb）
        let has_cover: bool = conn
            .query_row(
                "SELECT (poster IS NOT NULL AND poster <> '')
                     OR (fanart IS NOT NULL AND fanart <> '')
                     OR (thumb IS NOT NULL AND thumb <> '')
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
        poster_path: Option<&str>,
        thumb_path: Option<&str>,
        fanart_path: Option<&str>,
        cover_width: Option<i32>,
        cover_height: Option<i32>,
    ) -> Result<()> {
        conn.execute(
            "UPDATE videos SET poster = ?, thumb = ?, fanart = ?, cover_width = ?, cover_height = ?, updated_at = datetime('now') WHERE id = ?",
            rusqlite::params![poster_path, thumb_path, fanart_path, cover_width, cover_height, video_id],
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
                thumb = ?,
                fanart = ?,
                local_id = ?,
                cover_width = ?,
                cover_height = ?,
                is_uncensored = ?,
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
                data.thumb,
                data.fanart,
                data.local_id,
                data.cover_width,
                data.cover_height,
                data.is_uncensored as i32,
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
                file_mtime, nfo_mtime, poster_mtime, thumb_mtime, fanart_mtime,
                poster, thumb, fanart, scan_status
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
                    file_size: row.get::<_, Option<i64>>(9)?.unwrap_or(0) as u64,
                    fast_hash: row.get(10)?,
                    duration: row.get(11)?,
                    resolution: row.get(12)?,
                    file_mtime: row.get(13)?,
                    nfo_mtime: row.get(14)?,
                    poster_mtime: row.get(15)?,
                    thumb_mtime: row.get(16)?,
                    fanart_mtime: row.get(17)?,
                    poster: row.get(18)?,
                    thumb: row.get(19)?,
                    fanart: row.get(20)?,
                    scan_status: row.get::<_, Option<i32>>(21)?.unwrap_or(1),
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
                data.file_size as i64,
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
                file_mtime, nfo_mtime, poster_mtime, thumb_mtime, fanart_mtime,
                cover_width, cover_height
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)",
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
                data.file_size as i64,
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
                data.fanart_mtime,
                data.cover_width,
                data.cover_height
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
                fanart_mtime,
                poster,
                thumb,
                fanart,
                scan_status
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
                    file_size: row.get::<_, Option<i64>>(8)?.unwrap_or(0) as u64,
                    fast_hash: row.get(9)?,
                    duration: row.get(10)?,
                    resolution: row.get(11)?,
                    file_mtime: row.get(12)?,
                    nfo_mtime: row.get(13)?,
                    poster_mtime: row.get(14)?,
                    thumb_mtime: row.get(15)?,
                    fanart_mtime: row.get(16)?,
                    poster: row.get(17)?,
                    thumb: row.get(18)?,
                    fanart: row.get(19)?,
                    scan_status: row.get::<_, Option<i32>>(20)?.unwrap_or(1),
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
            params![video_id, actor_id, priority as i64],
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

    /// 加载所有「目录管理」目录的规范化前缀（统一为 `/` 分隔、去除结尾 `/`）。
    pub fn managed_directory_prefixes(conn: &Connection) -> Result<Vec<String>> {
        let mut stmt = conn.prepare("SELECT path FROM directories")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows
            .filter_map(|r| r.ok())
            .map(|p| p.replace('\\', "/").trim_end_matches('/').to_string())
            .filter(|p| !p.is_empty())
            .collect())
    }

    /// 判断视频文件路径是否位于任一「目录管理」目录（或其子目录）下。
    /// Windows 下路径大小写不敏感。
    pub fn is_path_under_managed_directory(prefixes: &[String], video_path: &str) -> bool {
        let normalized = video_path.replace('\\', "/");
        prefixes
            .iter()
            .any(|prefix| Self::path_is_inside(&normalized, prefix))
    }

    /// 判断 `path` 是否在目录 `dir` 之内（dir 为不带结尾 `/` 的规范化路径）。
    fn path_is_inside(path: &str, dir: &str) -> bool {
        let needle = format!("{}/", dir);
        #[cfg(windows)]
        {
            path.to_ascii_lowercase()
                .starts_with(&needle.to_ascii_lowercase())
        }
        #[cfg(not(windows))]
        {
            path.starts_with(&needle)
        }
    }

    /// 判断单个视频文件是否位于「目录管理」内（便捷封装）。
    pub fn is_video_under_managed_directory(conn: &Connection, video_path: &str) -> Result<bool> {
        let prefixes = Self::managed_directory_prefixes(conn)?;
        Ok(Self::is_path_under_managed_directory(&prefixes, video_path))
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

#[cfg(test)]
mod dimension_tests {
    use super::{series_prefix_of, Database};
    use rusqlite::{params, Connection, OptionalExtension};

    fn setup_dim_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE videos (id TEXT PRIMARY KEY, studio TEXT, director TEXT, local_id TEXT);
             CREATE TABLE studios (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, created_at TEXT);
             CREATE TABLE series (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, created_at TEXT);
             CREATE TABLE directors (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, created_at TEXT);
             CREATE TABLE video_studios (video_id TEXT, studio_id INTEGER, PRIMARY KEY (video_id, studio_id));
             CREATE TABLE video_series (video_id TEXT, series_id INTEGER, PRIMARY KEY (video_id, series_id));
             CREATE TABLE video_directors (video_id TEXT, director_id INTEGER, PRIMARY KEY (video_id, director_id));",
        )
        .unwrap();
        conn
    }

    fn dim_name(conn: &Connection, rel: &str, dim: &str, col: &str, video_id: &str) -> Option<String> {
        let sql = format!(
            "SELECT d.name FROM {dim} d JOIN {rel} r ON r.{col} = d.id WHERE r.video_id = ?"
        );
        conn.query_row(&sql, params![video_id], |r| r.get(0)).optional().unwrap()
    }

    #[test]
    fn series_prefix_extracts_label() {
        assert_eq!(series_prefix_of("SSIS-001"), Some("SSIS".to_string()));
        assert_eq!(series_prefix_of("ipx-177"), Some("IPX".to_string()));
        assert_eq!(series_prefix_of("  abp-123 "), Some("ABP".to_string()));
        assert_eq!(series_prefix_of("300MAAN-456"), Some("300MAAN".to_string()));
    }

    #[test]
    fn series_prefix_rejects_non_designations() {
        assert_eq!(series_prefix_of(""), None);
        assert_eq!(series_prefix_of("SSIS001"), None); // 无分隔符
        assert_eq!(series_prefix_of("010112-001"), None); // 纯数字前缀（无码）
        assert_eq!(series_prefix_of("A-001"), None); // 前缀过短
        assert_eq!(series_prefix_of("ABCDEFGHI-001"), None); // 前缀过长
        assert_eq!(series_prefix_of("NO-NUMBER"), None); // 数字段无数字
        assert_eq!(series_prefix_of("FC2-PPV-1234567"), None); // 多段
    }

    #[test]
    fn sync_dimensions_populates_all_relations() {
        let conn = setup_dim_db();
        Database::sync_video_dimensions(
            &conn,
            "v1",
            Some("S1 STUDIO"),
            Some("导演A"),
            Some("SSIS-123"),
        )
        .unwrap();

        assert_eq!(dim_name(&conn, "video_studios", "studios", "studio_id", "v1").as_deref(), Some("S1 STUDIO"));
        assert_eq!(dim_name(&conn, "video_series", "series", "series_id", "v1").as_deref(), Some("SSIS"));
        assert_eq!(dim_name(&conn, "video_directors", "directors", "director_id", "v1").as_deref(), Some("导演A"));
    }

    #[test]
    fn sync_dimensions_skips_empty_and_invalid() {
        let conn = setup_dim_db();
        // 空片商/空导演/无码番号 → 三个维度均不建立关联
        Database::sync_video_dimensions(&conn, "v1", Some("  "), None, Some("010112-001")).unwrap();
        assert!(dim_name(&conn, "video_studios", "studios", "studio_id", "v1").is_none());
        assert!(dim_name(&conn, "video_series", "series", "series_id", "v1").is_none());
        assert!(dim_name(&conn, "video_directors", "directors", "director_id", "v1").is_none());
    }

    #[test]
    fn sync_dimensions_rebuilds_on_rerun() {
        let conn = setup_dim_db();
        Database::sync_video_dimensions(&conn, "v1", Some("OLD"), None, Some("ABP-001")).unwrap();
        // 改片商 + 改番号前缀 → 旧关联清除，新关联建立
        Database::sync_video_dimensions(&conn, "v1", Some("NEW"), None, Some("IPX-200")).unwrap();

        assert_eq!(dim_name(&conn, "video_studios", "studios", "studio_id", "v1").as_deref(), Some("NEW"));
        assert_eq!(dim_name(&conn, "video_series", "series", "series_id", "v1").as_deref(), Some("IPX"));
        // 同番号前缀的复用：另一视频归入同一 series 记录
        Database::sync_video_dimensions(&conn, "v2", None, None, Some("IPX-201")).unwrap();
        let series_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM series", [], |r| r.get(0))
            .unwrap();
        assert_eq!(series_rows, 2); // ABP（遗留）、IPX；IPX 未因 v2 重复创建
    }
}

#[cfg(test)]
mod actor_works_tests {
    use super::{ActorWorkInput, Database};
    use rusqlite::Connection;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE actors (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL);
             CREATE TABLE videos (id TEXT PRIMARY KEY, local_id TEXT);
             CREATE TABLE actor_works (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_id INTEGER NOT NULL,
                code TEXT NOT NULL,
                title TEXT, cover_url TEXT, release_date TEXT, source TEXT,
                local_video_id TEXT,
                status TEXT NOT NULL DEFAULT 'missing',
                is_uncensored INTEGER DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (actor_id, code)
             );",
        )
        .unwrap();
        conn.execute("INSERT INTO actors (id, name) VALUES (1, '演员A')", [])
            .unwrap();
        conn
    }

    fn work(actor_id: i64, code: &'static str) -> ActorWorkInput<'static> {
        ActorWorkInput {
            actor_id,
            code,
            title: None,
            cover_url: None,
            release_date: None,
            source: None,
            is_uncensored: false,
        }
    }

    #[test]
    fn upsert_is_idempotent_and_coalesces() {
        let conn = setup();
        Database::upsert_actor_work(
            &conn,
            &ActorWorkInput { title: Some("标题1"), cover_url: Some("u1"), ..work(1, "SSIS-001") },
        )
        .unwrap();
        // 第二次：title=None 不抹掉已有标题；cover 非空覆盖
        Database::upsert_actor_work(
            &conn,
            &ActorWorkInput { cover_url: Some("u2"), ..work(1, "SSIS-001") },
        )
        .unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM actor_works", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1); // 同 actor+code 幂等不新增
        let (title, cover): (String, String) = conn
            .query_row(
                "SELECT title, cover_url FROM actor_works WHERE actor_id=1 AND code='SSIS-001'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "标题1"); // COALESCE 保留
        assert_eq!(cover, "u2"); // 非空覆盖
    }

    #[test]
    fn relink_marks_local_and_missing() {
        let conn = setup();
        // 本地有 ssis-001（大小写与 code 不同），无 ABP-002
        conn.execute("INSERT INTO videos (id, local_id) VALUES ('v1', 'ssis-001')", [])
            .unwrap();
        Database::upsert_actor_work(&conn, &work(1, "SSIS-001")).unwrap();
        Database::upsert_actor_work(&conn, &work(1, "ABP-002")).unwrap();

        let n = Database::relink_actor_works_local(&conn, 1).unwrap();
        assert_eq!(n, 2);

        let (lv, st): (Option<String>, String) = conn
            .query_row(
                "SELECT local_video_id, status FROM actor_works WHERE code='SSIS-001'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(lv.as_deref(), Some("v1")); // 大小写不敏感匹配
        assert_eq!(st, "local");

        let (lv2, st2): (Option<String>, String) = conn
            .query_row(
                "SELECT local_video_id, status FROM actor_works WHERE code='ABP-002'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(lv2.is_none());
        assert_eq!(st2, "missing");
    }
}

#[cfg(test)]
mod actor_avatar_tests {
    use super::Database;
    use rusqlite::Connection;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE actors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                avatar_url TEXT,
                star_codes TEXT,
                profile_updated_at TEXT
             );
             INSERT INTO actors (name) VALUES ('三上悠亜');",
        )
        .unwrap();
        conn
    }

    #[test]
    fn sets_avatar_and_star_codes() {
        let conn = setup();
        Database::update_actor_avatar(&conn, "三上悠亜", "https://img/a.jpg", "abc").unwrap();
        let (av, sc): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT avatar_url, star_codes FROM actors WHERE name='三上悠亜'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(av.as_deref(), Some("https://img/a.jpg"));
        assert_eq!(sc.as_deref(), Some(r#"{"javbus":"abc"}"#));
    }

    #[test]
    fn empty_values_keep_existing() {
        let conn = setup();
        Database::update_actor_avatar(&conn, "三上悠亜", "https://img/a.jpg", "abc").unwrap();
        Database::update_actor_avatar(&conn, "三上悠亜", "", "").unwrap(); // 空值不覆盖
        let av: Option<String> = conn
            .query_row("SELECT avatar_url FROM actors WHERE name='三上悠亜'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(av.as_deref(), Some("https://img/a.jpg"));
    }

    #[test]
    fn unknown_actor_is_noop() {
        let conn = setup();
        // 演员不存在：WHERE 不匹配，0 行受影响，不报错
        Database::update_actor_avatar(&conn, "不存在", "https://img/a.jpg", "abc").unwrap();
    }
}

#[cfg(test)]
mod actor_profile_tests {
    use super::{ActorProfileInput, Database};
    use rusqlite::Connection;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE actors (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL,
                avatar_url TEXT, birthday TEXT, height INTEGER, cup TEXT,
                bust INTEGER, waist INTEGER, hip INTEGER, work_count INTEGER,
                star_codes TEXT, profile_source TEXT, profile_updated_at TEXT
             );
             INSERT INTO actors (id, name, star_codes) VALUES (1, 'A', '{\"javbus\":\"xyz\"}');
             INSERT INTO actors (id, name) VALUES (2, 'B');",
        )
        .unwrap();
        conn
    }

    #[test]
    fn update_profile_sets_and_coalesces() {
        let conn = setup();
        let p = ActorProfileInput {
            avatar_url: Some("u".into()),
            birthday: Some("1990-01-01".into()),
            height: Some(160),
            cup: Some("D".into()),
            bust: Some(88),
            waist: Some(58),
            hip: Some(85),
        };
        Database::update_actor_profile(&conn, 1, &p).unwrap();
        let (h, cup, bust): (Option<i64>, Option<String>, Option<i64>) = conn
            .query_row("SELECT height, cup, bust FROM actors WHERE id=1", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(h, Some(160));
        assert_eq!(cup.as_deref(), Some("D"));
        assert_eq!(bust, Some(88));

        // None 字段不覆盖已有，Some 字段覆盖
        let p2 = ActorProfileInput { cup: Some("E".into()), ..Default::default() };
        Database::update_actor_profile(&conn, 1, &p2).unwrap();
        let (h2, cup2): (Option<i64>, Option<String>) = conn
            .query_row("SELECT height, cup FROM actors WHERE id=1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(h2, Some(160)); // 保留
        assert_eq!(cup2.as_deref(), Some("E")); // 覆盖
    }

    #[test]
    fn reads_star_code_from_json() {
        let conn = setup();
        assert_eq!(
            Database::get_actor_star_code(&conn, 1).unwrap().as_deref(),
            Some("xyz")
        );
        assert_eq!(Database::get_actor_star_code(&conn, 2).unwrap(), None); // star_codes 为空
    }

    #[test]
    fn sets_work_count() {
        let conn = setup();
        Database::set_actor_work_count(&conn, 1, 42).unwrap();
        let c: Option<i64> = conn
            .query_row("SELECT work_count FROM actors WHERE id=1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(c, Some(42));
    }
}
