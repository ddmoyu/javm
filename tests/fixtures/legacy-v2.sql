-- Synthetic empty schema from JAVM dd0e6b6 (v0.5.4-beta.3); no user data.
CREATE TABLE IF NOT EXISTS actors (
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
            );
CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                category TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
CREATE TABLE IF NOT EXISTS genres (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
CREATE TABLE IF NOT EXISTS studios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
CREATE TABLE IF NOT EXISTS series (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
CREATE TABLE IF NOT EXISTS directors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
CREATE TABLE IF NOT EXISTS favorites (
                entity_type TEXT NOT NULL,
                name TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (entity_type, name)
            );
CREATE TABLE IF NOT EXISTS entity_aliases (
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
            );
CREATE TABLE IF NOT EXISTS designation_entities (
                designation TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id INTEGER NOT NULL,
                PRIMARY KEY (designation, entity_type)
            );
CREATE TABLE IF NOT EXISTS alias_evidence (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                designation TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                name TEXT NOT NULL,
                name_norm TEXT NOT NULL,
                source TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(designation, entity_type, name_norm, source)
            );
CREATE TABLE IF NOT EXISTS alias_overrides (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                group_key TEXT,
                name TEXT NOT NULL,
                name_norm TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
CREATE TABLE IF NOT EXISTS app_meta (
                key TEXT PRIMARY KEY,
                value TEXT
            );
CREATE TABLE IF NOT EXISTS videos (
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
            );
CREATE TABLE IF NOT EXISTS video_actors (
                video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
                actor_id INTEGER REFERENCES actors(id) ON DELETE CASCADE,
                priority INTEGER DEFAULT 0,
                PRIMARY KEY (video_id, actor_id)
            );
CREATE TABLE IF NOT EXISTS video_tags (
                video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
                tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY (video_id, tag_id)
            );
CREATE TABLE IF NOT EXISTS video_genres (
                video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
                genre_id INTEGER REFERENCES genres(id) ON DELETE CASCADE,
                PRIMARY KEY (video_id, genre_id)
            );
CREATE TABLE IF NOT EXISTS video_studios (
                video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
                studio_id INTEGER REFERENCES studios(id) ON DELETE CASCADE,
                PRIMARY KEY (video_id, studio_id)
            );
CREATE TABLE IF NOT EXISTS video_series (
                video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
                series_id INTEGER REFERENCES series(id) ON DELETE CASCADE,
                PRIMARY KEY (video_id, series_id)
            );
CREATE TABLE IF NOT EXISTS video_directors (
                video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
                director_id INTEGER REFERENCES directors(id) ON DELETE CASCADE,
                PRIMARY KEY (video_id, director_id)
            );
CREATE TABLE IF NOT EXISTS actor_works (
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
            );
CREATE TABLE IF NOT EXISTS facet_works (
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
            );
CREATE TABLE IF NOT EXISTS downloads (
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
            );
CREATE TABLE IF NOT EXISTS scrape_tasks (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL,
                status TEXT NOT NULL,
                progress INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                started_at TEXT,
                completed_at TEXT
            );
CREATE TABLE IF NOT EXISTS directories (
                id TEXT PRIMARY KEY,
                path TEXT UNIQUE NOT NULL,
                video_count INTEGER DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
PRAGMA user_version=2;
