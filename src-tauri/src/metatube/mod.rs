//! MetaTube sidecar 集成
//!
//! 把 MetaTube Server（Go 静态二进制）作为本地长驻 HTTP sidecar 随应用启动，新增一个**聚合刮削源**，
//! 纳入现有多源并发搜索 + 评分排序。二进制随 GitHub Actions 构建按平台打包进 `bin/`。
//!
//! - [`supervisor`]：进程生命周期（拉起/健康检查/崩溃重启/放弃回退/随应用关闭）
//! - [`client`]：访问本地 sidecar 的 HTTP 客户端 + 字段映射
//! - [`binary`]：二进制多候选路径解析
//! - [`types`]：配置 / 状态 / API 数据类型
//! - [`commands`]：状态查询 / 重启
//!
//! 设计为**可回退**：sidecar 不可用（未打包/启动失败/放弃）时，该源被跳过，现有自研源不受影响。

pub mod binary;
pub mod client;
pub mod commands;
pub mod installer;
pub mod supervisor;
pub mod types;

pub use supervisor::MetaTubeManager;
pub use types::{MetaTubeConfig, MetaTubeStatus};

/// MetaTube 聚合源在结果中的来源标识（UI 以「数据源 N」呈现，不显真实站点名）。
pub const SOURCE_ID: &str = "metatube";
