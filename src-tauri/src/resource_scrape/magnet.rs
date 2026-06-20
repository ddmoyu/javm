//! 磁力链接获取与排序（javbus 风格）。
//!
//! 流程（网络部分在命令层）：详情页提取 `gid`/`uc`/`img` JS 变量 → 请求
//! `uncledatoolsbyajax.php`（带 Referer）→ `scraper` 解析磁力表格 → 排序（字幕 > 高清 > 体积）。
//! 本模块只含**纯解析 + 排序**，便于单测；站点结构变动需回归调整选择器。

use scraper::{Html, Selector};
use serde::Serialize;

/// 单条磁力
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MagnetItem {
    pub link: String,
    pub name: String,
    pub size: String,
    pub size_bytes: u64,
    pub date: String,
    pub is_hd: bool,
    pub has_subtitle: bool,
}

/// 从详情页 HTML 提取磁力 ajax 所需的 `gid` / `uc` / `img`。缺 gid 即无磁力入口。
pub fn extract_magnet_vars(html: &str) -> Option<(String, String, String)> {
    let gid = regex::Regex::new(r"var\s+gid\s*=\s*(\d+)")
        .ok()?
        .captures(html)?
        .get(1)?
        .as_str()
        .to_string();
    let uc = regex::Regex::new(r"var\s+uc\s*=\s*(\d+)")
        .ok()
        .and_then(|re| re.captures(html).and_then(|c| c.get(1).map(|m| m.as_str().to_string())))
        .unwrap_or_else(|| "0".to_string());
    let img = regex::Regex::new(r#"var\s+img\s*=\s*'([^']*)'"#)
        .ok()
        .and_then(|re| re.captures(html).and_then(|c| c.get(1).map(|m| m.as_str().to_string())))
        .unwrap_or_default();
    Some((gid, uc, img))
}

/// 把 "5.34GB" / "700MB" / "1.5TB" 解析为字节数，用于排序。无法识别则 0。
pub fn parse_size(s: &str) -> u64 {
    let s = s.trim();
    let num: String = s.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    if num.is_empty() {
        return 0;
    }
    let val: f64 = num.parse().unwrap_or(0.0);
    let unit = s[num.len()..].trim_start().to_uppercase();
    let mult = if unit.starts_with("TB") {
        1024f64.powi(4)
    } else if unit.starts_with("GB") {
        1024f64.powi(3)
    } else if unit.starts_with("MB") {
        1024f64.powi(2)
    } else if unit.starts_with("KB") {
        1024.0
    } else {
        1.0
    };
    (val * mult) as u64
}

/// 解析磁力表格 HTML 为磁力列表（每行：链接 + 名称 + 高清/字幕标记 + 体积 + 日期）。
pub fn parse_magnet_table(html: &str) -> Vec<MagnetItem> {
    let doc = Html::parse_document(html);
    let row_sel = match Selector::parse("tr") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let magnet_sel = Selector::parse(r#"a[href^="magnet"]"#).ok();
    let td_sel = Selector::parse("td").ok();

    doc.select(&row_sel)
        .filter_map(|tr| {
            let magnet_a = magnet_sel.as_ref().and_then(|s| tr.select(s).next())?;
            let link = magnet_a.value().attr("href")?.to_string();
            let name = magnet_a.text().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");

            let tds: Vec<_> = td_sel
                .as_ref()
                .map(|s| tr.select(s).collect())
                .unwrap_or_default();
            let td_text = |i: usize| -> String {
                tds.get(i)
                    .map(|e: &scraper::ElementRef| {
                        e.text().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
                    })
                    .unwrap_or_default()
            };

            let first_td = td_text(0);
            let is_hd = first_td.contains("高清") || first_td.to_uppercase().contains("HD");
            let has_subtitle = first_td.contains("字幕");
            let size = td_text(1);
            let date = td_text(2);

            Some(MagnetItem {
                link,
                name,
                size_bytes: parse_size(&size),
                size,
                date,
                is_hd,
                has_subtitle,
            })
        })
        .collect()
}

/// 排序：字幕 > 高清 > 体积（降序）。据此首条即「最优磁力」。
pub fn sort_magnets(items: &mut [MagnetItem]) {
    items.sort_by(|a, b| {
        b.has_subtitle
            .cmp(&a.has_subtitle)
            .then(b.is_hd.cmp(&a.is_hd))
            .then(b.size_bytes.cmp(&a.size_bytes))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sizes() {
        assert_eq!(parse_size("5GB"), 5 * 1024 * 1024 * 1024);
        assert_eq!(parse_size("700MB"), 700 * 1024 * 1024);
        assert_eq!(parse_size("1.5TB"), (1.5 * 1024f64.powi(4)) as u64);
        assert_eq!(parse_size("5.34 GB"), (5.34 * 1024f64.powi(3)) as u64);
        assert_eq!(parse_size(""), 0);
        assert_eq!(parse_size("未知"), 0);
    }

    #[test]
    fn extracts_vars() {
        let html = "<script>var gid = 12345;var uc=0;var img='https://x/a.jpg';</script>";
        let (gid, uc, img) = extract_magnet_vars(html).unwrap();
        assert_eq!(gid, "12345");
        assert_eq!(uc, "0");
        assert_eq!(img, "https://x/a.jpg");
        assert!(extract_magnet_vars("<script>no vars</script>").is_none());
    }

    #[test]
    fn parses_magnet_rows() {
        let html = r#"
            <table><tbody>
              <tr>
                <td><a href="magnet:?xt=urn:btih:AAA&dn=x">作品一</a>
                    <a class="btn btn-warning">字幕</a><a class="btn btn-primary">高清</a></td>
                <td><a href="magnet:?xt=urn:btih:AAA">5.34GB</a></td>
                <td><a href="magnet:?xt=urn:btih:AAA">2024-01-01</a></td>
              </tr>
              <tr>
                <td><a href="magnet:?xt=urn:btih:BBB">作品二</a></td>
                <td><a href="magnet:?xt=urn:btih:BBB">700MB</a></td>
                <td><a href="magnet:?xt=urn:btih:BBB">2023-05-09</a></td>
              </tr>
            </tbody></table>
        "#;
        let items = parse_magnet_table(html);
        assert_eq!(items.len(), 2);
        assert!(items[0].link.starts_with("magnet:?xt=urn:btih:AAA"));
        assert_eq!(items[0].size, "5.34GB");
        assert!(items[0].has_subtitle);
        assert!(items[0].is_hd);
        assert!(!items[1].has_subtitle);
        assert!(!items[1].is_hd);
    }

    #[test]
    fn sorts_subtitle_hd_size() {
        let mut items = vec![
            MagnetItem { link: "a".into(), size_bytes: 1000, is_hd: false, has_subtitle: false, ..Default::default() },
            MagnetItem { link: "b".into(), size_bytes: 100, is_hd: false, has_subtitle: true, ..Default::default() },
            MagnetItem { link: "c".into(), size_bytes: 500, is_hd: true, has_subtitle: false, ..Default::default() },
            MagnetItem { link: "d".into(), size_bytes: 9000, is_hd: true, has_subtitle: false, ..Default::default() },
        ];
        sort_magnets(&mut items);
        // 字幕优先 → b；其次高清按体积 → d(9000) > c(500)；最后无标记 → a
        assert_eq!(items.iter().map(|m| m.link.as_str()).collect::<Vec<_>>(), vec!["b", "d", "c", "a"]);
    }
}
