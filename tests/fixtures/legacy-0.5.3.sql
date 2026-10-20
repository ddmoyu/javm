-- Empty schema extracted from local tag v0.5.3; synthetic fixtures only.
CREATE TABLE IF NOT EXISTS actors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                avatar_path TEXT,
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
