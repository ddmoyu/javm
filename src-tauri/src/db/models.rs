use serde::{Deserialize, Serialize};

// ==================== 数据模型 ====================

/// 刮削任务状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ScrapeStatus {
    Waiting,
    Running,
    Completed,
    Partial,
    Failed,
}

impl ScrapeStatus {
    pub fn as_str(&self) -> &str {
        match self {
            ScrapeStatus::Waiting => "waiting",
            ScrapeStatus::Running => "running",
            ScrapeStatus::Completed => "completed",
            ScrapeStatus::Partial => "partial",
            ScrapeStatus::Failed => "failed",
        }
    }

    pub fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "waiting" => Ok(ScrapeStatus::Waiting),
            "running" => Ok(ScrapeStatus::Running),
            "completed" => Ok(ScrapeStatus::Completed),
            "partial" => Ok(ScrapeStatus::Partial),
            "failed" => Ok(ScrapeStatus::Failed),
            _ => Err(format!("Invalid scrape status: {}", s)),
        }
    }
}

/// 刮削任务模型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrapeTask {
    pub id: String,
    pub path: String,
    pub status: ScrapeStatus,
    pub progress: i32,
    pub created_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

pub struct VideoUpdateData<'a> {
    pub path_str: &'a str,
    pub title: &'a str,
    pub studio: Option<&'a str>,
    pub premiered: Option<&'a str>,
    pub director: Option<&'a str>,
    pub file_size: u64,
    pub fast_hash: &'a str,
    pub original_title: &'a str,
    pub duration: Option<i32>,
    pub resolution: Option<String>,
    pub local_id: Option<&'a str>,
    pub rating: Option<f64>,
    pub poster: Option<String>,
    pub thumb: Option<String>,
    pub fanart: Option<String>,
    pub file_mtime: Option<i64>,
    pub nfo_mtime: Option<i64>,
    pub poster_mtime: Option<i64>,
    pub thumb_mtime: Option<i64>,
    pub fanart_mtime: Option<i64>,
    pub scan_status: i32,
    pub now: &'a str,
}

pub struct VideoInsertData<'a> {
    pub id: &'a str,
    pub local_id: Option<&'a str>,
    pub path_str: &'a str,
    pub parent_str: &'a str,
    pub title: &'a str,
    pub original_title: &'a str,
    pub studio: Option<&'a str>,
    pub premiered: Option<&'a str>,
    pub director: Option<&'a str>,
    pub file_size: u64,
    pub fast_hash: &'a str,
    pub created_at: &'a str,
    pub scan_status: i32,
    pub duration: Option<i32>,
    pub resolution: Option<String>,
    pub rating: Option<f64>,
    pub poster: Option<String>,
    pub thumb: Option<String>,
    pub fanart: Option<String>,
    pub file_mtime: Option<i64>,
    pub nfo_mtime: Option<i64>,
    pub poster_mtime: Option<i64>,
    pub thumb_mtime: Option<i64>,
    pub fanart_mtime: Option<i64>,
    pub cover_width: Option<i32>,
    pub cover_height: Option<i32>,
}

pub struct ExistingVideoScanInfo {
    pub id: String,
    pub title: String,
    pub original_title: String,
    pub studio: Option<String>,
    pub premiered: Option<String>,
    pub director: Option<String>,
    pub local_id: Option<String>,
    pub rating: Option<f64>,
    pub file_size: u64,
    pub fast_hash: Option<String>,
    pub duration: Option<i32>,
    pub resolution: Option<String>,
    pub file_mtime: Option<i64>,
    pub nfo_mtime: Option<i64>,
    pub poster_mtime: Option<i64>,
    pub thumb_mtime: Option<i64>,
    pub fanart_mtime: Option<i64>,
}

pub struct VideoScrapeUpdateData<'a> {
    pub title: &'a str,
    pub original_title: Option<&'a str>,
    pub studio: Option<&'a str>,
    pub director: Option<&'a str>,
    pub premiered: Option<&'a str>,
    pub duration: Option<i32>,
    pub rating: Option<f64>,
    pub poster: &'a str,
    pub local_id: Option<&'a str>,
    pub cover_width: Option<i32>,
    pub cover_height: Option<i32>,
}

/// 合法的元数据表名枚举，防止 SQL 注入
#[derive(Clone, Copy)]
pub enum MetadataTable {
    Actors,
    Tags,
    Genres,
}

impl MetadataTable {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Actors => "actors",
            Self::Tags => "tags",
            Self::Genres => "genres",
        }
    }
}
