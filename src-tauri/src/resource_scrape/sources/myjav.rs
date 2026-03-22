//! cn.myjav.tv 数据源解析器
//!
//! 详情页 URL：`https://cn.myjav.tv/video/{CODE}`
//!
//! ### 第一步：head meta 标签
//! - og:image → 封面
//! - og:title / title → 标题
//! - og:description / description → 简介
//! - og:url / canonical → 页面 URL
//!
//! ### 第二步：body `.video-description .detail-line` 补充
//! 每行结构：
//! ```html
//! <div class="detail-line">
//!   <span class="detail-label">字段名:</span>
//!   <span class="detail-value">值 / <a> 链接</span>
//! </div>
//! ```
//! 提取：番号、类别、发布日、片商、导演、演员、时长、标签

use super::common::{dedup_strings, extract_head_meta};
use super::{SearchResult, Source};
use scraper::{Html, Selector};

pub struct MyJav;

impl Source for MyJav {
    fn name(&self) -> &str {
        "myjav"
    }

    fn build_url(&self, code: &str) -> String {
        format!("https://cn.myjav.tv/video/{}", code.to_uppercase())
    }

    fn parse(&self, html: &str, code: &str) -> Option<SearchResult> {
        let doc = Html::parse_document(html);
        let code_upper = code.trim().to_uppercase();

        // 第一步：从 <head> 提取基础数据
        let head = extract_head_meta(&doc);
        let cover_url = head.cover_url;
        let page_url = head.page_url;

        let raw_title = head.title;
        let title = clean_title(&raw_title, &code_upper);

        let plot = if !head.description.is_empty() {
            clean_description(&head.description, &code_upper)
        } else {
            String::new()
        };
        let plot = if plot.is_empty() { String::new() } else { plot };

        // ══════════════════════════════════════════
        // 第二步：从 body .detail-line 提取补充数据
        // ══════════════════════════════════════════

        let detail = extract_detail_fields(&doc);

        let premiered = detail.get_text("发布日")
            .or_else(|| detail.get_text("發佈日"))
            .or_else(|| detail.get_text("Release"))
            .unwrap_or_default();

        let duration = detail.get_text("时长")
            .or_else(|| detail.get_text("時長"))
            .or_else(|| detail.get_text("Duration"))
            .unwrap_or_default();

        let actors = detail.get_links("演员")
            .or_else(|| detail.get_links("演員"))
            .or_else(|| detail.get_links("Actress"))
            .map(|v| v.join(", "))
            .unwrap_or_default();

        let studio = detail.get_links("片商")
            .or_else(|| detail.get_links("Maker"))
            .or_else(|| detail.get_links("Studio"))
            .and_then(|v| v.into_iter().next())
            .unwrap_or_default();

        let director = detail.get_links("导演")
            .or_else(|| detail.get_links("導演"))
            .or_else(|| detail.get_links("Director"))
            .and_then(|v| v.into_iter().next())
            .unwrap_or_default();

        let tags_vec = detail.get_links("标签")
            .or_else(|| detail.get_links("標籤"))
            .or_else(|| detail.get_links("Tags"))
            .unwrap_or_default();
        let tags_str = dedup_strings(tags_vec).join(", ");

        let category = detail.get_text("类别")
            .or_else(|| detail.get_text("類別"))
            .unwrap_or_default();

        let set_name = detail.get_links("系列")
            .or_else(|| detail.get_links("Series"))
            .and_then(|v| v.into_iter().next())
            .unwrap_or_default();

        let label = detail.get_links("厂牌")
            .or_else(|| detail.get_links("Label"))
            .and_then(|v| v.into_iter().next())
            .unwrap_or_default();

        // ── 组装结果 ──

        let mpaa = if category.contains("无码") || category.contains("無碼") {
            "JP-18+ 无码".to_string()
        } else {
            "JP-18+".to_string()
        };

        if title.is_empty() && cover_url.is_empty() {
            return None;
        }

        let tagline = if premiered.is_empty() {
            String::new()
        } else {
            format!("发行日期 {}", premiered)
        };

        Some(SearchResult {
            code: code_upper,
            title,
            actors,
            duration,
            studio: studio.clone(),
            source: self.name().to_string(),
            page_url,
            cover_url,
            poster_url: String::new(),
            director,
            tags: tags_str.clone(),
            premiered,
            rating: None,
            thumbs: Vec::new(),
            remote_cover_url: None,
            plot: plot.clone(),
            outline: plot.clone(),
            original_plot: String::new(),
            tagline,
            mpaa: mpaa.clone(),
            custom_rating: mpaa,
            country_code: "JP".to_string(),
            maker: studio,
            label,
            genres: tags_str,
            set_name,
            ..Default::default()
        })
    }
}

// ══════════════════════════════════════════
// .detail-line 结构化提取
// ══════════════════════════════════════════

/// 从 `.detail-line` 行中提取的结构化数据
struct DetailFields {
    /// (label, text_value, link_texts)
    rows: Vec<(String, String, Vec<String>)>,
}

impl DetailFields {
    /// 按标签名查找纯文本值
    fn get_text(&self, label: &str) -> Option<String> {
        self.rows.iter()
            .find(|(l, _, _)| l.contains(label))
            .map(|(_, text, _)| text.clone())
            .filter(|t| !t.is_empty())
    }

    /// 按标签名查找链接文本列表
    fn get_links(&self, label: &str) -> Option<Vec<String>> {
        self.rows.iter()
            .find(|(l, _, _)| l.contains(label))
            .map(|(_, _, links)| links.clone())
            .filter(|v| !v.is_empty())
    }
}

/// 从 `.video-description .detail-line` 提取所有字段
///
/// 每行结构：
/// ```html
/// <div class="detail-line">
///   <span class="detail-label">字段名:</span>
///   <span class="detail-value">纯文本 | <a>链接文本</a></span>
/// </div>
/// ```
fn extract_detail_fields(doc: &Html) -> DetailFields {
    let mut rows = Vec::new();
    let Ok(line_sel) = Selector::parse(".detail-line") else {
        return DetailFields { rows };
    };
    let Ok(label_sel) = Selector::parse(".detail-label") else {
        return DetailFields { rows };
    };
    let Ok(value_sel) = Selector::parse(".detail-value") else {
        return DetailFields { rows };
    };
    let Ok(a_sel) = Selector::parse("a") else {
        return DetailFields { rows };
    };

    for line in doc.select(&line_sel) {
        // 提取标签名
        let label = match line.select(&label_sel).next() {
            Some(el) => {
                el.text().collect::<Vec<_>>().join("")
                    .trim()
                    .trim_end_matches(':')
                    .trim_end_matches('：')
                    .trim()
                    .to_string()
            }
            None => continue,
        };

        // 提取值区域
        let Some(value_el) = line.select(&value_sel).next() else {
            continue;
        };

        // 整体文本值（包含链接和纯文本）
        let text_value = value_el.text().collect::<Vec<_>>().join(" ");
        let text_value = text_value
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .trim_matches(|c: char| c == '/' || c == ',' || c == ' ')
            .to_string();

        // 链接文本列表
        let link_texts: Vec<String> = value_el.select(&a_sel)
            .filter_map(|a| {
                let text: String = a.text().collect::<Vec<_>>().join(" ");
                let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
                if cleaned.is_empty() { None } else { Some(cleaned) }
            })
            .collect();

        if !label.is_empty() {
            rows.push((label, text_value, link_texts));
        }
    }

    DetailFields { rows }
}

// ══════════════════════════════════════════
// 通用辅助函数
// ══════════════════════════════════════════

/// 清理标题：去掉 `{CODE} - ` 前缀和 ` - MyJav` 后缀
fn clean_title(raw: &str, code_upper: &str) -> String {
    let mut text = raw.trim().to_string();

    // 去掉 " - MyJav" / " | MyJav" 后缀（大小写不敏感）
    let lower = text.to_lowercase();
    for suffix in ["- myjav", "| myjav", "- my jav"] {
        if let Some(pos) = lower.rfind(suffix) {
            text = text[..pos].trim().to_string();
            break;
        }
    }

    // 去掉 "{CODE} - " / "{CODE} " 前缀
    let upper = text.to_uppercase();
    if let Some(rest) = upper.strip_prefix(code_upper) {
        let byte_idx = text.len() - rest.len();
        text = text[byte_idx..]
            .trim_start_matches(|c: char| c == '-' || c == ':' || c == ' ' || c == '　')
            .trim()
            .to_string();
    }

    text
}

/// 清理 description
fn clean_description(raw: &str, code_upper: &str) -> String {
    let mut text = raw.trim().to_string();
    let upper = text.to_uppercase();
    if let Some(rest) = upper.strip_prefix(code_upper) {
        let byte_idx = text.len() - rest.len();
        text = text[byte_idx..]
            .trim_start_matches(|c: char| c == '-' || c == ':' || c == ' ' || c == '　' || c == ',')
            .trim()
            .to_string();
    }
    let lower = text.to_lowercase();
    for suffix in ["- myjav", "| myjav"] {
        if let Some(pos) = lower.rfind(suffix) {
            text = text[..pos].trim().to_string();
            break;
        }
    }
    text
}
