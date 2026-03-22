//! 数据源通用辅助函数
//!
//! 提取自各数据源解析器中重复出现的公共函数，避免重复代码。

use scraper::{Html, Selector};
use std::collections::HashSet;

/// 选取第一个匹配元素的文本内容
pub fn select_text(doc: &Html, selector_str: &str) -> Option<String> {
    let sel = Selector::parse(selector_str).ok()?;
    let el = doc.select(&sel).next()?;
    let text: String = el.text().collect::<Vec<_>>().join(" ");
    let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() { None } else { Some(cleaned) }
}

/// 选取所有匹配元素的文本内容
pub fn select_all_text(doc: &Html, selector_str: &str) -> Vec<String> {
    let sel = match Selector::parse(selector_str) {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    doc.select(&sel)
        .filter_map(|el| {
            let text: String = el.text().collect::<Vec<_>>().join(" ");
            let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if cleaned.is_empty() { None } else { Some(cleaned) }
        })
        .collect()
}

/// 选取第一个匹配元素的指定属性值
pub fn select_attr(doc: &Html, selector_str: &str, attr: &str) -> Option<String> {
    let sel = Selector::parse(selector_str).ok()?;
    doc.select(&sel)
        .next()
        .and_then(|el| el.value().attr(attr))
        .map(|v| v.to_string())
        .filter(|v| !v.is_empty())
}

/// 选取所有匹配元素的指定属性值
pub fn select_all_attr(doc: &Html, selector_str: &str, attr: &str) -> Vec<String> {
    let sel = match Selector::parse(selector_str) {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    doc.select(&sel)
        .filter_map(|el| el.value().attr(attr).map(|s| s.to_string()))
        .collect()
}

/// 字符串去重（保留顺序）
pub fn dedup_strings(items: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    items
        .into_iter()
        .filter(|s| !s.is_empty() && seen.insert(s.clone()))
        .collect()
}

/// 从 `<head>` 中提取的公共元数据
///
/// 所有数据源解析器的统一第一步：先从 head meta 标签获取基础数据，
/// 然后各数据源再从 body 中提取补充/覆盖数据。
pub struct HeadMeta {
    /// og:image / twitter:image
    pub cover_url: String,
    /// og:url / canonical
    pub page_url: String,
    /// og:title / twitter:title / `<title>`
    pub title: String,
    /// og:description / twitter:description / meta description
    pub description: String,
    /// og:site_name
    pub site_name: String,
    /// meta keywords
    pub keywords: String,
}

/// 从 `<head>` 中提取所有常见 meta 标签数据
pub fn extract_head_meta(doc: &Html) -> HeadMeta {
    let cover_url = select_attr(doc, r#"meta[property="og:image"]"#, "content")
        .or_else(|| select_attr(doc, r#"meta[name="twitter:image"]"#, "content"))
        .unwrap_or_default();

    let page_url = select_attr(doc, r#"meta[property="og:url"]"#, "content")
        .or_else(|| select_attr(doc, r#"link[rel="canonical"]"#, "href"))
        .unwrap_or_default();

    let title = select_attr(doc, r#"meta[property="og:title"]"#, "content")
        .or_else(|| select_attr(doc, r#"meta[name="twitter:title"]"#, "content"))
        .or_else(|| select_text(doc, "title"))
        .unwrap_or_default();

    let description = select_attr(doc, r#"meta[property="og:description"]"#, "content")
        .or_else(|| select_attr(doc, r#"meta[name="twitter:description"]"#, "content"))
        .or_else(|| select_attr(doc, r#"meta[name="description"]"#, "content"))
        .unwrap_or_default();

    let site_name = select_attr(doc, r#"meta[property="og:site_name"]"#, "content")
        .unwrap_or_default();

    let keywords = select_attr(doc, r#"meta[name="keywords"]"#, "content")
        .unwrap_or_default();

    HeadMeta {
        cover_url,
        page_url,
        title,
        description,
        site_name,
        keywords,
    }
}
