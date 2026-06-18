//! 数据库写入器 - 负责将刮削的视频元数据写入数据库

use crate::db::Database;
use crate::resource_scrape::types::ScrapeMetadata;
use std::path::PathBuf;

fn resolve_scraped_duration(existing_duration: Option<i32>, scraped_duration_minutes: Option<i64>) -> Option<i32> {
    if existing_duration.unwrap_or(0) == 0 {
        scraped_duration_minutes.map(|duration| (duration * 60) as i32)
    } else {
        existing_duration
    }
}

/// 把刮削结果的片商/女优名记入跨语言别名原始证据并投影（best-effort，失败不阻断保存）。
/// 记录全部名字（含多人作的全部女优）；是否归并由 `apply_designation` 按证据统一裁决
/// （片商总是归并，女优仅单人作归并）。
fn record_designation_aliases(
    conn: &rusqlite::Connection,
    designation: &str,
    studios: &[&str],
    actors: &[String],
) {
    use crate::entity_alias::{apply_designation, record_evidence, ENTITY_ACTOR, ENTITY_STUDIO};
    if designation.is_empty() {
        return;
    }
    for studio in studios {
        let _ = record_evidence(conn, designation, ENTITY_STUDIO, studio, "scrape");
    }
    for actor in actors {
        let _ = record_evidence(conn, designation, ENTITY_ACTOR, actor, "scrape");
    }
    if let Err(e) = apply_designation(conn, designation) {
        log::warn!(
            "[entity_alias] event=apply_failed designation={} error={}",
            designation,
            e
        );
    }
}

/// 读取本地封面文件尺寸（仅读图头，开销小）。路径为空或读取失败时返回 (None, None)。
fn read_cover_dimensions(path: &str) -> (Option<i32>, Option<i32>) {
    if path.trim().is_empty() {
        return (None, None);
    }
    match image::image_dimensions(path) {
        Ok((w, h)) if w > 0 && h > 0 => (Some(w as i32), Some(h as i32)),
        _ => (None, None),
    }
}

/// 数据库写入器 - 负责将刮削的视频元数据写入数据库
///
/// 提供的功能：
/// - 更新视频元数据（标题、番号、发行日期等）
/// - 保存演员到关联表
/// - 保存标签到关联表
/// - 更新刮削状态和时间戳
pub struct DatabaseWriter {
    db_path: PathBuf,
}

impl DatabaseWriter {
    /// 创建新的数据库写入器实例
    pub fn new(db: &Database) -> Self {
        Self {
            db_path: db.get_database_path().clone(),
        }
    }

    /// 更新视频元数据
    ///
    /// 更新内容包括：标题、制作商、导演、发行日期、时长、评分、封面图、番号等
    ///
    /// # 参数
    /// * `video_id` - 视频ID
    /// * `metadata` - 刮削得到的元数据
    /// * `local_cover_image` - 本地封面图路径
    pub async fn update_video_metadata(
        &self,
        video_id: String,
        metadata: ScrapeMetadata,
        local_cover_image: String,
    ) -> Result<(), String> {
        let db_path = self.db_path.clone();

        tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(&db_path)
                .map_err(|e| format!("Failed to open database: {}", e))?;

            // 检查数据库中现有的时长
            let existing_duration: Option<i32> =
                Database::get_video_duration(&conn, &video_id).map_err(|e| e.to_string())?;

            // 如果数据库时长为 0 或 NULL，则使用刮削得到的时长（刮削器返回分钟，数据库存储秒）
            let new_duration = resolve_scraped_duration(existing_duration, metadata.duration);
            // 读取本地封面尺寸（仅读图头，开销小），写入库用于瀑布流等高画廊布局/虚拟化
            let (cover_width, cover_height) = read_cover_dimensions(&local_cover_image);
            let update = crate::db::VideoScrapeUpdateData {
                title: &metadata.title,
                original_title: metadata.original_title.as_deref(),
                studio: Some(metadata.studio.as_str()),
                director: Some(metadata.director.as_str()),
                premiered: Some(metadata.premiered.as_str()),
                duration: new_duration,
                rating: metadata.score,
                poster: &local_cover_image,
                local_id: Some(metadata.local_id.as_str()),
                cover_width,
                cover_height,
                is_uncensored: metadata.is_uncensored
                    || crate::utils::designation_recognizer::is_uncensored_designation(
                        &metadata.local_id,
                    ),
            };

            Database::update_video_scrape_info(&conn, &video_id, &update).map_err(|e| e.to_string())?;

            Ok(())
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?
    }

    /// 保存演员到关联表
    ///
    /// 操作流程：
    /// 1. 删除该视频现有的演员关联
    /// 2. 为每个演员名创建或获取演员ID
    /// 3. 插入新的关联记录（按顺序设置优先级）
    pub async fn save_actors(&self, video_id: String, actors: Vec<String>) -> Result<(), String> {
        if actors.is_empty() {
            return Ok(());
        }

        let db_path = self.db_path.clone();

        tokio::task::spawn_blocking(move || {
            let mut conn = rusqlite::Connection::open(&db_path)
                .map_err(|e| format!("Failed to open database: {}", e))?;
            let transaction = conn.transaction().map_err(|e| e.to_string())?;

            Database::clear_video_actors(&transaction, &video_id).map_err(|e| e.to_string())?;

            for (idx, actor_name) in actors.iter().enumerate() {
                let actor_id = Database::get_or_create_actor(&transaction, actor_name)
                    .map_err(|e| e.to_string())?;
                Database::add_video_actor(&transaction, &video_id, actor_id, idx)
                    .map_err(|e| e.to_string())?;
            }

            transaction.commit().map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?
    }
    /// 保存标签到关联表
    ///
    /// 操作流程：
    /// 1. 删除该视频现有的标签关联
    /// 2. 为每个标签名创建或获取标签ID
    /// 3. 插入新的关联记录
    pub async fn save_tags(&self, video_id: String, tags: Vec<String>) -> Result<(), String> {
        if tags.is_empty() {
            return Ok(());
        }

        let db_path = self.db_path.clone();

        tokio::task::spawn_blocking(move || {
            let mut conn = rusqlite::Connection::open(&db_path)
                .map_err(|e| format!("Failed to open database: {}", e))?;
            let transaction = conn.transaction().map_err(|e| e.to_string())?;

            Database::clear_video_tags(&transaction, &video_id).map_err(|e| e.to_string())?;

            for tag_name in &tags {
                let tag_id = Database::get_or_create_tag(&transaction, tag_name)
                    .map_err(|e| e.to_string())?;
                Database::add_video_tag(&transaction, &video_id, tag_id)
                    .map_err(|e| e.to_string())?;
            }

            transaction.commit().map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?
    }

    pub async fn save_genres(&self, video_id: String, genres: Vec<String>) -> Result<(), String> {
        if genres.is_empty() {
            return Ok(());
        }

        let db_path = self.db_path.clone();

        tokio::task::spawn_blocking(move || {
            let mut conn = rusqlite::Connection::open(&db_path)
                .map_err(|e| format!("Failed to open database: {}", e))?;
            let transaction = conn.transaction().map_err(|e| e.to_string())?;

            Database::clear_video_genres(&transaction, &video_id).map_err(|e| e.to_string())?;

            for genre_name in &genres {
                let genre_id = Database::get_or_create_genre(&transaction, genre_name)
                    .map_err(|e| e.to_string())?;
                Database::add_video_genre(&transaction, &video_id, genre_id)
                    .map_err(|e| e.to_string())?;
            }

            transaction.commit().map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?
    }

    /// 将所有刮削数据（元数据 + 演员 + 标签 + 分类）原子地写入数据库。
    ///
    /// 全部操作在单连接、单事务内完成，任一步失败整体回滚，
    /// 避免出现「元数据已更新但演员被清空未重插」之类的中间不一致状态。
    pub async fn write_all(
        &self,
        video_id: String,
        metadata: ScrapeMetadata,
        local_cover_image: String,
    ) -> Result<(), String> {
        let db_path = self.db_path.clone();

        tokio::task::spawn_blocking(move || {
            let mut conn = rusqlite::Connection::open(&db_path)
                .map_err(|e| format!("Failed to open database: {}", e))?;
            conn.busy_timeout(std::time::Duration::from_secs(5))
                .map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;

            // 1. 视频元数据
            let existing_duration: Option<i32> =
                Database::get_video_duration(&tx, &video_id).map_err(|e| e.to_string())?;
            let new_duration = resolve_scraped_duration(existing_duration, metadata.duration);
            // 读取本地封面尺寸（仅读图头，开销小），写入库用于瀑布流等高画廊布局/虚拟化
            let (cover_width, cover_height) = read_cover_dimensions(&local_cover_image);
            let update = crate::db::VideoScrapeUpdateData {
                title: &metadata.title,
                original_title: metadata.original_title.as_deref(),
                studio: Some(metadata.studio.as_str()),
                director: Some(metadata.director.as_str()),
                premiered: Some(metadata.premiered.as_str()),
                duration: new_duration,
                rating: metadata.score,
                poster: &local_cover_image,
                local_id: Some(metadata.local_id.as_str()),
                cover_width,
                cover_height,
                is_uncensored: metadata.is_uncensored
                    || crate::utils::designation_recognizer::is_uncensored_designation(
                        &metadata.local_id,
                    ),
            };
            Database::update_video_scrape_info(&tx, &video_id, &update)
                .map_err(|e| e.to_string())?;

            // 2. 演员
            Database::clear_video_actors(&tx, &video_id).map_err(|e| e.to_string())?;
            for (idx, actor_name) in metadata.actors.iter().enumerate() {
                let actor_id =
                    Database::get_or_create_actor(&tx, actor_name).map_err(|e| e.to_string())?;
                Database::add_video_actor(&tx, &video_id, actor_id, idx)
                    .map_err(|e| e.to_string())?;
            }

            // 3. 标签
            Database::clear_video_tags(&tx, &video_id).map_err(|e| e.to_string())?;
            for tag_name in &metadata.tags {
                let tag_id =
                    Database::get_or_create_tag(&tx, tag_name).map_err(|e| e.to_string())?;
                Database::add_video_tag(&tx, &video_id, tag_id).map_err(|e| e.to_string())?;
            }

            // 4. 分类
            Database::clear_video_genres(&tx, &video_id).map_err(|e| e.to_string())?;
            for genre_name in &metadata.genres {
                let genre_id =
                    Database::get_or_create_genre(&tx, genre_name).map_err(|e| e.to_string())?;
                Database::add_video_genre(&tx, &video_id, genre_id).map_err(|e| e.to_string())?;
            }

            // 5. 跨语言别名：同番号关联（片商每片唯一→总是；女优仅单人作才归并，避免误并合演者）。
            //    best-effort：别名失败不应阻断刮削保存。
            record_designation_aliases(
                &tx,
                metadata.local_id.trim(),
                &[metadata.studio.as_str(), metadata.maker.as_str()],
                &metadata.actors,
            );

            tx.commit().map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_scraped_duration;

    #[test]
    fn resolve_scraped_duration_should_keep_existing_real_duration() {
        assert_eq!(resolve_scraped_duration(Some(5_400), Some(120)), Some(5_400));
    }

    #[test]
    fn resolve_scraped_duration_should_fill_when_existing_is_empty() {
        assert_eq!(resolve_scraped_duration(None, Some(120)), Some(7_200));
        assert_eq!(resolve_scraped_duration(Some(0), Some(120)), Some(7_200));
    }
}
