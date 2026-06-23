use super::*;
use rusqlite::{params, Connection, OptionalExtension, Result};

impl Database {
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
