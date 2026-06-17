//! 反爬工具箱配置
//!
//! 配置随 `settings.json` 的 `scrape.antiBlock` 子树持久化。
//! 为避免与 AppHandle 耦合（与 `utils::proxy` 同样的取舍），这里直接读取
//! settings.json 的原始 JSON，按字段解析，缺失项回退默认值。

use std::path::Path;

/// 反爬工具箱运行配置
#[derive(Debug, Clone)]
pub struct AntiBlockConfig {
    /// 总开关：关闭后引擎退化为「系统代理直连 + 不限速 + 不重试」，与历史行为一致
    pub enabled: bool,
    /// 请求间隔限速开关
    pub rate_limit_enabled: bool,
    /// 同一 host 两次请求的最小间隔（毫秒）
    pub min_interval_ms: u64,
    /// 同一 host 两次请求的最大间隔（毫秒），实际间隔在 [min, max] 内随机
    pub max_interval_ms: u64,
    /// 失败后的最大重试次数（不含首次请求）
    pub max_retries: u32,
    /// UA / 指纹轮换开关（在近期 Chrome 指纹间轮换）
    pub ua_rotation_enabled: bool,
    /// 多镜像域名轮换开关
    pub mirror_rotation_enabled: bool,
    /// 成功率加权代理池开关
    pub proxy_pool_enabled: bool,
    /// 代理 URL 列表（如 `http://127.0.0.1:7890`、`socks5://...`）
    pub proxies: Vec<String>,
}

impl Default for AntiBlockConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            rate_limit_enabled: true,
            min_interval_ms: 800,
            max_interval_ms: 2000,
            max_retries: 2,
            ua_rotation_enabled: true,
            mirror_rotation_enabled: true,
            proxy_pool_enabled: false,
            proxies: Vec::new(),
        }
    }
}

impl AntiBlockConfig {
    /// 从配置目录的 settings.json 读取配置；文件缺失或解析失败时返回默认值。
    pub fn load(config_dir: &Path) -> Self {
        let path = config_dir.join("settings.json");
        let Ok(content) = std::fs::read_to_string(&path) else {
            return Self::default();
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
            return Self::default();
        };

        let node = &value["scrape"]["antiBlock"];
        if !node.is_object() {
            return Self::default();
        }

        let d = Self::default();
        Self {
            enabled: node["enabled"].as_bool().unwrap_or(d.enabled),
            rate_limit_enabled: node["rateLimitEnabled"].as_bool().unwrap_or(d.rate_limit_enabled),
            min_interval_ms: node["minIntervalMs"].as_u64().unwrap_or(d.min_interval_ms),
            max_interval_ms: node["maxIntervalMs"].as_u64().unwrap_or(d.max_interval_ms),
            max_retries: node["maxRetries"]
                .as_u64()
                .map(|v| v as u32)
                .unwrap_or(d.max_retries),
            ua_rotation_enabled: node["uaRotationEnabled"]
                .as_bool()
                .unwrap_or(d.ua_rotation_enabled),
            mirror_rotation_enabled: node["mirrorRotationEnabled"]
                .as_bool()
                .unwrap_or(d.mirror_rotation_enabled),
            proxy_pool_enabled: node["proxyPoolEnabled"]
                .as_bool()
                .unwrap_or(d.proxy_pool_enabled),
            proxies: node["proxies"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or(d.proxies),
        }
        .normalized()
    }

    /// 约束取值范围，保证 min<=max、退避次数与间隔不会失控。
    fn normalized(mut self) -> Self {
        if self.min_interval_ms > self.max_interval_ms {
            std::mem::swap(&mut self.min_interval_ms, &mut self.max_interval_ms);
        }
        self.max_interval_ms = self.max_interval_ms.min(60_000);
        self.min_interval_ms = self.min_interval_ms.min(self.max_interval_ms);
        self.max_retries = self.max_retries.min(5);
        self
    }
}
