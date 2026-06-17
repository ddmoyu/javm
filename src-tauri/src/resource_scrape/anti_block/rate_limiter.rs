//! 按 host 的请求间隔限速
//!
//! 为每个 host 维护「下一次允许发送的时刻」。每次请求前预约一个发送时刻并返回需要
//! 等待的时长——预约时即把该 host 的下一允许时刻向后推一个随机间隔，因此并发请求
//! 同一 host 会被自然错峰排队（礼貌爬取，降低被限频/封禁概率）。
//!
//! 关键点：锁内只做时刻计算，**不在持锁状态下 await**，sleep 由调用方在锁外执行。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct RateLimiter {
    /// host -> 下一次允许发送的时刻
    next_allowed: Mutex<HashMap<String, Instant>>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            next_allowed: Mutex::new(HashMap::new()),
        }
    }

    /// 为 `host` 预约一个发送时刻，返回从现在起需要等待的时长。
    /// 实际间隔在 `[min_ms, max_ms]` 内随机取值。
    pub fn reserve(&self, host: &str, min_ms: u64, max_ms: u64) -> Duration {
        let interval_ms = if max_ms <= min_ms {
            min_ms
        } else {
            // random_range 上界为开区间，+1 使 max_ms 可取到
            rand::random_range(min_ms..max_ms + 1)
        };
        let interval = Duration::from_millis(interval_ms);

        let now = Instant::now();
        let mut map = self.next_allowed.lock().unwrap_or_else(|p| p.into_inner());
        // 本次发送时刻 = max(该 host 的下一允许时刻, 现在)
        let slot = map
            .get(host)
            .copied()
            .filter(|t| *t > now)
            .unwrap_or(now);
        // 推后下一允许时刻，保证后续请求与本次至少间隔 interval
        map.insert(host.to_string(), slot + interval);
        slot.saturating_duration_since(now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_request_no_wait() {
        let limiter = RateLimiter::new();
        let wait = limiter.reserve("example.com", 100, 100);
        assert!(wait.is_zero());
    }

    #[test]
    fn subsequent_requests_are_spaced() {
        let limiter = RateLimiter::new();
        let _ = limiter.reserve("example.com", 200, 200);
        let second = limiter.reserve("example.com", 200, 200);
        // 第二次需要等待约一个间隔
        assert!(second >= Duration::from_millis(150));
    }

    #[test]
    fn different_hosts_are_independent() {
        let limiter = RateLimiter::new();
        let _ = limiter.reserve("a.com", 500, 500);
        let other = limiter.reserve("b.com", 500, 500);
        assert!(other.is_zero());
    }
}
