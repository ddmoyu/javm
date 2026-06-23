use super::*;
use rusqlite::{params, Connection, OptionalExtension, Result};

impl Database {
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
