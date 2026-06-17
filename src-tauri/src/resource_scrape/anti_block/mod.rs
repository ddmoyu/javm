//! 反爬工具箱
//!
//! 在现有 wreq + TLS 指纹之上，统一补齐：请求限速、分级退避重试、UA/指纹轮换、
//! 成功率加权代理池、多镜像域名轮换 —— 服务全部刮削与下载源的页面抓取。
//!
//! 设计为进程级单例（与 `utils::proxy` 一致），启动时 `init`、设置变更时 `refresh`。
//! 取页面统一走 [`engine().fetch_text`]；图片/HLS 等非刮削请求复用
//! [`engine().default_client`]（行为同历史 `shared_client`）。

pub mod config;
pub mod emulation;
pub mod engine;
pub mod mirror;
pub mod proxy_pool;
pub mod rate_limiter;

use std::path::Path;
use std::sync::LazyLock;

use engine::AntiBlockEngine;

static ENGINE: LazyLock<AntiBlockEngine> = LazyLock::new(AntiBlockEngine::new);

/// 全局反爬引擎单例
pub fn engine() -> &'static AntiBlockEngine {
    &ENGINE
}

/// 应用启动时初始化：加载配置 + 设置镜像缓存路径。
pub fn init(config_dir: &Path) {
    ENGINE.set_mirror_cache_path(config_dir.join("anti_block_mirrors.json"));
    ENGINE.apply_config(config::AntiBlockConfig::load(config_dir));
}

/// 设置变更后刷新配置（代理列表/限速/重试/镜像开关等）。
pub fn refresh(config_dir: &Path) {
    ENGINE.apply_config(config::AntiBlockConfig::load(config_dir));
}
