//! javtiful.com 数据源解析器
//!
//! 两步刮削：
//! 1. `build_url` 构造搜索页 `https://javtiful.com/search/videos?search_query={code}`
//! 2. `extract_detail_url` 从搜索结果中提取详情页链接（`/video/{id}/{code}`）
//! 3. `parse` 从详情页提取数据
//!
//! 详情页字段来源：
//! - 标题/封面: `<head>` 中的 og:title / og:image
//! - 演员: `a[href*="/actress/"]`
//! - 标签: `a[href*="/search/videos?search_query="]`（Tags 区域）
//! - 厂商/频道: `a[href*="/channel/"]`
//! - 分类: `a[href*="/videos/"]`（Category 区域）

use scraper::{Html, Selector};

use super::common::{dedup_strings, extract_head_meta, select_text};
use super::{SearchResult, Source};

pub struct Javtiful;

impl Source for Javtiful {
    fn name(&self) -> &str {
        "javtiful"
    }

    fn build_url(&self, code: &str) -> String {
        format!(
            "https://javtiful.com/search/videos?search_query={}",
            code.to_lowercase()
        )
    }

    fn extract_detail_url(&self, html: &str, code: &str) -> Option<String> {
        let doc = Html::parse_document(html);
        let code_upper = code.trim().to_uppercase();
        let code_lower = code.trim().to_lowercase();

        let sel = match Selector::parse("a[href]") {
            Ok(s) => s,
            Err(_) => return None,
        };

        for el in doc.select(&sel) {
            let href = el.value().attr("href").unwrap_or("");
            if href.is_empty() || !href.contains("/video/") {
                continue;
            }
            let href_upper = href.to_uppercase();
            let href_lower = href.to_lowercase();
            if href_upper.contains(&code_upper) || href_lower.contains(&code_lower) {
                // 确保是完整 URL
                if href.starts_with("http") {
                    return Some(href.to_string());
                }
                return Some(format!("https://javtiful.com{}", href));
            }
        }

        None
    }

    fn parse(&self, html: &str, code: &str) -> Option<SearchResult> {
        let doc = Html::parse_document(html);
        let code_upper = code.trim().to_uppercase();

        // 第一步：从 <head> 提取基础数据
        let head = extract_head_meta(&doc);

        // 标题：优先 head，回退 h1
        let raw_title = if !head.title.is_empty() {
            head.title
        } else {
            select_text(&doc, "h1").unwrap_or_default()
        };
        let cleaned_title = clean_title(&raw_title);
        let title = strip_code_prefix(&cleaned_title, &code_upper);

        // 封面：.player-wrapper 的 background url，回退 head
        let cover_url = extract_player_bg_url(&doc)
            .unwrap_or_else(|| head.cover_url);

        // 页面 URL
        let page_url = head.page_url;

        // 简介/描述
        let raw_desc = head.description;

        // 从 description 提取演员："Starring By: {name}"
        let actors_from_desc = extract_starring(&raw_desc);

        // 演员：优先 body 链接，回退 head description
        let actors_from_body = collect_link_texts_by_href(&doc, "/actress/");
        let actors_str = if actors_from_body.is_empty() {
            actors_from_desc
        } else {
            dedup_strings(actors_from_body).join(", ")
        };

        // 标签：a[href*="/search/videos?search_query="]
        let tags = collect_link_texts_by_href(&doc, "/search/videos?search_query=");
        let tags_str = dedup_strings(tags).join(", ");

        // 频道/厂商：a[href*="/channel/"]
        let studio = collect_link_texts_by_href(&doc, "/channel/")
            .into_iter()
            .next()
            .unwrap_or_default();

        // 分类：a[href*="/videos/"] 且不含 sort=
        let categories = collect_category_texts(&doc);
        let genres = dedup_strings(categories).join(", ");

        // 清理 description 作为 plot（去掉模板前后缀）
        let plot = clean_description(&raw_desc, &code_upper);

        if title.is_empty() && cover_url.is_empty() {
            return None;
        }

        Some(SearchResult {
            code: code_upper,
            title,
            actors: actors_str,
            duration: String::new(),
            studio: studio.clone(),
            source: "javtiful".to_string(),
            page_url,
            cover_url,
            poster_url: String::new(),
            director: String::new(),
            tags: tags_str.clone(),
            premiered: String::new(),
            rating: None,
            thumbs: Vec::new(),
            remote_cover_url: None,
            plot: plot.clone(),
            outline: plot,
            original_plot: String::new(),
            maker: studio,
            label: String::new(),
            set_name: String::new(),
            genres: if genres.is_empty() { tags_str } else { genres },
            ..Default::default()
        })
    }
}

// ── 辅助函数 ──

/// 从 `.player-wrapper` 的 style background url() 提取封面 URL
fn extract_player_bg_url(doc: &Html) -> Option<String> {
    let sel = Selector::parse(".player-wrapper").ok()?;
    let el = doc.select(&sel).next()?;
    let style = el.value().attr("style")?;
    // 匹配 url('...') 或 url("...") 或 url(...)
    let start = style.find("url(")?;
    let after = &style[start + 4..];
    let url = if after.starts_with('\'') || after.starts_with('"') {
        let quote = &after[..1];
        let rest = &after[1..];
        let end = rest.find(quote)?;
        &rest[..end]
    } else {
        let end = after.find(')')?;
        &after[..end]
    };
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    Some(url.to_string())
}

/// 清理标题：去掉 " - Javtiful" 后缀
fn clean_title(raw: &str) -> String {
    let mut t = raw.trim().to_string();
    // 去掉 " - Javtiful" 后缀（大小写不敏感）
    let lower = t.to_lowercase();
    if let Some(pos) = lower.rfind("- javtiful") {
        t = t[..pos].trim().to_string();
    } else if let Some(pos) = lower.rfind("| javtiful") {
        t = t[..pos].trim().to_string();
    }
    t
}

/// 清理标题：去掉 CODE 前缀
fn strip_code_prefix(title: &str, code_upper: &str) -> String {
    let trimmed = title.trim();
    let upper = trimmed.to_uppercase();
    if let Some(rest) = upper.strip_prefix(code_upper) {
        let byte_idx = trimmed.len() - rest.len();
        return trimmed[byte_idx..]
            .trim_start_matches(|c: char| c == '-' || c == ':' || c == ' ' || c == '\u{3000}')
            .trim()
            .to_string();
    }
    trimmed.to_string()
}

/// 从 description 中提取 "Starring By: {name}" 演员名
fn extract_starring(desc: &str) -> String {
    // 格式："Watch JAV MEYD-605 (MEYD605)  Former ... Starring By: Meguri In HD Quality at Javtiful"
    if let Some(pos) = desc.find("Starring By:") {
        let after = &desc[pos + "Starring By:".len()..];
        // 截取到 "In HD" / "In Full HD" / "at Javtiful" 等
        let end = after
            .find(" In HD")
            .or_else(|| after.find(" In Full HD"))
            .or_else(|| after.find(" at Javtiful"))
            .unwrap_or(after.len());
        let name = after[..end].trim();
        if !name.is_empty() {
            return name.to_string();
        }
    }
    String::new()
}

/// 清理 description：去掉 "Watch JAV {CODE} ... " 前缀和 " at Javtiful" 后缀和 "Starring By:" 部分
fn clean_description(desc: &str, code_upper: &str) -> String {
    let mut text = desc.trim();

    // 去掉前缀 "Watch JAV {CODE} ({CODE_NO_DASH})" 部分
    if let Some(pos) = text.find(')') {
        let prefix = &text[..pos + 1];
        if prefix.to_uppercase().contains(code_upper) {
            text = text[pos + 1..].trim();
        }
    } else if let Some(pos) = text.to_uppercase().find(code_upper) {
        let skip = pos + code_upper.len();
        text = text[skip..].trim();
    }

    // 去掉 "Starring By: ..." 部分
    let mut result = text.to_string();
    if let Some(pos) = result.find("Starring By:") {
        // 找到 "Starring By: ... In HD" 或 "Starring By: ... at Javtiful" 然后截掉
        let after = &result[pos..];
        let end = after
            .find(" In HD")
            .or_else(|| after.find(" In Full HD"))
            .or_else(|| after.find(" at Javtiful"))
            .unwrap_or(after.len());
        result = format!("{}{}", &result[..pos], &result[pos + end..]);
    }

    // 去掉后缀 "at Javtiful" / "In HD Quality at Javtiful"
    let lower = result.to_lowercase();
    if let Some(pos) = lower.rfind("at javtiful") {
        result = result[..pos].trim().to_string();
    }
    if let Some(pos) = result.to_lowercase().rfind("in hd quality") {
        result = result[..pos].trim().to_string();
    }
    if let Some(pos) = result.to_lowercase().rfind("in full hd quality") {
        result = result[..pos].trim().to_string();
    }

    // 清理残留标点
    result = result.trim_end_matches(|c: char| c == '.' || c == ' ').trim().to_string();

    result
}

/// 按 href 模式收集链接文本（排除导航区域的重复链接）
fn collect_link_texts_by_href(doc: &Html, pattern: &str) -> Vec<String> {
    let sel = match Selector::parse("a[href]") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let mut values = Vec::new();
    for el in doc.select(&sel) {
        let href = el.value().attr("href").unwrap_or("");
        if !href.contains(pattern) {
            continue;
        }
        let text: String = el
            .text()
            .collect::<Vec<_>>()
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if !text.is_empty() {
            values.push(text);
        }
    }
    dedup_strings(values)
}

/// 收集分类文本：a[href*="/videos/"] 且排除 sort= 和导航链接
fn collect_category_texts(doc: &Html) -> Vec<String> {
    let sel = match Selector::parse(r#"a[href*="/videos/"]"#) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let mut values = Vec::new();
    for el in doc.select(&sel) {
        let href = el.value().attr("href").unwrap_or("");
        // 排除排序和导航链接
        if href.contains("sort=") || href.ends_with("/videos") || href.ends_with("/videos/") {
            continue;
        }
        let text: String = el
            .text()
            .collect::<Vec<_>>()
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if !text.is_empty() {
            values.push(text);
        }
    }
    dedup_strings(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_url_returns_search_page() {
        assert_eq!(
            Javtiful.build_url("DLDSS-479"),
            "https://javtiful.com/search/videos?search_query=dldss-479"
        );
    }

    #[test]
    fn extract_detail_url_finds_video_link() {
        let html = r#"
        <html><body>
        <div class="results">
            <a href="https://javtiful.com/video/105048/dldss-479">
                DLDSS-479 Agonizing! Non-stop cumshots
            </a>
            <a href="https://javtiful.com/trending">Trending</a>
        </div>
        </body></html>
        "#;

        let result = Javtiful.extract_detail_url(html, "DLDSS-479");
        assert_eq!(
            result,
            Some("https://javtiful.com/video/105048/dldss-479".to_string())
        );
    }

    #[test]
    fn extract_detail_url_returns_none_for_no_match() {
        let html = r#"
        <html><body>
        <div class="results">
            <a href="https://javtiful.com/video/999/abc-123">ABC-123 something</a>
        </div>
        </body></html>
        "#;

        assert!(Javtiful.extract_detail_url(html, "DLDSS-479").is_none());
    }

    #[test]
    fn parse_extracts_detail_page() {
        let html = r#"
        <html>
        <head>
            <meta name="description" content="Watch JAV MEYD-605 (MEYD605)  Former Yariman's Aunt Is So Erotic. Starring By: Meguri In HD Quality at Javtiful">
            <meta property="og:title" content="MEYD-605 Former Yariman's Aunt Is So Erotic - Javtiful">
            <meta property="og:image" content="https://javtiful.com/media/videos/tmb/7139/1.jpg">
            <meta property="og:description" content="Watch JAV MEYD-605 (MEYD605)  Former Yariman's Aunt Is So Erotic. Starring By: Meguri In HD Quality at Javtiful">
            <meta property="og:url" content="https://javtiful.com/video/7139/meyd-605">
            <link rel="canonical" href="https://javtiful.com/video/7139/meyd-605">
        </head>
        <body>
        <div class="player-wrapper" style="background: url('https://javtiful.com/media/videos/tmb1/7139/1.jpg') center center / contain no-repeat;"></div>
        <div class="video-detail">
            <h1>MEYD-605 Former Yariman's Aunt Is So Erotic</h1>
            <div class="info">
                <span>Actress</span>
                <a href="/actress/meguri">Meguri</a>
            </div>
            <div class="info">
                <span>Tags</span>
                <a href="/search/videos?search_query=creampie">Creampie</a>
                <a href="/search/videos?search_query=solowork">Solowork</a>
            </div>
            <div class="info">
                <span>Category</span>
                <a href="/videos/big-tits">Big Tits</a>
            </div>
            <div class="info">
                <span>Channel</span>
                <a href="/channel/tameike-goro">Tameike Goro</a>
            </div>
        </div>
        </body>
        </html>
        "#;

        let result = Javtiful.parse(html, "MEYD-605").expect("应解析详情页");
        assert_eq!(result.code, "MEYD-605");
        assert_eq!(result.title, "Former Yariman's Aunt Is So Erotic");
        assert_eq!(
            result.cover_url,
            "https://javtiful.com/media/videos/tmb1/7139/1.jpg"
        );
        assert_eq!(result.actors, "Meguri");
        assert_eq!(result.studio, "Tameike Goro");
        assert!(result.tags.contains("Creampie"));
        assert!(result.tags.contains("Solowork"));
        assert_eq!(result.genres, "Big Tits");
        assert_eq!(
            result.page_url,
            "https://javtiful.com/video/7139/meyd-605"
        );
        assert!(result.plot.contains("Former Yariman"));
    }

    #[test]
    fn parse_head_only_extracts_actors_from_description() {
        let html = r#"
        <html>
        <head>
            <meta property="og:title" content="DLDSS-479 Agonizing! Non-stop Cumshots - Javtiful">
            <meta property="og:image" content="https://javtiful.com/media/videos/tmb/105048/1.jpg">
            <meta property="og:description" content="Watch JAV DLDSS-479 (DLDSS479)  Agonizing! Non-stop Cumshots. Starring By: Mami Zenba In HD Quality at Javtiful">
            <meta property="og:url" content="https://javtiful.com/video/105048/dldss-479">
        </head>
        <body></body>
        </html>
        "#;

        let result = Javtiful.parse(html, "DLDSS-479").expect("应解析 head-only 页面");
        assert_eq!(result.code, "DLDSS-479");
        assert_eq!(result.title, "Agonizing! Non-stop Cumshots");
        assert_eq!(result.actors, "Mami Zenba");
        assert_eq!(
            result.cover_url,
            "https://javtiful.com/media/videos/tmb/105048/1.jpg"
        );
    }

    #[test]
    fn parse_returns_none_for_empty_page() {
        let html = r#"
        <html>
        <head></head>
        <body></body>
        </html>
        "#;

        assert!(Javtiful.parse(html, "DLDSS-479").is_none());
    }
}
