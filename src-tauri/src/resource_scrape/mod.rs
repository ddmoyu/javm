//! 资源刮削模块
//!
//! 合并原有的"刮削中心"和"资源搜索"功能为统一模块。
//!
//! 模块结构：
//! - `types` - 搜索结果数据类型
//! - `fingerprint_client` - wreq TLS 指纹 HTTP 客户端
//! - `database_writer` - 数据库写入器
//! - `detector` - 已刮削视频检测器

pub mod types;
pub mod anti_block;
pub mod fusion;
pub mod database_writer;
pub mod detector;
pub mod sources;
pub mod actor_provider;
pub mod magnet;
pub mod cf_detection;
pub mod fetcher;
pub mod commands;
pub mod javbus_genres;
pub mod queue_manager;
pub mod video_finder;
pub mod fingerprint_client;
pub mod webview_support;
/// 视频链接探测框架，仅 debug 构建编译，用于 AI/开发者批量筛选候选站点
#[cfg(debug_assertions)]
pub mod link_probe;
