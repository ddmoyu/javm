//! 成功率加权代理池
//!
//! 每个代理记录成功/失败次数，按成功率加权随机挑选；连续表现差（成功率低于阈值
//! 且样本足够）的代理会被临时剔除一段时间，到期后自动恢复试用。代理列表为空或
//! 代理池关闭时，调用方会退化为系统/自定义代理（见 `engine`）。

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 低于此成功率且样本足够时，临时剔除代理
const BENCH_RATE_THRESHOLD: f64 = 0.5;
/// 触发剔除所需的最小样本数（避免偶发单次失败就剔除）
const BENCH_MIN_SAMPLES: u64 = 4;
/// 剔除冷却时长
const BENCH_COOLDOWN: Duration = Duration::from_secs(300);
/// 加权随机时的最低权重，保证「差代理」仍有小概率被重新试用
const MIN_WEIGHT: f64 = 0.05;
/// 统计滑动窗口：样本累计达到此值时对成功/失败计数折半，使成功率反映**近期**表现。
/// 否则远古失败会永久压低评分，被剔除的代理即便恢复也会被一次失败立刻二次剔除、长期抖动。
const STAT_WINDOW: u64 = 20;

#[derive(Debug, Clone)]
struct ProxyStat {
    url: String,
    successes: u64,
    failures: u64,
    /// 临时剔除截止时刻；`None` 表示当前可用
    benched_until: Option<Instant>,
}

impl ProxyStat {
    fn new(url: String) -> Self {
        Self {
            url,
            successes: 0,
            failures: 0,
            benched_until: None,
        }
    }

    fn samples(&self) -> u64 {
        self.successes + self.failures
    }

    /// 记录一次结果；样本超过窗口时先折半旧统计，让近期表现主导成功率。
    fn record(&mut self, success: bool) {
        if self.samples() >= STAT_WINDOW {
            self.successes = (self.successes + 1) / 2;
            self.failures = (self.failures + 1) / 2;
        }
        if success {
            self.successes += 1;
        } else {
            self.failures += 1;
        }
    }

    /// 成功率；无样本时视为 1.0（新代理给予充分试用机会）
    fn success_rate(&self) -> f64 {
        let total = self.samples();
        if total == 0 {
            1.0
        } else {
            self.successes as f64 / total as f64
        }
    }

    fn weight(&self) -> f64 {
        self.success_rate().max(MIN_WEIGHT)
    }

    fn is_available(&self, now: Instant) -> bool {
        self.benched_until.map_or(true, |until| now >= until)
    }
}

pub struct ProxyPool {
    stats: Mutex<Vec<ProxyStat>>,
}

impl ProxyPool {
    pub fn new() -> Self {
        Self {
            stats: Mutex::new(Vec::new()),
        }
    }

    /// 更新代理列表：保留仍在列表中的代理的历史统计，移除已删除的，新增新代理。
    pub fn set_proxies(&self, urls: &[String]) {
        let mut guard = lock(&self.stats);
        let mut next: Vec<ProxyStat> = Vec::with_capacity(urls.len());
        for url in urls {
            let url = url.trim().to_string();
            if url.is_empty() || next.iter().any(|s| s.url == url) {
                continue;
            }
            match guard.iter().find(|s| s.url == url) {
                Some(existing) => next.push(existing.clone()),
                None => next.push(ProxyStat::new(url)),
            }
        }
        *guard = next;
    }

    /// 是否存在可用代理
    pub fn is_empty(&self) -> bool {
        lock(&self.stats).is_empty()
    }

    /// 按成功率加权随机挑选一个代理；池为空返回 `None`（调用方退化为系统代理）。
    pub fn select(&self) -> Option<String> {
        let mut guard = lock(&self.stats);
        if guard.is_empty() {
            return None;
        }

        let now = Instant::now();
        // 候选 = 未被剔除的代理；若全部被剔除，则解除全部剔除给予二次机会
        let mut candidates: Vec<usize> = guard
            .iter()
            .enumerate()
            .filter(|(_, s)| s.is_available(now))
            .map(|(i, _)| i)
            .collect();
        if candidates.is_empty() {
            for s in guard.iter_mut() {
                s.benched_until = None;
            }
            candidates = (0..guard.len()).collect();
        }

        let total_weight: f64 = candidates.iter().map(|&i| guard[i].weight()).sum();
        if total_weight <= 0.0 {
            return guard.get(candidates[0]).map(|s| s.url.clone());
        }

        let mut pick = rand::random::<f64>() * total_weight;
        for &i in &candidates {
            pick -= guard[i].weight();
            if pick <= 0.0 {
                return Some(guard[i].url.clone());
            }
        }
        // 浮点误差兜底
        guard.get(*candidates.last().unwrap()).map(|s| s.url.clone())
    }

    pub fn record_success(&self, url: &str) {
        let mut guard = lock(&self.stats);
        if let Some(stat) = guard.iter_mut().find(|s| s.url == url) {
            stat.record(true);
            stat.benched_until = None;
        }
    }

    pub fn record_failure(&self, url: &str) {
        let mut guard = lock(&self.stats);
        if let Some(stat) = guard.iter_mut().find(|s| s.url == url) {
            stat.record(false);
            if stat.samples() >= BENCH_MIN_SAMPLES && stat.success_rate() < BENCH_RATE_THRESHOLD {
                stat.benched_until = Some(Instant::now() + BENCH_COOLDOWN);
            }
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_pool_selects_none() {
        let pool = ProxyPool::new();
        assert!(pool.select().is_none());
    }

    #[test]
    fn set_proxies_preserves_existing_stats() {
        let pool = ProxyPool::new();
        pool.set_proxies(&["http://a".into(), "http://b".into()]);
        pool.record_success("http://a");
        pool.record_success("http://a");
        // 重设列表（仍含 a），a 的统计应保留
        pool.set_proxies(&["http://a".into(), "http://c".into()]);
        let guard = lock(&pool.stats);
        let a = guard.iter().find(|s| s.url == "http://a").unwrap();
        assert_eq!(a.successes, 2);
        assert!(guard.iter().any(|s| s.url == "http://c"));
        assert!(!guard.iter().any(|s| s.url == "http://b"));
    }

    #[test]
    fn dedups_proxies() {
        let pool = ProxyPool::new();
        pool.set_proxies(&["http://a".into(), "http://a".into(), " ".into()]);
        assert_eq!(lock(&pool.stats).len(), 1);
    }

    #[test]
    fn recent_successes_recover_rate_via_decay() {
        let pool = ProxyPool::new();
        pool.set_proxies(&["http://p".into()]);
        // 一段糟糕历史
        for _ in 0..STAT_WINDOW {
            pool.record_failure("http://p");
        }
        // 之后持续成功：近期表现应让成功率回到阈值之上，且样本被窗口限制不会无界累积
        for _ in 0..(STAT_WINDOW * 2) {
            pool.record_success("http://p");
        }
        let guard = lock(&pool.stats);
        let p = &guard[0];
        assert!(
            p.success_rate() > BENCH_RATE_THRESHOLD,
            "rate={}",
            p.success_rate()
        );
        assert!(p.samples() <= STAT_WINDOW * 2, "samples={}", p.samples());
    }

    #[test]
    fn poor_proxy_gets_benched_then_recovers_when_all_benched() {
        let pool = ProxyPool::new();
        pool.set_proxies(&["http://bad".into()]);
        for _ in 0..BENCH_MIN_SAMPLES {
            pool.record_failure("http://bad");
        }
        // 唯一代理被剔除后，select 仍应给二次机会而非返回 None
        assert_eq!(pool.select().as_deref(), Some("http://bad"));
    }
}
