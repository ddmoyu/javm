//! 反爬工具箱引擎
//!
//! 把限速、分级退避重试、UA/指纹轮换、成功率加权代理池、镜像轮换组合为统一的取页面
//! 入口。对外保持「给 URL 拿 HTML」的简单接口，内部完成全部反爬动作。
//!
//! 与自适应并发（`utils::adaptive_concurrency`）正交：并发控制「同时几个请求」，
//! 本引擎控制「单个请求的节奏与韧性」。

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, RwLock};
use std::path::PathBuf;
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use wreq_util::Emulation;

use super::config::AntiBlockConfig;
use super::emulation::{DEFAULT_EMULATION, EMULATION_POOL};
use super::mirror::MirrorRegistry;
use super::proxy_pool::ProxyPool;
use super::rate_limiter::RateLimiter;
use crate::resource_scrape::fingerprint_client;

/// client 缓存键：(代理 URL, 指纹)。代理为 `None` 表示走系统/自定义代理。
type ClientKey = (Option<String>, Emulation);

pub struct AntiBlockEngine {
    config: RwLock<AntiBlockConfig>,
    proxy_pool: ProxyPool,
    rate_limiter: RateLimiter,
    mirrors: MirrorRegistry,
    /// 复用 client：构建 wreq 指纹 client 较贵，按 (代理, 指纹) 缓存复用
    clients: Mutex<HashMap<ClientKey, wreq::Client>>,
    /// UA/指纹轮换计数器
    ua_counter: AtomicUsize,
}

impl AntiBlockEngine {
    pub fn new() -> Self {
        Self {
            config: RwLock::new(AntiBlockConfig::default()),
            proxy_pool: ProxyPool::new(),
            rate_limiter: RateLimiter::new(),
            mirrors: MirrorRegistry::new(),
            clients: Mutex::new(HashMap::new()),
            ua_counter: AtomicUsize::new(0),
        }
    }

    /// 应用新配置（启动 init 与设置变更 refresh 时调用）。
    pub fn apply_config(&self, cfg: AntiBlockConfig) {
        self.proxy_pool.set_proxies(&cfg.proxies);
        *write(&self.config) = cfg;
        // 代理列表/参数可能变化，旧 client 可能已失效，清空让其按新配置重建
        lock(&self.clients).clear();
    }

    pub fn set_mirror_cache_path(&self, path: PathBuf) {
        self.mirrors.set_cache_path(path);
    }

    fn config(&self) -> AntiBlockConfig {
        read(&self.config).clone()
    }

    /// 获取或构建 (代理, 指纹) 对应的复用 client。
    fn client_for(&self, proxy: Option<&str>, emulation: Emulation) -> Result<wreq::Client, String> {
        let key: ClientKey = (proxy.map(|s| s.to_string()), emulation);
        if let Some(client) = lock(&self.clients).get(&key) {
            return Ok(client.clone());
        }

        let proxy_url = match proxy {
            Some(p) => Some(
                url::Url::parse(p).map_err(|e| format!("代理地址无效 '{}': {}", p, e))?,
            ),
            None => crate::utils::proxy::get_proxy_url(),
        };
        let client = fingerprint_client::build_client(emulation, proxy_url)?;
        lock(&self.clients).insert(key, client.clone());
        Ok(client)
    }

    /// 进程级默认 client（系统/自定义代理 + 默认指纹），供图片/HLS 等非刮削请求复用。
    /// 行为与历史 `shared_client` 一致：代理池仅作用于带重试的页面抓取，不影响图片直链。
    pub fn default_client(&self) -> Result<wreq::Client, String> {
        self.client_for(None, DEFAULT_EMULATION)
    }

    /// 代理池启用时挑选一个代理；否则返回 `None`（→ 走系统/自定义代理）。
    fn select_proxy(&self, cfg: &AntiBlockConfig) -> Option<String> {
        if cfg.enabled && cfg.proxy_pool_enabled && !self.proxy_pool.is_empty() {
            self.proxy_pool.select()
        } else {
            None
        }
    }

    /// 选取本次请求使用的指纹。
    fn next_emulation(&self, cfg: &AntiBlockConfig) -> Emulation {
        if cfg.enabled && cfg.ua_rotation_enabled {
            let n = self.ua_counter.fetch_add(1, Ordering::Relaxed);
            EMULATION_POOL[n % EMULATION_POOL.len()]
        } else {
            DEFAULT_EMULATION
        }
    }

    /// 反爬取页面：限速 + 镜像 + 代理池 + 指纹轮换 + 分级退避重试。
    ///
    /// 返回的成功内容与错误字符串格式（如 `HTTP 404 Not Found`）与历史
    /// `fingerprint_client::fetch_html` 保持一致，上层的 CF 检测/WebView 回退逻辑无需改动。
    ///
    /// `cancel` 在限速等待与退避重试期间生效：搜索被取消/取代时立即返回，不再空等。
    pub async fn fetch_text(
        &self,
        url: &str,
        site_id: &str,
        cancel: &CancellationToken,
    ) -> Result<String, String> {
        let cfg = self.config();

        // 总开关关闭：退化为单次直连（沿用历史行为），但仍与取消竞速保持一致语义
        if !cfg.enabled {
            let client = self.client_for(None, DEFAULT_EMULATION)?;
            return tokio::select! {
                r = fingerprint_client::request_text(&client, url) => r.map_err(|e| e.message),
                _ = cancel.cancelled() => Err("搜索已取消".to_string()),
            };
        }

        let mut attempt: u32 = 0;
        loop {
            if cancel.is_cancelled() {
                return Err("搜索已取消".to_string());
            }

            // 1. 镜像改写（当前可用域名）
            let req_url = self.mirrors.rewrite(url, site_id, cfg.mirror_rotation_enabled);
            // 2. 选代理 + 指纹 + 构建 client
            let proxy = self.select_proxy(&cfg);
            let emulation = self.next_emulation(&cfg);
            let client = self.client_for(proxy.as_deref(), emulation)?;
            // 3. 限速：同 host 错峰
            if cfg.rate_limit_enabled {
                if let Some(host) = host_of(&req_url) {
                    let wait =
                        self.rate_limiter
                            .reserve(&host, cfg.min_interval_ms, cfg.max_interval_ms);
                    if !wait.is_zero() && sleep_or_cancel(wait, cancel).await {
                        return Err("搜索已取消".to_string());
                    }
                }
            }

            // 4. 发请求（与取消竞速：搜索被取代/取消时立即放弃在途请求，不等超时）
            let response = tokio::select! {
                r = fingerprint_client::request_text(&client, &req_url) => r,
                _ = cancel.cancelled() => return Err("搜索已取消".to_string()),
            };
            match response {
                Ok(text) => {
                    if let Some(p) = &proxy {
                        self.proxy_pool.record_success(p);
                    }
                    return Ok(text);
                }
                Err(err) => {
                    if let Some(p) = &proxy {
                        self.proxy_pool.record_failure(p);
                    }
                    let retryable = err.is_retryable();

                    // 硬错误（4xx 等）或已耗尽重试：交回上层（如 4xx→WebView 回退）。
                    // 仅在「同一域名的所有重试都失败」后才切换镜像，避免一次瞬时抖动
                    // 就把请求永久切到备用域名。
                    if !retryable || attempt >= cfg.max_retries {
                        if retryable && cfg.mirror_rotation_enabled {
                            self.mirrors.advance(site_id);
                        }
                        return Err(err.message);
                    }

                    let delay = err.backoff_delay(attempt);
                    log::warn!(
                        "[anti_block] event=retry site={} url={} attempt={} delay_ms={} error={}",
                        site_id,
                        req_url,
                        attempt + 1,
                        delay.as_millis(),
                        err.message
                    );
                    attempt += 1;
                    if sleep_or_cancel(delay, cancel).await {
                        return Err("搜索已取消".to_string());
                    }
                }
            }
        }
    }
}

/// 等待 `dur`，期间若 `cancel` 触发则提前返回 `true`（表示已取消）。
async fn sleep_or_cancel(dur: Duration, cancel: &CancellationToken) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(dur) => false,
        _ = cancel.cancelled() => true,
    }
}

fn host_of(url: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read<T>(lock: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write<T>(lock: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(|poisoned| poisoned.into_inner())
}
