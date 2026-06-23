use super::*;
use rusqlite::{params, Connection, OptionalExtension, Result};

impl Database {
    /// 批量创建刮削任务（使用事务）- 异步版本
    pub async fn create_scrape_tasks_batch(&self, tasks: Vec<(String, String)>) -> AppResult<usize> {
        self.run_blocking(move |conn| {
            // run_blocking 给的是 Connection，需要手动开事务
            // 因为 Transaction 需要 &mut Connection，这里用一个内部作用域
            let mut conn = conn;
            let tx = conn.transaction()?;

            let mut created_count = 0;
            for (id, path) in tasks {
                tx.execute(
                    "INSERT INTO scrape_tasks (id, path, status, progress) VALUES (?1, ?2, ?3, ?4)",
                    params![id, path, ScrapeStatus::Waiting.as_str(), 0],
                )?;
                created_count += 1;
            }

            tx.commit()?;
            Ok(created_count)
        })
        .await
    }

    /// 检查视频是否已完全刮削
    pub fn is_video_completely_scraped(&self, video_path: &str) -> Result<bool> {
        use std::path::Path;

        let conn = self.get_connection()?;

        // 检查数据库状态
        let scan_status: Option<i32> = conn
            .query_row(
                "SELECT scan_status FROM videos WHERE video_path = ?",
                params![video_path],
                |row| row.get(0),
            )
            .optional()?;

        if scan_status != Some(2) {
            return Ok(false);
        }

        // 检查 NFO 文件是否存在
        let video_path_obj = Path::new(video_path);
        let nfo_path = video_path_obj.with_extension("nfo");

        Ok(nfo_path.exists())
    }

    /// 根据 ID 获取刮削任务
    pub fn get_scrape_task(&self, id: &str) -> Result<Option<ScrapeTask>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, path, status, progress, created_at, started_at, completed_at
             FROM scrape_tasks WHERE id = ?1",
        )?;

        let mut rows = stmt.query(params![id])?;

        if let Some(row) = rows.next()? {
            let status_str: String = row.get(2)?;
            let status =
                ScrapeStatus::from_str(&status_str).map_err(|_| rusqlite::Error::InvalidQuery)?;

            Ok(Some(ScrapeTask {
                id: row.get(0)?,
                path: row.get(1)?,
                status,
                progress: row.get(3)?,
                created_at: row.get(4)?,
                started_at: row.get(5)?,
                completed_at: row.get(6)?,
            }))
        } else {
            Ok(None)
        }
    }

    /// 获取所有刮削任务 - 异步版本
    pub async fn get_all_scrape_tasks(&self) -> AppResult<Vec<ScrapeTask>> {
        self.run_blocking(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, path, status, progress, created_at, started_at, completed_at
                 FROM scrape_tasks ORDER BY created_at DESC",
            )?;

            let tasks = stmt
                .query_map([], |row| {
                    let status_str: String = row.get(2)?;
                    let status = ScrapeStatus::from_str(&status_str)
                        .map_err(|_| rusqlite::Error::InvalidQuery)?;

                    Ok(ScrapeTask {
                        id: row.get(0)?,
                        path: row.get(1)?,
                        status,
                        progress: row.get(3)?,
                        created_at: row.get(4)?,
                        started_at: row.get(5)?,
                        completed_at: row.get(6)?,
                    })
                })?
                .collect::<Result<Vec<_>>>()?;

            Ok(tasks)
        })
        .await
    }

    /// 更新刮削任务状态 - 异步版本
    pub async fn update_scrape_task_status(
        &self,
        id: &str,
        status: ScrapeStatus,
        progress: Option<i32>,
    ) -> AppResult<()> {
        let id = id.to_string();

        self.run_blocking(move |conn| {
            let mut sql = String::from("UPDATE scrape_tasks SET status = ?1");
            let mut param_count = 2;

            if progress.is_some() {
                sql.push_str(&format!(", progress = ?{}", param_count));
                param_count += 1;
            }

            if status == ScrapeStatus::Running {
                sql.push_str(", started_at = CURRENT_TIMESTAMP");
            }

            if matches!(
                status,
                ScrapeStatus::Completed | ScrapeStatus::Partial | ScrapeStatus::Failed
            ) {
                sql.push_str(", completed_at = CURRENT_TIMESTAMP");
            }

            sql.push_str(&format!(" WHERE id = ?{}", param_count));

            if let Some(prog) = progress {
                conn.execute(&sql, params![status.as_str(), prog, id])?;
            } else {
                conn.execute(&sql, params![status.as_str(), id])?;
            }

            Ok(())
        })
        .await
    }

    /// 更新刮削任务进度
    pub fn update_scrape_task_progress(&self, id: &str, progress: i32) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "UPDATE scrape_tasks SET progress = ?1 WHERE id = ?2",
            params![progress, id],
        )?;
        Ok(())
    }

    /// 删除所有已完成的任务 - 异步版本
    pub async fn delete_completed_tasks(&self) -> AppResult<usize> {
        self.run_blocking(|conn| {
            Ok(conn.execute("DELETE FROM scrape_tasks WHERE status = 'completed'", [])?)
        }).await
    }

    /// 删除所有失败的刮削任务 - 异步版本
    pub async fn delete_failed_scrape_tasks(&self) -> AppResult<usize> {
        self.run_blocking(|conn| {
            Ok(conn.execute("DELETE FROM scrape_tasks WHERE status = 'failed'", [])?)
        }).await
    }

    /// 删除全部刮削任务 - 异步版本
    pub async fn delete_all_scrape_tasks(&self) -> AppResult<usize> {
        self.run_blocking(|conn| {
            Ok(conn.execute("DELETE FROM scrape_tasks", [])?)
        }).await
    }

    /// 删除刮削任务 - 异步版本
    pub async fn delete_scrape_task(&self, id: &str) -> AppResult<()> {
        let id = id.to_string();
        self.run_blocking(move |conn| {
            conn.execute("DELETE FROM scrape_tasks WHERE id = ?1", params![id])?;
            Ok(())
        }).await
    }

    /// 停止任务（设置为部分完成）- 异步版本
    pub async fn stop_task(&self, id: &str) -> AppResult<()> {
        let id = id.to_string();
        self.run_blocking(move |conn| {
            conn.execute(
                "UPDATE scrape_tasks SET status = 'partial', completed_at = datetime('now') WHERE id = ?1",
                params![id],
            )?;
            Ok(())
        }).await
    }

    /// 重置任务（清除所有进度）- 异步版本
    pub async fn reset_task(&self, id: &str) -> AppResult<()> {
        let id = id.to_string();
        self.run_blocking(move |conn| {
            conn.execute(
                "UPDATE scrape_tasks SET status = 'waiting', progress = 0, started_at = NULL, completed_at = NULL WHERE id = ?1",
                params![id],
            )?;
            Ok(())
        }).await
    }

    pub fn get_waiting_scrape_task_id(conn: &Connection) -> Result<Option<String>> {
        conn.query_row(
            "SELECT id FROM scrape_tasks WHERE status = 'waiting' ORDER BY created_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
    }

    pub fn delete_scrape_task_by_id(conn: &Connection, task_id: &str) -> Result<()> {
        conn.execute("DELETE FROM scrape_tasks WHERE id = ?", [task_id])?;
        Ok(())
    }
}
