use super::*;
use rusqlite::{Connection, Result};

impl Database {
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
}
