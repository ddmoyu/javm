R"SQL(
CREATE TABLE IF NOT EXISTS saved_resources(
 id TEXT PRIMARY KEY,lookup_key TEXT NOT NULL,code TEXT NOT NULL,code_key TEXT NOT NULL,
 work_id TEXT REFERENCES works(id) ON DELETE CASCADE,source_id TEXT NOT NULL,source_name TEXT NOT NULL,
 stream TEXT NOT NULL CHECK(json_valid(stream)),saved_at INTEGER NOT NULL,
 UNIQUE(lookup_key,source_id));
CREATE INDEX IF NOT EXISTS saved_resources_code ON saved_resources(code_key,work_id,saved_at DESC);
)SQL"
