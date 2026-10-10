R"SQL(
-- JAVM 1.0 library. Works exist independently of local resources.
CREATE TABLE works(
 id TEXT PRIMARY KEY,code TEXT NOT NULL DEFAULT '',code_key TEXT NOT NULL DEFAULT '',
 title TEXT NOT NULL,original_title TEXT NOT NULL DEFAULT '',plot TEXT NOT NULL DEFAULT '',
 studio TEXT NOT NULL DEFAULT '',label TEXT NOT NULL DEFAULT '',director TEXT NOT NULL DEFAULT '',
 series TEXT NOT NULL DEFAULT '',premiered TEXT NOT NULL DEFAULT '',runtime_seconds INTEGER NOT NULL DEFAULT 0,
 rating REAL NOT NULL DEFAULT 0 CHECK(rating>=0 AND rating<=10),
 favorite INTEGER NOT NULL DEFAULT 0,scan_status INTEGER NOT NULL DEFAULT 0,
 poster TEXT NOT NULL DEFAULT '',thumb TEXT NOT NULL DEFAULT '',fanart TEXT NOT NULL DEFAULT '',
 provenance TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,scraped_at TEXT);
CREATE INDEX works_code ON works(code_key);
CREATE INDEX works_created ON works(created_at,id);
CREATE INDEX works_favorite ON works(favorite,id);
CREATE TABLE work_sources(
 provider TEXT NOT NULL,source_id TEXT NOT NULL,work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
 PRIMARY KEY(provider,source_id));
CREATE INDEX sources_work ON work_sources(work_id);
CREATE TABLE media_files(
 id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
 path_key TEXT NOT NULL UNIQUE,path TEXT NOT NULL,dir_path TEXT NOT NULL,
 file_size INTEGER,file_mtime INTEGER,fast_hash TEXT NOT NULL DEFAULT '',file_stamp TEXT NOT NULL DEFAULT '',
 width INTEGER NOT NULL DEFAULT 0,height INTEGER NOT NULL DEFAULT 0,duration_ms INTEGER NOT NULL DEFAULT 0,
 codec TEXT NOT NULL DEFAULT '',missing INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX media_work ON media_files(work_id,missing,created_at,id);
CREATE TABLE nfo_documents(
 path_key TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
 path TEXT NOT NULL,stamp TEXT NOT NULL DEFAULT '',canonical INTEGER NOT NULL DEFAULT 0,
 content BLOB,encoding TEXT NOT NULL DEFAULT '',parser_version INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX nfo_canonical ON nfo_documents(work_id) WHERE canonical=1;
CREATE INDEX nfo_work ON nfo_documents(work_id);
CREATE TABLE entities(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,UNIQUE(kind,name));
CREATE TABLE asset_roots(id TEXT PRIMARY KEY,path_key TEXT NOT NULL UNIQUE,path TEXT NOT NULL);
CREATE TABLE work_entities(
 work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
 entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,priority INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(work_id,entity_id));
CREATE INDEX entities_work ON work_entities(entity_id,work_id);
CREATE TABLE directories(
 id TEXT PRIMARY KEY,path TEXT NOT NULL,path_key TEXT NOT NULL UNIQUE,recursive INTEGER NOT NULL DEFAULT 1,
 formats TEXT NOT NULL DEFAULT '[]',state TEXT NOT NULL DEFAULT 'idle',error TEXT NOT NULL DEFAULT '',
 scanned_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE playback_progress(
 source_key TEXT PRIMARY KEY CHECK(length(source_key)=64 AND source_key NOT GLOB '*[^a-f0-9]*'),
 position_seconds REAL NOT NULL CHECK(position_seconds>=0),duration_seconds REAL NOT NULL CHECK(duration_seconds>0 AND position_seconds<=duration_seconds),
 updated_at INTEGER NOT NULL CHECK(updated_at>=0));
CREATE TABLE javm_legacy_imports(source_path TEXT PRIMARY KEY,backup_path TEXT NOT NULL,imported_rows INTEGER NOT NULL,completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE legacy_records(source_path TEXT NOT NULL,table_name TEXT NOT NULL,row_number INTEGER NOT NULL,content BLOB NOT NULL,PRIMARY KEY(source_path,table_name,row_number));
PRAGMA application_id=1245793585;
PRAGMA user_version=1;
)SQL"
