//! jav.sb 数据源解析器
//!
//! `build_url` 直接构造详情页 URL（`/jav/{code}-1-1.html`），一次请求即可完成刮削。
//! `parse` 从 `<head>` meta 标签提取核心数据，从 body 提取预览截图：
//!
//! ### head meta 标签
//! - og:url / canonical → 页面 URL、番号解析
//! - og:title / twitter:title / title → 标题
//! - og:description / twitter:description / description → 结构化字段（番号、日期、时长、演员、标签、剧情）
//! - og:image / twitter:image → 封面
//! - keywords → 补充标签
//!
//! ### body
//! - `a.shot-thumb-link[href]` → 预览截图 (thumbs)
//!
//! 站点受 Cloudflare 保护，因此应配合 WebView 获取。

use super::common::{select_attr, select_text};
use super::{SearchResult, Source};
use scraper::{Html, Selector};

pub struct JavSb;

impl Source for JavSb {
    fn name(&self) -> &str {
        "javsb"
    }

    fn build_url(&self, code: &str) -> String {
        format!("https://jav.sb/jav/{}-1-1.html", code.to_lowercase())
    }

    fn parse(&self, html: &str, code: &str) -> Option<SearchResult> {
        let doc = Html::parse_document(html);
        parse_detail_page(&doc, code)
    }
}

// ── 详情页：从 <head> meta 提取核心数据，从 body 提取预览截图 ──

fn parse_detail_page(doc: &Html, code: &str) -> Option<SearchResult> {
    let requested_code = code.trim().to_uppercase();
    let page_url = select_attr(doc, r#"meta[property="og:url"]"#, "content")
        .or_else(|| select_attr(doc, r#"link[rel="canonical"]"#, "href"))
        .unwrap_or_default();
    let cover_url = select_attr(doc, r#"meta[property="og:image"]"#, "content")
        .or_else(|| select_attr(doc, r#"meta[name="twitter:image"]"#, "content"))
        .unwrap_or_default();

    let raw_title = select_attr(doc, r#"meta[property="og:title"]"#, "content")
        .or_else(|| select_attr(doc, r#"meta[name="twitter:title"]"#, "content"))
        .or_else(|| select_text(doc, "title"))
        .unwrap_or_default();
    let meta_description = select_attr(doc, r#"meta[property="og:description"]"#, "content")
        .or_else(|| select_attr(doc, r#"meta[name="twitter:description"]"#, "content"))
        .or_else(|| select_attr(doc, r#"meta[name="description"]"#, "content"))
        .unwrap_or_default();

    let resolved_code = if page_url.is_empty() {
        extract_code_like_value(&raw_title)
            .or_else(|| extract_code_like_value(&meta_description))
            .unwrap_or_else(|| requested_code.clone())
    } else {
        match extract_code_from_href(&page_url) {
            Some(value) => value,
            None => return None,
        }
    };
    if !is_precise_code_match(&resolved_code, &requested_code) {
        return None;
    }

    let title = clean_title(&raw_title, &resolved_code);
    let premiered = extract_description_value(&meta_description, "發布日期:").unwrap_or_default();
    let duration = extract_description_value(&meta_description, "片長:").unwrap_or_default();
    let tags_list = extract_description_csv(&meta_description, "題材有");
    let actors_list = extract_description_csv(&meta_description, "出演女優:");
    let director = String::new();
    let studio = String::new();
    let category = extract_description_value(&meta_description, "類型:").unwrap_or_default();
    let plot = extract_plot_text(&meta_description);
    let plot = if plot.is_empty() { meta_description.clone() } else { plot };
    let thumbs = extract_shot_thumbs(doc);

    let meta_keywords = select_attr(doc, r#"meta[name="keywords"]"#, "content")
        .unwrap_or_default();
    let mut tags = tags_list.join(", ");
    if !category.is_empty() {
        tags = append_csv_value(&tags, &category);
    }
    for kw in meta_keywords.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
        if !kw.eq_ignore_ascii_case(&resolved_code) && !actors_list.iter().any(|a| a == kw) {
            tags = append_csv_value(&tags, kw);
        }
    }

    if title.is_empty() && cover_url.is_empty() {
        return None;
    }

    Some(SearchResult {
        code: resolved_code.clone(),
        title,
        actors: actors_list.join(", "),
        duration,
        studio: studio.clone(),
        source: "javsb".to_string(),
        page_url,
        cover_url,
        poster_url: String::new(),
        director,
        tags: tags.clone(),
        premiered,
        rating: None,
        thumbs,
        remote_cover_url: None,
        plot: plot.clone(),
        outline: plot.clone(),
        original_plot: meta_description,
        maker: studio,
        genres: tags,
        ..Default::default()
    })
}

fn extract_code_from_href(href: &str) -> Option<String> {
    let path = href
        .split(['?', '#'])
        .next()
        .unwrap_or(href)
        .trim_end_matches('/')
        .trim();

    let slug = path
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .trim_end_matches(".html")
        .trim_end_matches(".HTML");

    let mut parts: Vec<&str> = slug.split('-').filter(|part| !part.is_empty()).collect();
    while parts.len() > 2 && parts[parts.len() - 1].chars().all(|ch| ch.is_ascii_digit()) {
        parts.pop();
    }

    let candidate = parts.join("-").to_uppercase();
    extract_code_like_value(&candidate)
}

fn extract_code_like_value(value: &str) -> Option<String> {
    let upper = value.to_uppercase();
    let chars: Vec<char> = upper.chars().collect();

    for start in 0..chars.len() {
        if !chars[start].is_ascii_alphabetic() {
            continue;
        }

        let prev = if start == 0 { None } else { Some(chars[start - 1]) };
        if prev.is_some_and(|ch| ch.is_ascii_alphanumeric()) {
            continue;
        }

        let mut end = start;
        let mut seen_dash = false;
        let mut seen_digit = false;
        while end < chars.len() {
            let ch = chars[end];
            if ch.is_ascii_alphanumeric() {
                if ch.is_ascii_digit() {
                    seen_digit = true;
                }
                end += 1;
                continue;
            }
            if ch == '-' && end + 1 < chars.len() && chars[end + 1].is_ascii_alphanumeric() {
                seen_dash = true;
                end += 1;
                continue;
            }
            break;
        }

        if !seen_dash || !seen_digit {
            continue;
        }

        let candidate: String = chars[start..end].iter().collect();
        if is_simple_code_form(&candidate) {
            return Some(candidate);
        }
    }

    None
}

fn is_simple_code_form(value: &str) -> bool {
    let mut parts = value.split('-');
    let Some(prefix) = parts.next() else {
        return false;
    };
    let Some(suffix) = parts.next() else {
        return false;
    };

    parts.next().is_none()
        && prefix.chars().all(|ch| ch.is_ascii_alphabetic())
        && !prefix.is_empty()
        && suffix.chars().next().is_some_and(|ch| ch.is_ascii_digit())
        && suffix.chars().all(|ch| ch.is_ascii_alphanumeric())
        && !suffix.is_empty()
}

fn clean_title(raw_title: &str, code: &str) -> String {
    raw_title
        .replace(code, "")
        .replace(&code.to_lowercase(), "")
        .replace(&code.to_uppercase(), "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_start_matches(|c: char| c == '-' || c == ' ' || c == '　')
        .trim()
        .to_string()
}

fn append_csv_value(existing: &str, value: &str) -> String {
    if value.is_empty() {
        return existing.to_string();
    }
    if existing.is_empty() {
        return value.to_string();
    }
    if existing.split(", ").any(|item| item == value) {
        return existing.to_string();
    }
    format!("{}, {}", existing, value)
}

fn extract_description_value(description: &str, marker: &str) -> Option<String> {
    let (_, tail) = description.split_once(marker)?;
    let value = tail
        .split('.')
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches('。')
        .trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn extract_description_csv(description: &str, marker: &str) -> Vec<String> {
    let Some(value) = extract_description_value(description, marker) else {
        return Vec::new();
    };

    value
        .split(',')
        .map(|item| item.trim().trim_matches('。').trim())
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
        .collect()
}

/// 从 body 中提取预览截图 URL
fn extract_shot_thumbs(doc: &Html) -> Vec<String> {
    let sel = match Selector::parse("a.shot-thumb-link[href]") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    doc.select(&sel)
        .filter_map(|el| el.value().attr("href"))
        .filter(|href| !href.is_empty())
        .map(ToString::to_string)
        .collect()
}

/// 从 description 中提取结构化字段之后的剧情简介文本
fn extract_plot_text(description: &str) -> String {
    let markers = ["番號", "發布日期", "類型", "出演女優", "片長", "題材有", "導演", "製作商"];
    let mut last_field_end = 0;
    let mut pos = 0;
    while let Some(dot_pos) = description[pos..].find(". ") {
        let segment = &description[pos..pos + dot_pos];
        if markers.iter().any(|m| segment.contains(m)) {
            last_field_end = pos + dot_pos + 2;
        }
        pos = pos + dot_pos + 2;
    }

    // 最后一段如果是结构化字段，则无剧情可提取
    if pos < description.len() {
        let last_segment = &description[pos..];
        if markers.iter().any(|m| last_segment.contains(m)) {
            return String::new();
        }
    }

    if last_field_end > 0 && last_field_end < description.len() {
        let mut plot = description[last_field_end..].trim().to_string();
        if let Some(idx) = plot.find("立即在") {
            plot = plot[..idx].trim().to_string();
        }
        plot.trim_end_matches("...").trim_end_matches('…').trim().to_string()
    } else {
        String::new()
    }
}

fn is_precise_code_match(haystack: &str, code: &str) -> bool {
    if haystack.is_empty() || code.is_empty() {
        return false;
    }

    let haystack = haystack.to_uppercase();
    let code = code.to_uppercase();
    let mut start = 0usize;

    while let Some(found) = haystack[start..].find(&code) {
        let idx = start + found;
        let prev = haystack[..idx].chars().next_back();
        let tail = &haystack[idx + code.len()..];
        let next = tail.chars().next();
        let prev_ok = prev.map(|ch| !ch.is_ascii_alphanumeric()).unwrap_or(true);
        let next_ok = is_allowed_code_suffix(next, tail);
        if prev_ok && next_ok {
            return true;
        }
        start = idx + code.len();
    }

    false
}

fn is_allowed_code_suffix(next: Option<char>, tail: &str) -> bool {
    match next {
        None => true,
        Some(ch) if ch.is_ascii_alphanumeric() => false,
        Some(ch) if ch != '-' => true,
        Some(_) => {
            let rest = &tail[1..];
            if rest.is_empty() {
                return true;
            }

            if rest.chars().next().is_some_and(char::is_whitespace) {
                return true;
            }

            let page_suffix = rest
                .split(['?', '#'])
                .next()
                .unwrap_or(rest)
                .trim_end_matches('/')
                .trim_end_matches(".HTML")
                .trim_end_matches(".html");

            !page_suffix.is_empty()
                && page_suffix.chars().any(|ch| ch.is_ascii_digit())
                && page_suffix
                    .chars()
                    .all(|ch| ch.is_ascii_digit() || ch == '-')
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_code_from_href_basic() {
        assert_eq!(extract_code_from_href("/jav/start-521-1-1.html").as_deref(), Some("START-521"));
        assert_eq!(extract_code_from_href("/jav/bokd-174c2-1-1.html").as_deref(), Some("BOKD-174C2"));
        assert_eq!(extract_code_from_href("/jav/abc-123d-1-1.html").as_deref(), Some("ABC-123D"));
    }

    #[test]
    fn extract_code_from_href_rejects_variant_slug() {
        assert_eq!(extract_code_from_href("/jav/start-521-uncensored-leak-1-1.html"), None);
        assert_eq!(extract_code_from_href("/jav/start-521-alt-1-1.html"), None);
    }

    #[test]
    fn parse_detail_page_extracts_core_fields_from_head() {
        let html = r#"
        <html>
            <head>
                <title>BOKD-174 為了紀念我們的男女兒畢業 - JAVSB</title>
                <meta property="og:title" content="BOKD-174 為了紀念我們的男女兒畢業">
                <meta property="og:description" content="番號 BOKD-174 線上看. 發布日期: 2020-03-13. 類型: 無碼破解. 出演女優: 橘芹那. 片長: 2:29:22. 題材有偽娘, 變性者.">
                <meta property="og:image" content="https://jav.sb/upload/example.jpg">
                <meta property="og:url" content="https://jav.sb/jav/bokd-174-1-1.html">
            </head>
        </html>
        "#;

        let result = JavSb.parse(html, "BOKD-174").expect("应解析详情页");

        assert_eq!(result.code, "BOKD-174");
        assert_eq!(result.premiered, "2020-03-13");
        assert_eq!(result.duration, "2:29:22");
        assert_eq!(result.actors, "橘芹那");
        assert_eq!(result.director, "");
        assert_eq!(result.studio, "");
        assert!(result.tags.contains("偽娘"));
        assert!(result.tags.contains("無碼破解"));
        assert_eq!(result.thumbs.len(), 0);
        assert!(result.plot.contains("番號 BOKD-174 線上看"));
    }

    #[test]
    fn parse_detail_page_uses_twitter_image_as_cover() {
        let html = r#"
        <html>
            <head>
                <meta property="og:url" content="https://jav.sb/jav/start-521-1-1.html">
                <meta property="og:title" content="START-521 title">
                <meta name="twitter:image" content="https://jav.sb/upload/vod/20260306/2iktuxora2nxmzn53fep9pjalshn69.jpg">
            </head>
        </html>
        "#;

        let result = JavSb.parse(html, "START-521").expect("应解析 twitter:image 封面");
        assert_eq!(
            result.cover_url,
            "https://jav.sb/upload/vod/20260306/2iktuxora2nxmzn53fep9pjalshn69.jpg"
        );
    }

    #[test]
    fn parse_detail_page_rejects_suffix_variant_code() {
        let html = r#"
        <html>
            <head>
                <meta property="og:title" content="START-521 title">
                <meta property="og:url" content="https://jav.sb/jav/start-521-uncensored-leak-1-1.html">
            </head>
        </html>
        "#;

        let result = JavSb.parse(html, "START-521");
        assert!(result.is_none());
    }

    #[test]
    fn parse_detail_page_handles_alphanumeric_suffix_code() {
        let html = r#"
        <html>
            <head>
                <title>BOKD-174C 我們偽娘畢業記念 用春藥射精 大量連續發射大量顏射 橘芹那 - JAVSB</title>
                <meta name="keywords" content="bokd-174c2,橘芹那,偽娘,變性者,單體作品,肛門,高清">
                <meta name="description" content="番號 BOKD-174C2 線上看. 發布日期: 2020-03-13. 類型: 中文字幕. 出演女優: 橘芹那. 片長: 2:29:18. 題材有偽娘, 變性者, 單體作品, 肛門. 我們男人的女兒專屬合約4年！日本最暢銷的變性女演員終於決定畢業了。適合我們男孩女兒的最後拍攝的傑作！... 立即在 JAVSB ...">
                <meta property="og:title" content="BOKD-174C 我們偽娘畢業記念 用春藥射精 大量連續發射大量顏射 橘芹那">
                <meta property="og:description" content="番號 BOKD-174C2 線上看. 發布日期: 2020-03-13. 類型: 中文字幕. 出演女優: 橘芹那. 片長: 2:29:18. 題材有偽娘, 變性者, 單體作品, 肛門. 我們男人的女兒專屬合約4年！日本最暢銷的變性女演員終於決定畢業了。適合我們男孩女兒的最後拍攝的傑作！... 立即在 JAVSB ...">
                <meta property="og:image" content="https://jav.sb/upload/vod/20220924/cyzzvyna0m1ycgnaw681u6vr86tgph.jpg">
                <meta property="og:url" content="https://jav.sb/jav/bokd-174c2-1-1.html">
            </head>
        </html>
        "#;

        let result = JavSb.parse(html, "BOKD-174C2").expect("应解析含字母数字后缀番号的详情页");
        assert_eq!(result.code, "BOKD-174C2");
        assert_eq!(result.premiered, "2020-03-13");
        assert_eq!(result.duration, "2:29:18");
        assert_eq!(result.actors, "橘芹那");
        assert_eq!(
            result.cover_url,
            "https://jav.sb/upload/vod/20220924/cyzzvyna0m1ycgnaw681u6vr86tgph.jpg"
        );
        assert!(result.tags.contains("偽娘"));
        assert!(result.tags.contains("中文字幕"));
        assert!(result.tags.contains("高清"));
        assert!(result.plot.contains("我們男人的女兒"));
        assert!(!result.plot.contains("番號"));
        assert!(!result.plot.contains("立即在"));
    }

    #[test]
    fn parse_ignores_body_thumbnail_cards() {
        let html = r#"
        <html>
            <head>
                <meta property="og:url" content="https://jav.sb/jav/start-521-1-1.html">
                <meta property="og:title" content="START-521 某影片标题">
                <meta property="og:image" content="https://jav.sb/upload/cover.jpg">
                <meta property="og:description" content="番號 START-521 線上看. 發布日期: 2026-03-01. 出演女優: 本莊鈴. 片長: 1:30:00.">
            </head>
            <body>
                <div class="thumbnail group">
                    <a href="/jav/aldn-569-1-1.html"><img alt="ALDN-569 不相关影片"></a>
                    <div class="my-2"><a href="/jav/aldn-569-1-1.html">ALDN-569 妻子突然要求被內射的原因 - 工藤由里</a></div>
                </div>
            </body>
        </html>
        "#;

        let result = JavSb.parse(html, "START-521").expect("应只解析 head");
        assert_eq!(result.code, "START-521");
        assert_eq!(result.actors, "本莊鈴");
        assert!(!result.title.contains("ALDN"));
        assert!(!result.title.contains("工藤由里"));
    }

    #[test]
    fn build_url_returns_detail_page() {
        assert_eq!(
            JavSb.build_url("PKPD-096"),
            "https://jav.sb/jav/pkpd-096-1-1.html"
        );
        assert_eq!(
            JavSb.build_url("BOKD-174C2"),
            "https://jav.sb/jav/bokd-174c2-1-1.html"
        );
    }

    #[test]
    fn parse_detail_page_extracts_shot_thumbs() {
        let html = r#"
        <html>
            <head>
                <meta property="og:url" content="https://jav.sb/jav/pkpd-096-1-1.html">
                <meta property="og:title" content="PKPD-096 某影片">
                <meta property="og:image" content="https://jav.sb/upload/cover.jpg">
                <meta property="og:description" content="番號 PKPD-096 線上看. 發布日期: 2020-06-07. 片長: 2:17:34.">
            </head>
            <body>
                <a href="https://img.18av.mov/img/311468/0.jpg" class="shot-thumb-link block">
                    <img class="shot-thumb" src="https://img.18av.mov/img/311468/0.jpg">
                </a>
                <a href="https://img.18av.mov/img/311468/1.jpg" class="shot-thumb-link block">
                    <img class="shot-thumb" src="https://img.18av.mov/img/311468/1.jpg">
                </a>
                <a href="https://img.18av.mov/img/311468/2.jpg" class="shot-thumb-link block">
                    <img class="shot-thumb" src="https://img.18av.mov/img/311468/2.jpg">
                </a>
            </body>
        </html>
        "#;

        let result = JavSb.parse(html, "PKPD-096").expect("应解析含预览截图的详情页");
        assert_eq!(result.code, "PKPD-096");
        assert_eq!(result.thumbs.len(), 3);
        assert_eq!(result.thumbs[0], "https://img.18av.mov/img/311468/0.jpg");
        assert_eq!(result.thumbs[2], "https://img.18av.mov/img/311468/2.jpg");
    }
}