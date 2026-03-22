//! jav.place 数据源解析器
//!
//! 页面结构：
//! - 封面：meta[property="og:image"] content 或 img.cover
//! - 标题：meta[property="og:title"] content 或 h1/title 标签
//! - 信息：table.table 中 th/td 配对提取日期、时长、演员等
//! - 演员链接：/actors/xxx
//! - 标签链接：/q/xxx
//! - URL 格式：https://jav.place/video/{CODE}

use scraper::{Html, Selector};
use super::common::{select_all_attr, select_attr, select_text};
use super::{SearchResult, Source};

pub struct JavPlace;

impl Source for JavPlace {
    fn name(&self) -> &str { "javplace" }

    fn build_url(&self, code: &str) -> String {
        format!("https://jav.place/video/{}", code.to_uppercase())
    }

    fn parse(&self, html: &str, code: &str) -> Option<SearchResult> {
        let doc = Html::parse_document(html);

        // 封面图：优先 og:image，其次页面中的大图
        let cover_url = select_attr(&doc, r#"meta[property="og:image"]"#, "content")
            .or_else(|| select_attr(&doc, "img.cover", "src"))
            .or_else(|| select_attr(&doc, ".poster img", "src"))
            .or_else(|| select_attr(&doc, "video", "poster"))
            .unwrap_or_default();

        // 标题：优先 og:title，其次 h1，最后 title 标签
        let raw_title = select_attr(&doc, r#"meta[property="og:title"]"#, "content")
            .or_else(|| select_text(&doc, "h1"))
            .or_else(|| select_text(&doc, "title"))
            .unwrap_or_default();

        // 清理标题
        let title = raw_title
            .replace(code, "")
            .replace(&code.to_lowercase(), "")
            .replace(&code.to_uppercase(), "")
            .replace("- 日本情色視頻", "")
            .replace("- JAV", "")
            .trim_start_matches(|c: char| c == '-' || c == ' ' || c == '　')
            .trim()
            .to_string();

        // 从 table 中提取 th/td 配对数据
        let table_data = extract_table_fields(&doc);

        // 发行日期：从表格提取，回退到全文日期匹配
        let premiered = table_data.get("日期")
            .or_else(|| table_data.get("日期"))
            .cloned()
            .or_else(|| {
                let body_text = select_text(&doc, "body").unwrap_or_default();
                extract_date_pattern(&body_text)
            })
            .unwrap_or_default();

        // 时长
        let duration = table_data.get("時長")
            .or_else(|| table_data.get("时长"))
            .cloned()
            .unwrap_or_default();

        // 制作商
        let studio = table_data.get("製作")
            .or_else(|| table_data.get("制作"))
            .or_else(|| table_data.get("製作商"))
            .or_else(|| table_data.get("制作商"))
            .cloned()
            .unwrap_or_default();

        // 导演
        let director = table_data.get("導演")
            .or_else(|| table_data.get("导演"))
            .cloned()
            .unwrap_or_default();

        // 演员：优先从表格中 "女優" 行的链接提取，回退到 /actors/ 链接
        let actors = extract_table_link_texts(&doc, &["女優", "女优", "演員", "演员"])
            .or_else(|| {
                let v = select_all_text_by_href(&doc, "/actors/");
                if v.is_empty() { None } else { Some(v) }
            })
            .map(|v| v.join(", "))
            .unwrap_or_default();

        // 标签：优先从表格中 "標籤" 行的链接提取，回退到 /q/ 链接
        let tags = extract_table_link_texts(&doc, &["標籤", "标签", "類別", "类别"])
            .or_else(|| {
                let v = select_all_text_by_href(&doc, "/q/");
                if v.is_empty() { None } else { Some(v) }
            })
            .map(|v| v.join(", "))
            .unwrap_or_default();

        // 预览截图
        let thumbs = select_all_attr(&doc, ".preview img, .screenshot img, .gallery img", "src")
            .into_iter()
            .filter(|u| u.ends_with(".jpg") || u.ends_with(".png") || u.ends_with(".webp"))
            .collect();

        if title.is_empty() && cover_url.is_empty() {
            return None;
        }

        Some(SearchResult {
            code: code.to_uppercase(),
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
            rating: None,
            thumbs,
            remote_cover_url: None,
            ..Default::default()
        })
    }
}

// ============ 辅助函数 ============

/// 从 table 中提取所有 th -> td 的文本映射
fn extract_table_fields(doc: &Html) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let tr_sel = match Selector::parse("table tr") {
        Ok(s) => s,
        Err(_) => return map,
    };
    let th_sel = match Selector::parse("th") {
        Ok(s) => s,
        Err(_) => return map,
    };
    let td_sel = match Selector::parse("td") {
        Ok(s) => s,
        Err(_) => return map,
    };

    for tr in doc.select(&tr_sel) {
        let th_text = tr.select(&th_sel).next().map(|el| {
            el.text().collect::<Vec<_>>().join("").trim().to_string()
        });
        let td_text = tr.select(&td_sel).next().map(|el| {
            el.text().collect::<Vec<_>>().join("").trim().to_string()
        });
        if let (Some(key), Some(val)) = (th_text, td_text) {
            if !key.is_empty() && !val.is_empty() {
                map.insert(key, val);
            }
        }
    }
    map
}

/// 从表格中指定标签行的 td 内提取所有 a 标签文本
fn extract_table_link_texts(doc: &Html, labels: &[&str]) -> Option<Vec<String>> {
    let tr_sel = Selector::parse("table tr").ok()?;
    let th_sel = Selector::parse("th").ok()?;
    let td_sel = Selector::parse("td").ok()?;
    let a_sel = Selector::parse("a").ok()?;

    for tr in doc.select(&tr_sel) {
        let th_text = tr.select(&th_sel).next().map(|el| {
            el.text().collect::<Vec<_>>().join("").trim().to_string()
        });
        if let Some(ref key) = th_text {
            if labels.iter().any(|l| key.contains(l)) {
                if let Some(td) = tr.select(&td_sel).next() {
                    let texts: Vec<String> = td.select(&a_sel)
                        .filter_map(|a| {
                            let text: String = a.text().collect::<Vec<_>>().join("").trim().to_string();
                            if text.is_empty() { None } else { Some(text) }
                        })
                        .collect();
                    if !texts.is_empty() {
                        return Some(texts);
                    }
                }
            }
        }
    }
    None
}

/// 选择所有 href 包含指定路径的 a 标签文本
fn select_all_text_by_href(doc: &Html, href_contains: &str) -> Vec<String> {
    let sel = match Selector::parse("a") {
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

/// 尝试从文本中提取日期格式 YYYY-MM-DD
fn extract_date_pattern(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    for i in 0..text.len().saturating_sub(9) {
        if bytes.get(i).map_or(false, |b| b.is_ascii_digit())
            && bytes.get(i+4) == Some(&b'-')
            && bytes.get(i+7) == Some(&b'-')
        {
            let candidate = &text[i..i+10];
            if candidate.chars().all(|c| c.is_ascii_digit() || c == '-') {
                return Some(candidate.to_string());
            }
        }
    }
    None
}
