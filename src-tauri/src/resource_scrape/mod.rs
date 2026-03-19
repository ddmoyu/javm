//! 资源刮削模块
//!
//! 合并原有的"刮削中心"和"资源搜索"功能为统一模块。
//!
//! 模块结构：
//! - `types` - 搜索结果数据类型
//! - `client` - 共享 HTTP 客户端
//! - `database_writer` - 数据库写入器
//! - `detector` - 已刮削视频检测器

pub mod types;
pub mod client;
pub mod database_writer;
pub mod detector;
pub mod sources;
pub mod fetcher;
pub mod commands;
pub mod queue_manager;
pub mod video_finder;
pub mod cover_capture;
pub mod webview_support;
