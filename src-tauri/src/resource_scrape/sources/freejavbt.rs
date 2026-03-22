//! freejavbt.com 数据源解析器
//!
//! BT 资源站，页面结构类似 javmenu。
//! - 搜索 URL: `https://freejavbt.com/zh/search/{code}`
//! - 详情页 URL: `https://freejavbt.com/zh/{code}`
//! - 搜索页返回列表，需要通过 `extract_detail_url()` 提取详情页链接后二次请求
//!
//! 详情页结构：
//! - 封面: `meta[property="og:image"]` 或 `img.video-cover`
//! - 标题: `h1` 或 `.video-title`
//! - 演员: `.actress a` 或类似选择器
//! - 标签: `.genre a` 或 `.tag a`
//! - 日期/时长等: 页面信息区域
//! - 搜索结果列表: `.video-item a` 或类似

use scraper::{Html, Selector};
use super::common::{dedup_strings, select_all_attr, select_all_text, select_attr, select_text};
use super::{SearchResult, Source};

pub struct FreeJavBT;

impl Source for FreeJavBT {
    fn name(&self) -> &str {
        "freejavbt"
    }

    fn build_url(&self, code: &str) -> String {
        // 使用搜索 URL，因为直接番号 URL 不一定存在
        format!("https://freejavbt.com/zh/search/{}", code)
    }

    /// 从搜索结果页提取详情页 URL
    fn extract_detail_url(&self, html: &str, code: &str) -> Option<String> {
        let doc = Html::parse_document(html);
        let code_upper = code.to_uppercase();
        let code_lower = code.to_lowercase();

        // 搜索结果中的视频链接，匹配包含番号的 href
        // 常见选择器: .video-item a, .video a, a[href*="/zh/"]
        let link_selectors = [
            ".video-item a",
            ".video a",
            ".videos .video a",
            "a.video-link",
        ];

        for sel_str in &link_selectors {
            if let Some(url) = find_detail_link(&doc, sel_str, &code_upper, &code_lower) {
                return Some(url);
            }
        }

        // 回退：遍历所有 a 标签，查找 href 包含番号的链接
        let sel = Selector::parse("a[href]").ok()?;
        for el in doc.select(&sel) {
            let href = el.value().attr("href").unwrap_or("");
            let href_upper = href.to_uppercase();
            if (href_upper.contains(&code_upper) || href.contains(&code_lower))
                && href.contains("/zh/")
                && !href.contains("/search/")
            {
                return Some(normalize_url(href));
            }
        }

        None
    }

    fn parse(&self, html: &str, code: &str) -> Option<SearchResult> {
        let doc = Html::parse_document(html);

        // 封面图：优先 og:image，其次 img.video-cover
        let cover_url = select_attr(&doc, r#"meta[property="og:image"]"#, "content")
            .or_else(|| select_attr(&doc, "img.video-cover", "src"))
            .or_else(|| select_attr(&doc, ".poster img", "src"))
            .unwrap_or_default();

        // 标题：优先 h1，其次 .video-title，最后 og:title
        let raw_title = select_text(&doc, "h1")
            .or_else(|| select_text(&doc, ".video-title"))
            .or_else(|| select_attr(&doc, r#"meta[property="og:title"]"#, "content"))
            .unwrap_or_default();

        // 清理标题：去掉番号部分
        let title = raw_title
            .replace(code, "")
            .replace(&code.to_uppercase(), "")
            .replace(&code.to_lowercase(), "")
            .trim_start_matches(|c: char| c == '-' || c == ' ' || c == '　')
            .trim()
            .to_string();

        // 信息区域文本（用于提取日期、时长等）
        let info_text = select_text(&doc, ".video-info, .card-body, .info")
            .unwrap_or_default();

        // 发行日期
        let premiered = extract_after(&info_text, "发佈于:")
            .or_else(|| extract_after(&info_text, "發佈於:"))
            .or_else(|| extract_after(&info_text, "日期:"))
            .or_else(|| extract_after(&info_text, "Release:"))
            .or_else(|| extract_date_pattern(&info_text))
            .unwrap_or_default();

        // 时长
        let duration = extract_after(&info_text, "时长:")
            .or_else(|| extract_after(&info_text, "時長:"))
            .or_else(|| extract_after(&info_text, "Duration:"))
            .unwrap_or_default();

        // 制作商
        let studio = select_all_text(&doc, "a.maker")
            .first()
            .cloned()
            .or_else(|| extract_after(&info_text, "制作商:"))
            .or_else(|| extract_after(&info_text, "製作商:"))
            .unwrap_or_default();

        // 导演
        let director = select_all_text(&doc, "a.director")
            .first()
            .cloned()
            .or_else(|| extract_after(&info_text, "导演:"))
            .or_else(|| extract_after(&info_text, "導演:"))
            .unwrap_or_default();

        // 演员
        let actors = select_all_text(&doc, "a.actress")
            .into_iter()
            .chain(select_all_text(&doc, ".actress a"))
            .collect::<Vec<_>>();
        let actors = dedup_strings(actors).join(", ");

        // 标签
        let tags = select_all_text(&doc, "a.genre")
            .into_iter()
            .chain(select_all_text(&doc, ".genre a"))
            .chain(select_all_text(&doc, ".tag a"))
            .collect::<Vec<_>>();
        let tags = dedup_strings(tags).join(", ");

        // 预览截图
        let thumbs = select_all_attr(&doc, r#"a[data-fancybox="gallery"]"#, "href")
            .into_iter()
            .chain(select_all_attr(&doc, ".preview img, .screenshot img", "src"))
            .collect::<Vec<_>>();
        let thumbs = dedup_strings(thumbs);

        // 至少要有标题或封面才算有效结果
        if title.is_empty() && cover_url.is_empty() {
            return None;
        }

        Some(SearchResult {
            code: code.to_string(),
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

// ============ HTML 解析辅助函数 ============

/// 从文本中提取指定标签后面的值
fn extract_after(text: &str, label: &str) -> Option<String> {
    let pos = text.find(label)?;
    let after = &text[pos + label.len()..];
    let value = after.trim().split_whitespace().next()?;
    if value.is_empty() { None } else { Some(value.to_string()) }
}

/// 尝试从文本中提取日期格式 YYYY-MM-DD
fn extract_date_pattern(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    for i in 0..text.len().saturating_sub(9) {
        if bytes.get(i).map_or(false, |b| b.is_ascii_digit())
            && bytes.get(i + 4) == Some(&b'-')
            && bytes.get(i + 7) == Some(&b'-')
        {
            let candidate = &text[i..i + 10];
            if candidate.chars().all(|c| c.is_ascii_digit() || c == '-') {
                return Some(candidate.to_string());
            }
        }
    }
    None
}

/// 在搜索结果中查找包含番号的详情页链接
fn find_detail_link(doc: &Html, selector_str: &str, code_upper: &str, code_lower: &str) -> Option<String> {
    let sel = Selector::parse(selector_str).ok()?;
    for el in doc.select(&sel) {
        let href = el.value().attr("href").unwrap_or("");
        let href_upper = href.to_uppercase();
        if href_upper.contains(code_upper) || href.contains(code_lower) {
            return Some(normalize_url(href));
        }
        // 也检查链接文本是否包含番号
        let text: String = el.text().collect::<Vec<_>>().join("");
        let text_upper = text.to_uppercase();
        if text_upper.contains(code_upper) && !href.is_empty() {
            return Some(normalize_url(href));
        }
    }
    None
}

/// 将相对 URL 转换为绝对 URL
fn normalize_url(href: &str) -> String {
    if href.starts_with("http") {
        href.to_string()
    } else {
        format!("https://freejavbt.com{}", href)
    }
}

