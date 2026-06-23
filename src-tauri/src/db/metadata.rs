use super::*;
use rusqlite::{params, Connection, Result};

impl Database {
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
