//! 视频文件扫描模块
//!
//! 包含文件扫描工具、扫描服务和 Tauri 命令。

pub mod commands;
pub mod file_scanner;
pub mod service;

// 重新导出常用类型
pub use service::{ScannerService, ScanProgress, ScanSummary};
