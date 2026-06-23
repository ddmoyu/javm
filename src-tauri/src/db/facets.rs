use super::*;
use rusqlite::{params, Connection, OptionalExtension, Result};

impl Database {
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

    /// 根据分面类型将维度名反哺到已匹配本地视频的 metadata 中（原本缺失才补，不覆盖已有值）。
    ///
    /// - `genre`：分类多值，存 `video_genres` 关联表（前端 `v.genres` 即读这张表）→ INSERT OR IGNORE。
    /// - `studio` / `director`：前端显示读的是 `videos.studio` / `videos.director` **列**，故主补该列
    ///   （仅当为空），同时维护 `video_*` 关联表供后端 `find_local_code_for_facet` 匹配用。
    /// - `series`：发现页「系列」= 番号前缀（`SSIS-001`→`SSIS`），由 `local_id` 实时派生、无存储列，
    ///   只要有番号就自动归类，无需反哺；这里仅维护关联表供后端匹配。
    ///
    /// 调用时机：`relink_facet_works_local` 匹配到本地视频后按 video_id 逐条调用。
    pub fn enrich_local_video_from_facet(
        conn: &Connection,
        facet_type: &str,
        facet_name: &str,
        video_id: &str,
    ) -> Result<()> {
        match facet_type {
            "genre" => {
                let genre_id = Self::get_or_create_genre(conn, facet_name)?;
                conn.execute(
                    "INSERT OR IGNORE INTO video_genres (video_id, genre_id) VALUES (?1, ?2)",
                    params![video_id, genre_id],
                )?;
            }
            "studio" => {
                let studio_id =
                    Self::get_or_create_metadata(conn, MetadataTable::Studios, facet_name)?;
                conn.execute(
                    "INSERT OR IGNORE INTO video_studios (video_id, studio_id) VALUES (?1, ?2)",
                    params![video_id, studio_id],
                )?;
                // 片商显示读的是 videos.studio 列：原本为空才补，不覆盖已有正确值
                conn.execute(
                    "UPDATE videos SET studio = ?2, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?1 AND (studio IS NULL OR TRIM(studio) = '')",
                    params![video_id, facet_name],
                )?;
            }
            "series" => {
                let series_id =
                    Self::get_or_create_metadata(conn, MetadataTable::Series, facet_name)?;
                conn.execute(
                    "INSERT OR IGNORE INTO video_series (video_id, series_id) VALUES (?1, ?2)",
                    params![video_id, series_id],
                )?;
            }
            "director" => {
                let director_id =
                    Self::get_or_create_metadata(conn, MetadataTable::Directors, facet_name)?;
                conn.execute(
                    "INSERT OR IGNORE INTO video_directors (video_id, director_id) VALUES (?1, ?2)",
                    params![video_id, director_id],
                )?;
                // 导演显示读的是 videos.director 列：原本为空才补，不覆盖已有正确值
                conn.execute(
                    "UPDATE videos SET director = ?2, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?1 AND (director IS NULL OR TRIM(director) = '')",
                    params![video_id, facet_name],
                )?;
            }
            _ => {}
        }
        Ok(())
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
}
