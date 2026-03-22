//! javbus.com 数据源解析器
//!
//! 页面结构：
//! - 封面：.bigImage img src
//! - 标题：h3 文本
//! - 番号/日期/时长等：.info p 中的 span 标签
//! - 类别：.genre a[href*="genre"] 文本
//! - 女优：.star-name a 文本
//! - 预览图：.sample-box a href

use scraper::{Html, Selector};
use super::common::{select_all_attr, select_all_text, select_attr, select_text};
use super::{SearchResult, Source};

pub struct Javbus;

impl Source for Javbus {
    fn name(&self) -> &str { "javbus" }

    fn build_url(&self, code: &str) -> String {
        format!("https://www.javbus.com/{}", code)
    }

    fn parse(&self, html: &str, code: &str) -> Option<SearchResult> {
        let doc = Html::parse_document(html);

        // 封面：bigImage href 通常是大图，img src 通常是缩略图
        let poster_url = select_attr(&doc, ".bigImage img", "src")
            .map(|u| {
                if u.starts_with("http") { u }
                else { format!("https://www.javbus.com{}", u) }
            })
            .unwrap_or_default();
        let cover_url = select_attr(&doc, "a.bigImage", "href")
            .or_else(|| select_attr(&doc, ".bigImage img", "src"))
            .map(|u| {
                if u.starts_with("http") { u }
                else { format!("https://www.javbus.com{}", u) }
            })
            .unwrap_or_default();

        // 标题
        let raw_title = select_text(&doc, "h3").unwrap_or_default();
        let title = if raw_title.is_empty() {
            String::new()
        } else {
            raw_title.replace(code, "").trim().to_string()
        };
        let original_title = if raw_title.is_empty() {
            title.clone()
        } else {
            raw_title.clone()
        };
        let sort_title = if original_title.is_empty() {
            code.to_string()
        } else {
            format!("{} {}", code, original_title)
        };

        let info_text = select_text(&doc, ".info").unwrap_or_default();

        // 发行日期
        let premiered = extract_field(&info_text, &["發行日期:", "发行日期:"])
            .unwrap_or_default();
        let tagline = if premiered.is_empty() {
            String::new()
        } else {
            format!("发行日期 {}", premiered)
        };

        // 时长
        let duration_raw = extract_field(&info_text, &["長度:", "长度:"])
            .unwrap_or_default();
        let duration = if duration_raw.is_empty() {
            String::new()
        } else {
            // "120分鐘" -> "120分钟"
            duration_raw.replace("分鐘", "分钟")
        };

        // 制作商
        let studio = extract_field(&info_text, &["製作商:", "制作商:"])
            .unwrap_or_default();
        let publisher = extract_field(&info_text, &["發行商:", "发行商:"])
            .unwrap_or_default();
        let label = extract_field(&info_text, &["系列:", "标签:"])
            .unwrap_or_default();

        // 导演
        let director = extract_field(&info_text, &["導演:", "导演:"])
            .unwrap_or_default();

        // 类别（只选 href 包含 /genre/ 的链接，排除演员链接）
        let tags = select_all_text_by_href(&doc, "span.genre a", "/genre/")
            .join(", ");

        // 女优
        let actors = select_all_text(&doc, ".star-name a").join(", ");

        // 预览截图：a.sample-box 的 href 指向 dmm 大图
        let thumbs = select_all_attr(&doc, "a.sample-box", "href")
            .into_iter()
            .map(|u| {
                if u.starts_with("http") { u }
                else { format!("https://www.javbus.com{}", u) }
            })
            .collect();

        if title.is_empty() && cover_url.is_empty() {
            return None;
        }

        Some(SearchResult {
            code: code.to_string(),
            title,
            poster_url,
            actors,
            duration,
            studio: studio.clone(),
            source: self.name().to_string(),
            cover_url,
            director,
            tags: tags.clone(),
            premiered,
            rating: None,
            thumbs,
            outline: String::new(),
            plot: String::new(),
            original_plot: String::new(),
            tagline,
            sort_title,
            mpaa: "JP-18+".to_string(),
            custom_rating: "JP-18+".to_string(),
            country_code: "JP".to_string(),
            critic_rating: Some(0),
            set_name: String::new(),
            maker: studio.clone(),
            publisher,
            label,
            genres: tags.clone(),
            remote_cover_url: None,
            ..Default::default()
        })
    }
}

// ============ 辅助函数 ============

/// 选择所有匹配元素中 href 包含指定路径的文本
fn select_all_text_by_href(doc: &Html, selector_str: &str, href_contains: &str) -> Vec<String> {
    let sel = match Selector::parse(selector_str) {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    doc.select(&sel)
        .filter_map(|el| {
            let href = el.value().attr("href").unwrap_or("");
            if !href.contains(href_contains) {
                return None;
            }
            let text: String = el.text().collect::<Vec<_>>().join(" ");
            let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if cleaned.is_empty() { None } else { Some(cleaned) }
        })
        .collect()
}

/// 从信息文本中提取指定字段的值
fn extract_field(text: &str, labels: &[&str]) -> Option<String> {
    for label in labels {
        if let Some(pos) = text.find(label) {
            let after = &text[pos + label.len()..];
            let value = after.trim().split_whitespace().next()?;
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}
