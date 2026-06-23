use super::*;
use rusqlite::{params, Connection, Result};

impl Database {
    pub fn check_directory_exists(conn: &Connection, path: &str) -> Result<bool> {
        conn.query_row(
            "SELECT COUNT(*) > 0 FROM directories WHERE path = ?",
            params![path],
            |row| row.get(0),
        )
    }

    pub fn get_directory_video_count(
        conn: &Connection,
        path: &str,
        normalized_path: &str,
        path_pattern: &str,
    ) -> Result<i64> {
        conn.query_row(
            "SELECT COUNT(*) FROM videos WHERE
                dir_path = ? OR
                dir_path = ? OR
                REPLACE(dir_path, '\\', '/') LIKE ? OR
                REPLACE(dir_path, '\\', '/') = ?",
            params![path, normalized_path, path_pattern, normalized_path],
            |row| row.get(0),
        )
    }

    /// 规范化路径并统计目录下视频数量（封装路径规范化逻辑）
    pub fn count_videos_in_directory(conn: &Connection, path: &str) -> Result<i64> {
        let (normalized, pattern) = Self::normalize_dir_path(path);
        Self::get_directory_video_count(conn, path, &normalized, &pattern)
    }

    /// 删除指定目录及其子目录下的所有视频记录
    pub fn delete_videos_in_directory(conn: &Connection, path: &str) -> Result<usize> {
        let (normalized, pattern) = Self::normalize_dir_path(path);
        conn.execute(
            "DELETE FROM videos WHERE
                dir_path = ? OR
                dir_path = ? OR
                REPLACE(dir_path, '\\', '/') LIKE ? OR
                REPLACE(dir_path, '\\', '/') = ?",
            params![path, &normalized, &pattern, &normalized],
        )
    }

    /// 规范化目录路径：统一分隔符 + 构建 LIKE 模式
    fn normalize_dir_path(path: &str) -> (String, String) {
        let normalized = std::path::Path::new(path)
            .to_string_lossy()
            .replace('\\', "/");
        let pattern = if normalized.ends_with('/') {
            format!("{}%", normalized)
        } else {
            format!("{}/%", normalized)
        };
        (normalized, pattern)
    }

    /// 加载所有「目录管理」目录的规范化前缀（统一为 `/` 分隔、去除结尾 `/`）。
    pub fn managed_directory_prefixes(conn: &Connection) -> Result<Vec<String>> {
        let mut stmt = conn.prepare("SELECT path FROM directories")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows
            .filter_map(|r| r.ok())
            .map(|p| p.replace('\\', "/").trim_end_matches('/').to_string())
            .filter(|p| !p.is_empty())
            .collect())
    }

    /// 判断视频文件路径是否位于任一「目录管理」目录（或其子目录）下。
    /// Windows 下路径大小写不敏感。
    pub fn is_path_under_managed_directory(prefixes: &[String], video_path: &str) -> bool {
        let normalized = video_path.replace('\\', "/");
        prefixes
            .iter()
            .any(|prefix| Self::path_is_inside(&normalized, prefix))
    }

    /// 判断 `path` 是否在目录 `dir` 之内（dir 为不带结尾 `/` 的规范化路径）。
    fn path_is_inside(path: &str, dir: &str) -> bool {
        let needle = format!("{}/", dir);
        #[cfg(windows)]
        {
            path.to_ascii_lowercase()
                .starts_with(&needle.to_ascii_lowercase())
        }
        #[cfg(not(windows))]
        {
            path.starts_with(&needle)
        }
    }

    /// 判断单个视频文件是否位于「目录管理」内（便捷封装）。
    pub fn is_video_under_managed_directory(conn: &Connection, video_path: &str) -> Result<bool> {
        let prefixes = Self::managed_directory_prefixes(conn)?;
        Ok(Self::is_path_under_managed_directory(&prefixes, video_path))
    }

    pub fn update_directory_video_count(conn: &Connection, path: &str, count: i64) -> Result<()> {
        conn.execute(
            "UPDATE directories SET video_count = ?, updated_at = CURRENT_TIMESTAMP WHERE path = ?",
            params![count, path],
        )?;
        Ok(())
    }
}
