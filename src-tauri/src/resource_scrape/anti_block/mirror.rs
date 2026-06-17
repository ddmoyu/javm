//! 多镜像域名轮换 + 当前可用域名缓存
//!
//! 部分站点有多个镜像域名（主域名被墙/改名时其余镜像仍可用）。本模块为这类站点维护
//! 一份按优先级排列的镜像 host 列表，并缓存「当前可用域名」到本地文件：
//! - 正常时始终使用缓存的当前域名（默认主域名），不产生额外请求；
//! - 当前域名连续抓取失败时，由引擎调用 `advance` 切到下一个镜像并持久化，
//!   下次直接命中已缓存的可用域名。
//!
//! 仅改写请求 URL 的 host（保留协议/路径/查询），解析逻辑不受影响。
//! 只有列出 ≥2 个 host 的站点才会发生改写；未列出的站点 URL 原样透传。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// 各站点镜像 host 列表（首项为主域名，与对应 `Source::build_url` 的域名一致）。
///
/// **当前刻意为空**：镜像域名必须经过验证才能放入——未经验证的死域名会在主域名
/// 偶发失败时把请求永久切到坏域名（曾因硬塞 javbus 镜像导致其整源失效）。轮换机制
/// 已就绪，待确认稳定的镜像域名后，按 `(site_id, &["主域名", "镜像1", ...])` 填入即可。
/// 列表 <2 个 host 的站点不会发生任何改写。
const MIRROR_TABLE: &[(&str, &[&str])] = &[];

/// 查询站点的镜像 host 列表（无镜像返回空）
fn mirror_hosts(site_id: &str) -> &'static [&'static str] {
    let key = site_id.trim().to_lowercase();
    MIRROR_TABLE
        .iter()
        .find(|(id, _)| key == *id)
        .map(|(_, hosts)| *hosts)
        .unwrap_or(&[])
}

pub struct MirrorRegistry {
    /// site_id -> 当前使用的 host 索引
    active: Mutex<HashMap<String, usize>>,
    /// 缓存文件路径（init 时设置；未设置则仅内存生效）
    cache_path: Mutex<Option<PathBuf>>,
}

impl MirrorRegistry {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(HashMap::new()),
            cache_path: Mutex::new(None),
        }
    }

    /// 设置缓存文件路径并立即加载已持久化的当前域名。
    pub fn set_cache_path(&self, path: PathBuf) {
        let loaded = std::fs::read_to_string(&path)
            .ok()
            .and_then(|c| serde_json::from_str::<HashMap<String, usize>>(&c).ok())
            .unwrap_or_default();
        *lock(&self.active) = loaded;
        *lock(&self.cache_path) = Some(path);
    }

    /// 按当前可用镜像改写 URL 的 host。`enabled=false` 或站点无镜像时原样返回。
    pub fn rewrite(&self, url: &str, site_id: &str, enabled: bool) -> String {
        if !enabled {
            return url.to_string();
        }
        let hosts = mirror_hosts(site_id);
        if hosts.len() < 2 {
            return url.to_string();
        }
        let idx = lock(&self.active)
            .get(&normalize(site_id))
            .copied()
            .unwrap_or(0)
            .min(hosts.len() - 1);
        if idx == 0 {
            // 主域名：与 build_url 一致，无需改写
            return url.to_string();
        }
        rewrite_host(url, hosts[idx])
    }

    /// 当前域名失效：切换到下一个镜像并持久化。无镜像的站点忽略。
    pub fn advance(&self, site_id: &str) {
        let hosts = mirror_hosts(site_id);
        if hosts.len() < 2 {
            return;
        }
        let key = normalize(site_id);
        let snapshot = {
            let mut guard = lock(&self.active);
            let cur = guard.get(&key).copied().unwrap_or(0);
            let next = (cur + 1) % hosts.len();
            guard.insert(key.clone(), next);
            log::info!(
                "[anti_block] event=mirror_switch site={} from={} to={}",
                site_id,
                hosts[cur.min(hosts.len() - 1)],
                hosts[next]
            );
            guard.clone()
        };
        self.persist(&snapshot);
    }

    fn persist(&self, snapshot: &HashMap<String, usize>) {
        let path = match lock(&self.cache_path).clone() {
            Some(p) => p,
            None => return,
        };
        if let Ok(content) = serde_json::to_string_pretty(snapshot) {
            if let Err(e) = std::fs::write(&path, content) {
                log::warn!("[anti_block] event=mirror_cache_write_failed error={}", e);
            }
        }
    }
}

/// 把 URL 的 host 换成 `host`，保留协议/路径/查询；解析失败或换 host 失败则原样返回。
fn rewrite_host(url: &str, host: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut parsed) => {
            if parsed.set_host(Some(host)).is_ok() {
                parsed.to_string()
            } else {
                url.to_string()
            }
        }
        Err(_) => url.to_string(),
    }
}

fn normalize(site_id: &str) -> String {
    site_id.trim().to_lowercase()
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_disabled_returns_original() {
        let reg = MirrorRegistry::new();
        let url = "https://www.javbus.com/SSIS-001";
        assert_eq!(reg.rewrite(url, "javbus", false), url);
    }

    #[test]
    fn rewrite_returns_original_without_mirrors() {
        // 镜像表为空：任何站点都不改写，advance 亦为无操作
        let reg = MirrorRegistry::new();
        let url = "https://www.javbus.com/SSIS-001?x=1";
        assert_eq!(reg.rewrite(url, "javbus", true), url);
        reg.advance("javbus");
        assert_eq!(reg.rewrite(url, "javbus", true), url);
    }

    #[test]
    fn unknown_site_is_passthrough() {
        let reg = MirrorRegistry::new();
        let url = "https://example.com/x";
        assert_eq!(reg.rewrite(url, "unknown", true), url);
        reg.advance("unknown"); // 不应 panic
    }

    #[test]
    fn rewrite_host_swaps_host_preserving_path() {
        // 验证 host 改写逻辑本身（机制就绪，待镜像表填入后启用）
        let out = rewrite_host("https://www.javbus.com/SSIS-001?x=1", "mirror.example.com");
        assert_eq!(out, "https://mirror.example.com/SSIS-001?x=1");
    }
}
