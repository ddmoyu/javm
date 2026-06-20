//! DMM / FANZA 官方 CDN 图片直拼（零爬取）
//!
//! 番号 → DMM `cid` → 直接拼 `pics.dmm.co.jp` 官方海报/截图 URL，HEAD 探测可用项。
//! 不爬 DMM 页面/API：被地理封锁的是网页/API，而 `pics.dmm.co.jp` CDN 不做地理封锁。
//! 仅覆盖 DMM 体系（有码主流 / FANZA）；无码 / FC2 / 素人 / 欧美 多无此资源（探测返回 None）。

use wreq::Client;

/// 截图最多探测张数（jp-1..N，编号连续，遇第一个缺失即止）
const MAX_SCREENSHOTS: usize = 30;

/// DMM 图片探测结果
#[derive(Debug, Clone)]
pub struct DmmImages {
    /// 规范化后的 DMM cid
    pub cid: String,
    /// 横版大封面 `pl.jpg`（媒体库作 fanart；竖版 poster 由图集流程右裁生成）
    pub cover_url: String,
    /// 截图 `jp-1..N`（仅 digital 路径有）
    pub screenshot_urls: Vec<String>,
}

/// 番号 → DMM cid：字母前缀（可含开头数字）小写 + 尾部数字补零到 5 位。
///
/// 例：`SSIS-001` → `ssis00001`、`MIDE-123` → `mide00123`、`300MIUM-456` → `300mium00456`。
/// 无尾部数字 / 无字母前缀时返回 None。DMM 特例前缀映射可在 [`apply_cid_prefix_map`] 扩充。
pub fn designation_to_cid(code: &str) -> Option<String> {
    let (label, number) = split_label_number(code)?;
    Some(apply_cid_prefix_map(&format!("{}{:05}", label, number)))
}

/// 拆出「字母前缀（可含开头数字） + 尾部数字」。
fn split_label_number(code: &str) -> Option<(String, u32)> {
    let compact: String = code.trim().chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = compact.as_bytes();
    let mut start = bytes.len();
    while start > 0 && bytes[start - 1].is_ascii_digit() {
        start -= 1;
    }
    if start == bytes.len() {
        return None; // 无尾部数字
    }
    let number: u32 = compact[start..].parse().ok()?;
    let label: String = compact[..start]
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    if label.is_empty() {
        return None; // 无字母前缀（纯数字番号无法定位 DMM cid）
    }
    Some((label, number))
}

/// DMM 特例前缀映射（部分素人厂牌的 cid 带 `h_` 等前缀）。当前为恒等，按需扩充。
fn apply_cid_prefix_map(cid: &str) -> String {
    cid.to_string()
}

fn digital_cover_url(cid: &str) -> String {
    format!("https://pics.dmm.co.jp/digital/video/{cid}/{cid}pl.jpg")
}

fn mono_cover_url(cid: &str) -> String {
    format!("https://pics.dmm.co.jp/mono/movie/adult/{cid}/{cid}pl.jpg")
}

fn screenshot_url(cid: &str, n: usize) -> String {
    format!("https://pics.dmm.co.jp/digital/video/{cid}/{cid}jp-{n}.jpg")
}

/// HEAD 探测 URL 是否可用（2xx）。
async fn url_exists(client: &Client, url: &str) -> bool {
    matches!(client.head(url).send().await, Ok(resp) if resp.status().is_success())
}

/// 探测某 cid 的海报：digital 优先、回退 mono。返回 (URL, 是否 digital 路径)。
async fn probe_cover_for_cid(client: &Client, cid: &str) -> Option<(String, bool)> {
    let digital = digital_cover_url(cid);
    if url_exists(client, &digital).await {
        return Some((digital, true));
    }
    let mono = mono_cover_url(cid);
    if url_exists(client, &mono).await {
        return Some((mono, false));
    }
    None
}

/// 仅探测 DMM 官方海报 URL（不含截图，供批量补全等只需封面的场景，开销小）。
pub async fn probe_dmm_cover(client: &Client, code: &str) -> Option<String> {
    let cid = designation_to_cid(code)?;
    probe_cover_for_cid(client, &cid).await.map(|(url, _)| url)
}

/// 探测某番号的 DMM 官方图片：海报（digital 优先、回退 mono）+ 截图（digital `jp-1..N`）。
///
/// 番号无法转 cid 或 DMM 无此片时返回 None。
pub async fn probe_dmm_images(client: &Client, code: &str) -> Option<DmmImages> {
    let cid = designation_to_cid(code)?;
    let (cover_url, is_digital) = probe_cover_for_cid(client, &cid).await?;
    let screenshot_urls = if is_digital {
        probe_screenshots(client, &cid).await
    } else {
        Vec::new()
    };
    Some(DmmImages { cid, cover_url, screenshot_urls })
}

/// 并发探测全部 `jp-1..MAX`（同时发起，不提前终止请求），再按「编号连续」语义
/// 保留结果中存在的前缀段（遇第一个缺失即截断后续）。
async fn probe_screenshots(client: &Client, cid: &str) -> Vec<String> {
    let client = std::sync::Arc::new(client.clone());
    let mut handles = Vec::with_capacity(MAX_SCREENSHOTS);
    for n in 1..=MAX_SCREENSHOTS {
        let url = screenshot_url(cid, n);
        let client = client.clone();
        handles.push(tokio::spawn(async move {
            let ok = url_exists(&client, &url).await;
            (n, url, ok)
        }));
    }

    let mut results: Vec<(usize, String, bool)> = Vec::with_capacity(MAX_SCREENSHOTS);
    for handle in handles {
        if let Ok(item) = handle.await {
            results.push(item);
        }
    }
    results.sort_by_key(|(n, _, _)| *n);

    let mut urls = Vec::new();
    for (_, url, exists) in results {
        if exists {
            urls.push(url);
        } else {
            break;
        }
    }
    urls
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cid_pads_number_to_five_digits() {
        assert_eq!(designation_to_cid("SSIS-001").as_deref(), Some("ssis00001"));
        assert_eq!(designation_to_cid("ssis-666").as_deref(), Some("ssis00666"));
        assert_eq!(designation_to_cid("MIDE-123").as_deref(), Some("mide00123"));
        assert_eq!(designation_to_cid("ABP-1000").as_deref(), Some("abp01000"));
    }

    #[test]
    fn cid_handles_no_hyphen_and_amateur_prefix() {
        assert_eq!(designation_to_cid("ssis123").as_deref(), Some("ssis00123"));
        assert_eq!(designation_to_cid("300MIUM-456").as_deref(), Some("300mium00456"));
        assert_eq!(designation_to_cid("  pred-99  ").as_deref(), Some("pred00099"));
    }

    #[test]
    fn cid_rejects_without_label_or_number() {
        assert_eq!(designation_to_cid("ABC"), None);
        assert_eq!(designation_to_cid(""), None);
        assert_eq!(designation_to_cid("123"), None); // 无字母前缀
    }

    #[test]
    fn url_templates_match_dmm_cdn() {
        assert_eq!(
            digital_cover_url("ssis00001"),
            "https://pics.dmm.co.jp/digital/video/ssis00001/ssis00001pl.jpg"
        );
        assert_eq!(
            mono_cover_url("ssis00001"),
            "https://pics.dmm.co.jp/mono/movie/adult/ssis00001/ssis00001pl.jpg"
        );
        assert_eq!(
            screenshot_url("ssis00001", 3),
            "https://pics.dmm.co.jp/digital/video/ssis00001/ssis00001jp-3.jpg"
        );
    }
}
