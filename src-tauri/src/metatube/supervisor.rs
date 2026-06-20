//! MetaTube sidecar 进程监督器
//!
//! 长驻进程的完整生命周期：拉起 → 健康检查 → 就绪；崩溃自动**重启（指数退避）**；连续失败
//! 达上限 → 标记 `Failed`（**回退**：该刮削源被跳过，自研源不受影响）；应用退出 → **随之关闭**
//! （取消 + 按 PID 强杀，保证不残留僵尸进程）。

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use super::client::MetaTubeClient;
use super::types::{MetaTubeConfig, MetaTubeStatus, MetaTubeStatusSnapshot};

/// 启动退避起始/上限
const BACKOFF_START: Duration = Duration::from_secs(2);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// 连续失败上限，超过则放弃（标记 Failed，回退）
const MAX_CONSECUTIVE_FAILURES: u32 = 5;
/// 单次健康检查最长等待
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);

struct Inner {
    /// 二进制路径（可在运行时下载后经 [`reresolve_binary`](MetaTubeManager::reresolve_binary) 重解析）
    binary: RwLock<Option<PathBuf>>,
    /// 应用数据 `bin/` 目录（运行时下载落地处，也是重解析的优先候选）
    bin_dir: Option<PathBuf>,
    db_path: PathBuf,
    token: String,
    config: RwLock<MetaTubeConfig>,
    status: RwLock<MetaTubeStatus>,
    port: RwLock<Option<u16>>,
    pid: RwLock<Option<u32>>,
    last_error: RwLock<Option<String>>,
    restarts: AtomicU32,
    /// 保证同一时刻只有一个监督任务在跑
    running: AtomicBool,
    /// 手动重启标志：杀进程后让监督循环把这次退出当"主动重启"而非"崩溃失败"
    manual_restart: AtomicBool,
    shutdown: CancellationToken,
}

impl Inner {
    fn set_status(&self, status: MetaTubeStatus) {
        *write(&self.status) = status;
    }
    fn set_error(&self, err: impl Into<String>) {
        let err = err.into();
        log::warn!("[metatube] event=error detail={}", err);
        *write(&self.last_error) = Some(err);
    }
}

/// sidecar 管理器（Tauri 托管状态）
pub struct MetaTubeManager {
    inner: Arc<Inner>,
}

impl MetaTubeManager {
    /// 创建管理器（解析二进制、生成随机 token）。不自动启动，需调用 [`start`](Self::start)。
    pub fn new(db_path: PathBuf, config: MetaTubeConfig) -> Self {
        // 应用数据 bin/ 目录（= metatube.db 同级的 bin/），运行时下载的二进制落地于此
        let bin_dir = db_path.parent().map(|p| p.join("bin"));
        let binary = super::binary::resolve_binary_path(bin_dir.as_deref());
        let token = uuid::Uuid::new_v4().simple().to_string();
        let initial = if !config.enabled {
            MetaTubeStatus::Disabled
        } else if binary.is_none() {
            MetaTubeStatus::Failed
        } else {
            MetaTubeStatus::Stopped
        };
        Self {
            inner: Arc::new(Inner {
                binary: RwLock::new(binary),
                bin_dir,
                db_path,
                token,
                config: RwLock::new(config),
                status: RwLock::new(initial),
                port: RwLock::new(None),
                pid: RwLock::new(None),
                last_error: RwLock::new(None),
                restarts: AtomicU32::new(0),
                running: AtomicBool::new(false),
                manual_restart: AtomicBool::new(false),
                shutdown: CancellationToken::new(),
            }),
        }
    }

    /// 启动监督循环（后台任务，非阻塞）。未启用或二进制缺失则直接返回。
    pub fn start(&self) {
        if !read(&self.inner.config).enabled {
            log::info!("[metatube] event=start_skipped reason=disabled");
            return;
        }
        if read(&self.inner.binary).is_none() {
            self.inner.set_error("未找到 metatube-server 二进制（未打包/下载）");
            log::warn!("[metatube] event=start_skipped reason=binary_missing");
            return;
        }
        spawn_supervisor_if_idle(self.inner.clone());
    }

    /// 重新解析二进制路径（运行时下载完成后调用）。若由「缺二进制」导致的 `Failed`
    /// 现已就位，则把状态恢复为 `Stopped`，便于随后 [`start`](Self::start)/[`restart`](Self::restart)。
    pub fn reresolve_binary(&self) {
        let resolved = super::binary::resolve_binary_path(self.inner.bin_dir.as_deref());
        let present = resolved.is_some();
        *write(&self.inner.binary) = resolved;
        if present && self.status() == MetaTubeStatus::Failed {
            self.inner.set_status(MetaTubeStatus::Stopped);
        }
    }

    /// 手动重启：杀掉当前进程促其重启周期；若监督已放弃（Failed）则重新拉起一个监督任务。
    pub fn restart(&self) {
        if self.inner.shutdown.is_cancelled() || read(&self.inner.binary).is_none() {
            return;
        }
        log::info!("[metatube] event=manual_restart");
        // 标记本次杀进程为"主动重启"，监督循环据此不计入失败次数
        self.inner.manual_restart.store(true, Ordering::Release);
        let pid = *read(&self.inner.pid);
        if let Some(pid) = pid {
            kill_pid(pid);
        }
        // 若监督任务已退出（放弃），重新拉起；正在跑则上面的杀进程会触发其自动重启
        spawn_supervisor_if_idle(self.inner.clone());
    }

    /// 应用退出 / 手动停止：取消监督 + 强杀进程（含 Windows 进程树）。
    pub async fn shutdown(&self) {
        self.inner.shutdown.cancel();
        let pid = *read(&self.inner.pid);
        if let Some(pid) = pid {
            kill_pid(pid);
        }
        // 不覆盖 Disabled（从未启用）的语义
        if self.status() != MetaTubeStatus::Disabled {
            self.inner.set_status(MetaTubeStatus::Stopped);
        }
        *write(&self.inner.port) = None;
        log::info!("[metatube] event=shutdown");
    }

    pub fn status(&self) -> MetaTubeStatus {
        *read(&self.inner.status)
    }

    /// 就绪时返回本地 base_url（`http://127.0.0.1:port`），否则 `None`（→ 回退跳过该源）。
    pub fn base_url(&self) -> Option<String> {
        if self.status() != MetaTubeStatus::Ready {
            return None;
        }
        read(&self.inner.port).map(|p| format!("http://127.0.0.1:{}", p))
    }

    /// 就绪时返回可用客户端，否则 `None`。
    pub fn client(&self) -> Option<MetaTubeClient> {
        let base = self.base_url()?;
        MetaTubeClient::new(base, self.inner.token.clone()).ok()
    }

    pub fn config(&self) -> MetaTubeConfig {
        read(&self.inner.config).clone()
    }

    pub fn snapshot(&self) -> MetaTubeStatusSnapshot {
        MetaTubeStatusSnapshot {
            status: self.status(),
            port: *read(&self.inner.port),
            binary_present: read(&self.inner.binary).is_some(),
            restarts: self.inner.restarts.load(Ordering::Relaxed),
            last_error: read(&self.inner.last_error).clone(),
        }
    }
}

/// 若当前无监督任务在跑，则启动一个（用 `running` 标志保证唯一）。
fn spawn_supervisor_if_idle(inner: Arc<Inner>) {
    if inner.shutdown.is_cancelled() {
        return;
    }
    if inner
        .running
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return; // 已有监督任务在跑
    }
    // 用 Tauri 运行时句柄 spawn：setup 阶段是同步上下文，直接 tokio::spawn 会 panic
    //（no reactor）。async_runtime::spawn 任何上下文可调，且其运行时即多线程 tokio，
    // 内部的 tokio::process / tokio::time 正常工作。
    tauri::async_runtime::spawn(async move {
        supervise(inner.clone()).await;
        inner.running.store(false, Ordering::Release);
    });
}

/// 监督循环：拉起 → 健康检查 → 等待退出/取消 → 重启/放弃。
async fn supervise(inner: Arc<Inner>) {
    let binary = match read(&inner.binary).clone() {
        Some(b) => b,
        None => return,
    };
    let cfg = read(&inner.config).clone();
    let mut backoff = BACKOFF_START;
    let mut consecutive_failures: u32 = 0;
    // 新任务起步：清掉可能残留的手动重启标志（仅对"正在跑的任务"被 restart 时有意义）
    inner.manual_restart.store(false, Ordering::Release);

    loop {
        if inner.shutdown.is_cancelled() {
            break;
        }
        inner.set_status(MetaTubeStatus::Starting);

        // 1. 选空闲端口
        let port = match probe_free_port() {
            Some(p) => p,
            None => {
                inner.set_error("无法分配本地端口");
                if !fail_and_should_continue(&inner, &mut consecutive_failures) {
                    break;
                }
                if sleep_or_cancel(backoff, &inner.shutdown).await {
                    break;
                }
                backoff = next_backoff(backoff);
                continue;
            }
        };

        // 2. 拉起进程
        let mut child = match spawn_process(&binary, &inner, port, &cfg) {
            Ok(child) => child,
            Err(e) => {
                inner.set_error(e);
                if !fail_and_should_continue(&inner, &mut consecutive_failures) {
                    break;
                }
                if sleep_or_cancel(backoff, &inner.shutdown).await {
                    break;
                }
                backoff = next_backoff(backoff);
                continue;
            }
        };
        *write(&inner.pid) = child.id();
        let base_url = format!("http://127.0.0.1:{}", port);

        // 3. 健康检查
        let healthy = wait_healthy(&base_url, &inner.token, &inner.shutdown).await;
        if inner.shutdown.is_cancelled() {
            let _ = child.start_kill();
            let _ = child.wait().await;
            break;
        }
        if !healthy {
            inner.set_error("健康检查超时");
            let _ = child.start_kill();
            let _ = child.wait().await;
            *write(&inner.pid) = None;
            if !fail_and_should_continue(&inner, &mut consecutive_failures) {
                break;
            }
            if sleep_or_cancel(backoff, &inner.shutdown).await {
                break;
            }
            backoff = next_backoff(backoff);
            continue;
        }

        // 4. 就绪
        *write(&inner.port) = Some(port);
        inner.set_status(MetaTubeStatus::Ready);
        consecutive_failures = 0;
        backoff = BACKOFF_START;
        log::info!("[metatube] event=ready port={}", port);

        // 5. 等待进程退出（崩溃）或收到关闭
        tokio::select! {
            exit = child.wait() => {
                *write(&inner.port) = None;
                *write(&inner.pid) = None;
                if inner.shutdown.is_cancelled() {
                    break;
                }
                // 手动重启杀的：不计失败、不退避，直接重启
                if inner.manual_restart.swap(false, Ordering::AcqRel) {
                    log::info!("[metatube] event=manual_restart_respawn");
                    inner.restarts.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                inner.set_error(format!("metatube 进程意外退出: {:?}", exit));
                inner.restarts.fetch_add(1, Ordering::Relaxed);
                if !fail_and_should_continue(&inner, &mut consecutive_failures) {
                    break;
                }
                if sleep_or_cancel(backoff, &inner.shutdown).await {
                    break;
                }
                backoff = next_backoff(backoff);
                continue;
            }
            _ = inner.shutdown.cancelled() => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                break;
            }
        }
    }

    *write(&inner.port) = None;
    *write(&inner.pid) = None;
    // 已置 Failed 的不覆盖；否则收尾为 Stopped
    if *read(&inner.status) != MetaTubeStatus::Failed {
        inner.set_status(MetaTubeStatus::Stopped);
    }
    log::info!("[metatube] event=supervisor_exit");
}

/// 累计失败并判断是否继续重试；超上限则标记 Failed 并返回 false（放弃）。
fn fail_and_should_continue(inner: &Inner, consecutive: &mut u32) -> bool {
    *consecutive += 1;
    if *consecutive >= MAX_CONSECUTIVE_FAILURES {
        inner.set_status(MetaTubeStatus::Failed);
        log::error!(
            "[metatube] event=give_up consecutive_failures={} note=源将被跳过，自研源不受影响",
            *consecutive
        );
        false
    } else {
        true
    }
}

fn next_backoff(current: Duration) -> Duration {
    (current * 2).min(BACKOFF_MAX)
}

/// 等待 `dur`，期间被取消则返回 true。
async fn sleep_or_cancel(dur: Duration, cancel: &CancellationToken) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(dur) => false,
        _ = cancel.cancelled() => true,
    }
}

/// 探测一个空闲端口（绑 127.0.0.1:0 取系统分配端口后释放）。
fn probe_free_port() -> Option<u16> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| addr.port())
}

/// 拉起 metatube-server 进程（隐藏控制台、丢弃 stdio、drop 时连带杀进程）。
/// 启动参数均已实测确认：`-dsn` 库、`-port` 端口、`-token` 鉴权、`-bind 127.0.0.1` 仅监听回环、
/// `-db-auto-migrate` 首次自动建表。extra_args 供额外覆盖。
fn spawn_process(
    binary: &PathBuf,
    inner: &Inner,
    port: u16,
    cfg: &MetaTubeConfig,
) -> Result<tokio::process::Child, String> {
    let mut std_cmd = std::process::Command::new(binary);
    std_cmd
        .arg("-dsn")
        .arg(&inner.db_path)
        .arg("-port")
        .arg(port.to_string())
        .arg("-token")
        .arg(&inner.token)
        .arg("-bind")
        .arg("127.0.0.1")
        .arg("-db-auto-migrate")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
    for arg in &cfg.extra_args {
        std_cmd.arg(arg);
    }
    // 把 app 的代理透传给 sidecar 的出站抓取（Go net/http 默认识别这些环境变量）。
    // metatube 各 provider 多为境外站点，需与自研源同样走代理才能命中。
    if let Some(proxy) = crate::utils::proxy::get_proxy_url() {
        let proxy = proxy.to_string();
        std_cmd.env("HTTP_PROXY", &proxy);
        std_cmd.env("HTTPS_PROXY", &proxy);
        std_cmd.env("ALL_PROXY", &proxy);
    }
    hide_console(&mut std_cmd);

    let mut cmd = tokio::process::Command::from(std_cmd);
    cmd.kill_on_drop(true);
    cmd.spawn()
        .map_err(|e| format!("拉起 metatube-server 失败: {}", e))
}

/// 轮询健康检查直到就绪或超时；被取消时提前返回 false。
async fn wait_healthy(base_url: &str, token: &str, cancel: &CancellationToken) -> bool {
    let Ok(client) = MetaTubeClient::new(base_url.to_string(), token.to_string()) else {
        return false;
    };
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    loop {
        if cancel.is_cancelled() {
            return false;
        }
        if client.health().await {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        if sleep_or_cancel(Duration::from_millis(500), cancel).await {
            return false;
        }
    }
}

#[cfg(windows)]
fn hide_console(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut std::process::Command) {}

/// 按 PID 强杀进程（应用退出时保证不残留）。Windows 连带进程树（`/T`）。
fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status();
    }
}

fn read<T>(lock: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write<T>(lock: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_free_port_returns_usable_port() {
        let port = probe_free_port().expect("应能分配端口");
        assert!(port > 0);
    }

    #[test]
    fn backoff_grows_and_caps() {
        let mut b = BACKOFF_START;
        for _ in 0..10 {
            b = next_backoff(b);
        }
        assert_eq!(b, BACKOFF_MAX);
    }

    #[test]
    fn give_up_after_max_failures() {
        let mgr = MetaTubeManager::new(
            std::path::PathBuf::from("test.db"),
            MetaTubeConfig::default(),
        );
        let mut consecutive = 0;
        // 前 MAX-1 次应继续
        for _ in 0..(MAX_CONSECUTIVE_FAILURES - 1) {
            assert!(fail_and_should_continue(&mgr.inner, &mut consecutive));
        }
        // 第 MAX 次放弃
        assert!(!fail_and_should_continue(&mgr.inner, &mut consecutive));
        assert_eq!(mgr.status(), MetaTubeStatus::Failed);
    }

    #[test]
    fn disabled_config_yields_disabled_status() {
        let cfg = MetaTubeConfig {
            enabled: false,
            ..Default::default()
        };
        let mgr = MetaTubeManager::new(std::path::PathBuf::from("x.db"), cfg);
        assert_eq!(mgr.status(), MetaTubeStatus::Disabled);
        assert!(mgr.base_url().is_none());
    }
}
