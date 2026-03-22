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
