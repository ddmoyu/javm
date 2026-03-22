//! javlibrary.com 数据源解析器
//!
//! 搜索 URL: `https://www.javlibrary.com/cn/vl_searchbyid.php?keyword={code}`
//! 搜索可能返回列表页（多个结果）或直接跳转到详情页。
//! 需要 `extract_detail_url()` 从列表页提取详情页链接。
//!
//! 详情页结构：
//! - 封面: `img#video_jacket_img` 的 src 属性
//! - 标题: `h3.post-title` 文本（去掉番号部分）
//! - 番号: `#video_id td:nth-child(2)` 文本
//! - 发行日期: `#video_date td:nth-child(2)` 文本
//! - 制作商: `#video_maker td:nth-child(2) span a` 文本
//! - 演员: `span.star a` 文本
//! - 标签: `span.genre a` 文本
//! - 评分: `#video_review span` 文本中的数字（格式如 "(7.50)"）

use scraper::{Html, Selector};
use super::common::{extract_head_meta, select_all_text, select_attr, select_text};
use super::{SearchResult, Source};

pub struct JavLibrary;

impl Source for JavLibrary {
    fn name(&self) -> &str {
        "javlibrary"
    }

    fn build_url(&self, code: &str) -> String {
        format!(
            "https://www.javlibrary.com/cn/vl_searchbyid.php?keyword={}",
            code
        )
    }

    /// 从搜索结果列表页提取详情页 URL
    fn extract_detail_url(&self, html: &str, code: &str) -> Option<String> {
        let doc = Html::parse_document(html);
        let code_upper = code.to_uppercase();

        // 搜索结果列表中的视频链接: .video a
        let sel = Selector::parse(".video a").ok()?;
        for el in doc.select(&sel) {
            // 检查链接文本或 title 属性是否包含番号
            let text: String = el.text().collect::<Vec<_>>().join("");
            let title = el.value().attr("title").unwrap_or("");
            if text.to_uppercase().contains(&code_upper)
                || title.to_uppercase().contains(&code_upper)
            {
                let href = el.value().attr("href").unwrap_or("");
                if !href.is_empty() {
                    return Some(normalize_url(href));
                }
            }
        }

        // 回退：取第一个 .video a 链接
        let sel = Selector::parse(".video a").ok()?;
        if let Some(el) = doc.select(&sel).next() {
            let href = el.value().attr("href").unwrap_or("");
            if !href.is_empty() {
                return Some(normalize_url(href));
            }
        }

        None
    }

    fn parse(&self, html: &str, code: &str) -> Option<SearchResult> {
        let doc = Html::parse_document(html);

        // 第一步：从 <head> 提取基础数据
        let head = extract_head_meta(&doc);

        // 封面图: img#video_jacket_img 优先，回退 head
        let cover_url = select_attr(&doc, "img#video_jacket_img", "src")
            .map(|u| {
                // javlibrary 的封面 URL 可能以 // 开头
                if u.starts_with("//") {
                    format!("https:{}", u)
                } else {
                    u
                }
            })
            .unwrap_or_else(|| head.cover_url.clone());

        // 标题: h3.post-title 优先，回退 head
        let raw_title = select_text(&doc, "h3.post-title")
            .or_else(|| select_text(&doc, "#video_title a"))
            .or_else(|| select_text(&doc, "#video_title"))
            .unwrap_or_else(|| head.title);

        let title = raw_title
            .replace(code, "")
            .replace(&code.to_uppercase(), "")
            .replace(&code.to_lowercase(), "")
            .trim_start_matches(|c: char| c == '-' || c == ' ' || c == '　')
            .trim()
            .to_string();

        // 番号: #video_id td:nth-child(2)
        let parsed_code = select_text(&doc, "#video_id td.text")
            .or_else(|| select_text(&doc, "#video_id td:nth-child(2)"))
            .unwrap_or_else(|| code.to_string());

        // 发行日期: #video_date td:nth-child(2)
        let premiered = select_text(&doc, "#video_date td.text")
            .or_else(|| select_text(&doc, "#video_date td:nth-child(2)"))
            .unwrap_or_default();

        // 制作商: #video_maker td:nth-child(2) span a
        let studio = select_text(&doc, "#video_maker td.text span a")
            .or_else(|| select_text(&doc, "#video_maker td:nth-child(2) a"))
            .unwrap_or_default();

        // 时长: #video_length td:nth-child(2) span
        let duration_raw = select_text(&doc, "#video_length td.text span")
            .or_else(|| select_text(&doc, "#video_length td:nth-child(2) span"))
            .unwrap_or_default();
        let duration = if duration_raw.is_empty() {
            String::new()
        } else {
            format!("{}分钟", duration_raw)
        };

        // 导演: #video_director td.text span a
        let director = select_text(&doc, "#video_director td.text span a")
            .or_else(|| select_text(&doc, "#video_director td:nth-child(2) a"))
            .unwrap_or_default();

        // 演员: span.star a 文本
        let actors = select_all_text(&doc, "span.star a").join(", ");

        // 标签: span.genre a 文本
        let tags = select_all_text(&doc, "span.genre a").join(", ");

        // 评分: #video_review span 文本中提取数字
        let rating = extract_rating(&doc);

        // 至少要有标题或封面才算有效结果
        if title.is_empty() && cover_url.is_empty() {
            return None;
        }

        Some(SearchResult {
            code: parsed_code,
            title,
            actors,
            duration,
            studio,
            source: self.name().to_string(),
            cover_url,
            poster_url: String::new(),
            director,
            tags,
            premiered,
            rating,
            remote_cover_url: None,
            ..Default::default()
        })
    }
}

// ============ HTML 解析辅助函数 ============

/// 从 #video_review 区域提取评分数字
/// 评分格式如 "(7.50)" 或 "7.50"
fn extract_rating(doc: &Html) -> Option<f64> {
    let text = select_text(doc, "#video_review span")
        .or_else(|| select_text(doc, "#video_review"))?;

    // 尝试从文本中提取浮点数
    // 格式可能是 "(7.50)" 或 "7.50" 或 "Average: 7.50"
    for part in text.split(|c: char| !c.is_ascii_digit() && c != '.') {
        if let Ok(val) = part.parse::<f64>() {
            if (0.0..=10.0).contains(&val) {
                return Some(val);
            }
        }
    }
    None
}

/// 将相对 URL 转换为绝对 URL
fn normalize_url(href: &str) -> String {
    if href.starts_with("http") {
        href.to_string()
    } else if href.starts_with("//") {
        format!("https:{}", href)
    } else {
        format!("https://www.javlibrary.com{}", href)
    }
}
