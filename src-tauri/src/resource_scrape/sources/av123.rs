//! 123av.com 数据源解析器
//!
//! 详情页 URL：`https://123av.com/zh/v/{code}`
//!
//! ### head meta 标签
//! - og:image → 封面
//! - og:title / title → 标题、演员
//! - og:description / description → 简介
//! - og:url / canonical → 页面 URL
//!
//! ### body `.content` 区域
//! - `.description` → 剧情简介
//! - `.detail-item` → 结构化字段（番号、日期、时长、演员、类型、系列、制作人、标签）
//!   每行格式：`<span>标签:</span> <span>值/链接</span>`

use super::common::{dedup_strings, extract_head_meta, select_text};
use super::{SearchResult, Source};
use scraper::{Html, Selector};

pub struct Av123;

impl Source for Av123 {
    fn name(&self) -> &str {
        "123av"
    }

    fn build_url(&self, code: &str) -> String {
        format!("https://123av.com/zh/v/{}", code.to_lowercase())
    }

    fn parse(&self, html: &str, code: &str) -> Option<SearchResult> {
        let doc = Html::parse_document(html);
        let code_upper = code.trim().to_uppercase();

        // 第一步：从 <head> 提取基础数据
        let head = extract_head_meta(&doc);
        let cover_url = head.cover_url;
        let page_url = head.page_url;
        let raw_title = head.title;
        let meta_desc = head.description;
        let (title_from_head, actors_from_head) = parse_og_title(&raw_title, &code_upper);

        // ── body .detail-item 结构化字段 ──
        let detail_fields = extract_detail_fields(&doc);

        // ── body .description 简介 ──
        let body_plot = select_text(&doc, ".description p")
            .or_else(|| select_text(&doc, ".description"))
            .map(|t| {
                t.replace("更多..", "")
                    .trim()
                    .to_string()
            })
            .filter(|t| !t.is_empty());

        // 简介：优先 body 完整简介，回退 head description
        let plot = body_plot
            .unwrap_or_else(|| clean_description(&meta_desc, &code_upper));

        // 标题：优先 detail-item 中的标题（如有），回退 head
        let title = title_from_head;

        // 番号
        let premiered = detail_fields.get("发布日期")
            .or_else(|| detail_fields.get("發佈日期"))
            .or_else(|| detail_fields.get("Release Date"))
            .cloned()
            .unwrap_or_default();

        // 时长
        let duration = detail_fields.get("时长")
            .or_else(|| detail_fields.get("時長"))
            .or_else(|| detail_fields.get("Duration"))
            .cloned()
            .unwrap_or_default();

        // 演员：优先 detail-item 链接，回退 head
        let actors_from_detail = extract_detail_link_texts(&doc, &["女演员", "女優", "Actress", "演员"]);
        let actors = if !actors_from_detail.is_empty() {
            dedup_strings(actors_from_detail).join(", ")
        } else {
            let actors_from_body = collect_link_texts_by_href(&doc, &["/actresses/", "/actress/"]);
            if !actors_from_body.is_empty() {
                dedup_strings(actors_from_body).join(", ")
            } else {
                actors_from_head
            }
        };

        // 类型/标签
        let genres_from_detail = extract_detail_link_texts(&doc, &["类型", "類型", "Genre", "Genres"]);
        let tags_from_detail = extract_detail_link_texts(&doc, &["标签", "標籤", "Tag", "Tags"]);
        let mut all_tags = genres_from_detail;
        all_tags.extend(tags_from_detail);
        if all_tags.is_empty() {
            all_tags = collect_link_texts_by_href(&doc, &["/genres/", "/genre/", "/tags/", "/tag/"]);
        }
        let tags_str = dedup_strings(all_tags).join(", ");

        // 系列
        let set_name = extract_detail_link_texts(&doc, &["系列", "Series"])
            .into_iter()
            .next()
            .or_else(|| {
                collect_link_texts_by_href(&doc, &["/series/"]).into_iter().next()
            })
            .unwrap_or_default();

        // 制作人/制作商
        let studio = extract_detail_link_texts(&doc, &["制作人", "製作人", "制作商", "Maker", "Studio"])
            .into_iter()
            .next()
            .or_else(|| {
                collect_link_texts_by_href(&doc, &["/makers/", "/maker/", "/studios/", "/studio/"])
                    .into_iter()
                    .next()
            })
            .unwrap_or_default();

        // 标签（发行商/厂牌）
        let label = extract_detail_link_texts(&doc, &["标签", "Label"])
            .into_iter()
            .find(|t| {
                // 排除已在 tags 中的值，只取 labels/ 链接的
                !tags_str.contains(t.as_str())
            })
            .unwrap_or_default();

        // 导演
        let director = extract_detail_link_texts(&doc, &["导演", "導演", "Director"])
            .into_iter()
            .next()
            .or_else(|| {
                collect_link_texts_by_href(&doc, &["/directors/", "/director/"])
                    .into_iter()
                    .next()
            })
            .unwrap_or_default();

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
            mpaa: "JP-18+".to_string(),
            custom_rating: "JP-18+".to_string(),
            country_code: "JP".to_string(),
            maker: studio,
            label,
            genres: tags_str,
            set_name,
            ..Default::default()
        })
    }
}

// ── 辅助函数 ──

/// 从 `.detail-item > div` 提取字段名→值的映射
///
/// 每行结构：
/// ```html
/// <div>
///   <span>发布日期:</span>
///   <span>2019-10-07</span>
/// </div>
/// ```
fn extract_detail_fields(doc: &Html) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let Ok(row_sel) = Selector::parse(".detail-item > div") else {
        return map;
    };
    let Ok(span_sel) = Selector::parse("span") else {
        return map;
    };

    for row in doc.select(&row_sel) {
        let spans: Vec<_> = row.select(&span_sel).collect();
        if spans.len() < 2 {
            continue;
        }
        let label = spans[0]
            .text()
            .collect::<Vec<_>>()
            .join("")
            .trim()
            .trim_end_matches(':')
            .trim_end_matches('：')
            .trim()
            .to_string();
        // 值：取第二个 span 的纯文本（不含子链接文本时）或链接文本
        let value = spans[1]
            .text()
            .collect::<Vec<_>>()
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if !label.is_empty() && !value.is_empty() {
            map.insert(label, value);
        }
    }
    map
}

/// 从 `.detail-item > div` 中匹配标签名的行，提取其中 `<a>` 链接文本
fn extract_detail_link_texts(doc: &Html, labels: &[&str]) -> Vec<String> {
    let Ok(row_sel) = Selector::parse(".detail-item > div") else {
        return vec![];
    };
    let Ok(span_sel) = Selector::parse("span") else {
        return vec![];
    };
    let Ok(a_sel) = Selector::parse("a") else {
        return vec![];
    };

    let mut result = Vec::new();
    for row in doc.select(&row_sel) {
        let spans: Vec<_> = row.select(&span_sel).collect();
        if spans.is_empty() {
            continue;
        }
        let label = spans[0]
            .text()
            .collect::<Vec<_>>()
            .join("")
            .trim()
            .trim_end_matches(':')
            .trim_end_matches('：')
            .trim()
            .to_string();
        if !labels.iter().any(|l| label.contains(l)) {
            continue;
        }
        // 提取该行所有 a 链接的文本
        for a in row.select(&a_sel) {
            let text: String = a.text().collect::<Vec<_>>().join(" ");
            let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if !cleaned.is_empty() {
                result.push(cleaned);
            }
        }
        // 如果没有 a 链接，取第二个 span 的纯文本
        if result.is_empty() && spans.len() >= 2 {
            let value = spans[1]
                .text()
                .collect::<Vec<_>>()
                .join(" ")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if !value.is_empty() {
                result.push(value);
            }
        }
    }
    result
}

/// 从 og:title 解析标题和演员
///
/// 格式：`{CODE} 在线观看, {ACTOR1}, {TITLE} - 123AV`
fn parse_og_title(raw: &str, code_upper: &str) -> (String, String) {
    let lower = raw.to_lowercase();
    let cleaned = if let Some(pos) = lower.rfind("- 123av") {
        raw[..pos].trim()
    } else if let Some(pos) = lower.rfind("| 123av") {
        raw[..pos].trim()
    } else {
        raw.trim()
    };

    let parts: Vec<&str> = cleaned.split(", ").collect();
    if parts.len() < 2 {
        let title = strip_code_and_suffix(cleaned, code_upper);
        return (title, String::new());
    }

    let title = parts.last().unwrap_or(&"").trim().to_string();

    if parts.len() == 2 {
        let title = strip_code_and_suffix(parts[1], code_upper);
        return (title, String::new());
    }

    // 中间部分是演员
    let actors_str = parts[1..parts.len() - 1]
        .iter()
        .map(|a| a.trim())
        .filter(|a| !a.is_empty())
        .collect::<Vec<_>>()
        .join(", ");

    (title, actors_str)
}

fn strip_code_and_suffix(text: &str, code_upper: &str) -> String {
    text.to_uppercase()
        .replace(code_upper, "")
        .replace("在线观看", "")
        .replace("在線觀看", "")
        .trim_start_matches(|c: char| c == '-' || c == ' ' || c == ',' || c == '、')
        .trim()
        .to_string()
}

fn clean_description(raw: &str, code_upper: &str) -> String {
    let mut text = raw.trim().to_string();
    let patterns = [
        format!("{} 在线观看并免费下载 {}。", code_upper, code_upper),
        format!("{} 在线观看并免费下载 {}。", code_upper, code_upper.to_lowercase()),
        format!("{} 在线观看", code_upper),
    ];
    for pattern in &patterns {
        if let Some(pos) = text.find(pattern.as_str()) {
            text = text[pos + pattern.len()..].trim().to_string();
            break;
        }
    }
    let lower = text.to_lowercase();
    if let Some(pos) = lower.rfind("- 123av") {
        text = text[..pos].trim().to_string();
    }
    text.trim().to_string()
}

fn collect_link_texts_by_href(doc: &Html, href_patterns: &[&str]) -> Vec<String> {
    let Ok(selector) = Selector::parse("a[href]") else {
        return vec![];
    };
    let mut values = Vec::new();
    for link in doc.select(&selector) {
        let href = link.value().attr("href").unwrap_or("");
        if !href_patterns.iter().any(|pattern| href.contains(pattern)) {
            continue;
        }
        let text: String = link.text().collect::<Vec<_>>().join(" ");
        let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if !cleaned.is_empty() {
            values.push(cleaned);
        }
    }
    dedup_strings(values)
}
