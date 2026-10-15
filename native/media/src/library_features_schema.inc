R"SQL(
CREATE TABLE IF NOT EXISTS facet_favorites(dimension TEXT NOT NULL,name TEXT NOT NULL,favorite INTEGER NOT NULL CHECK(favorite IN (0,1)),PRIMARY KEY(dimension,name));
CREATE TABLE IF NOT EXISTS saved_resources(
 id TEXT PRIMARY KEY,lookup_key TEXT NOT NULL,code TEXT NOT NULL,code_key TEXT NOT NULL,
 work_id TEXT REFERENCES works(id) ON DELETE CASCADE,source_id TEXT NOT NULL,source_name TEXT NOT NULL,
 stream TEXT NOT NULL CHECK(json_valid(stream)),saved_at INTEGER NOT NULL,
 UNIQUE(lookup_key,source_id));
CREATE INDEX IF NOT EXISTS saved_resources_code ON saved_resources(code_key,work_id,saved_at DESC);
CREATE TABLE IF NOT EXISTS stream_targets(media_id TEXT PRIMARY KEY REFERENCES media_files(id) ON DELETE CASCADE,url TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_artwork(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,path TEXT NOT NULL UNIQUE,kind TEXT NOT NULL CHECK(kind IN ('poster','screenshot','sheet')),seconds REAL NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS artwork_work ON work_artwork(work_id,kind,id);
CREATE TABLE IF NOT EXISTS file_operations(
 id TEXT PRIMARY KEY,media_id TEXT NOT NULL,source TEXT NOT NULL,target TEXT NOT NULL,temporary TEXT NOT NULL,
 source_stamp TEXT NOT NULL,source_identity TEXT NOT NULL,temporary_identity TEXT NOT NULL,target_stamp TEXT NOT NULL DEFAULT '',
 size INTEGER NOT NULL,verified INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'copying',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS file_operations_state ON file_operations(state);
CREATE TABLE IF NOT EXISTS facet_aliases(dimension TEXT NOT NULL,alias TEXT NOT NULL,canonical TEXT NOT NULL,blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),PRIMARY KEY(dimension,alias));
CREATE INDEX IF NOT EXISTS facet_aliases_canonical ON facet_aliases(dimension,canonical,blocked);
CREATE TABLE IF NOT EXISTS facet_names(dimension TEXT NOT NULL,name TEXT NOT NULL,label TEXT NOT NULL,PRIMARY KEY(dimension,name));
CREATE TABLE IF NOT EXISTS media_parts(media_id TEXT PRIMARY KEY REFERENCES media_files(id) ON DELETE CASCADE,part_number INTEGER NOT NULL,total INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS media_quality(media_id TEXT PRIMARY KEY REFERENCES media_files(id) ON DELETE CASCADE,video_bitrate INTEGER NOT NULL DEFAULT 0 CHECK(video_bitrate>=0));
CREATE TABLE IF NOT EXISTS media_subtitles(media_id TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,path_key TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(media_id,path_key));
CREATE TABLE IF NOT EXISTS app_launches(id INTEGER PRIMARY KEY,payload TEXT NOT NULL,created INTEGER NOT NULL DEFAULT(unixepoch()));
)SQL"
