//! javxx.to 数据源解析器
//!
//! 详情页 URL 结构稳定：`https://javxx.to/cn/v/{code}`。
//! 当前实现直接请求详情页，并优先在包含“详情”和番号的内容容器中提取字段，
//! 以避免误采集页脚中的全站演员/制作商导航链接。

use super::common::{dedup_strings, select_attr, select_text};
use super::{SearchResult, Source};
use scraper::{ElementRef, Html, Selector};
use url::Url;

pub struct JavXX;

impl Source for JavXX {
    fn name(&self) -> &str {
        "javxx"
    }

    fn build_url(&self, code: &str) -> String {
        format!("https://javxx.to/cn/v/{}", code.to_lowercase())
    }

    fn parse(&self, html: &str, code: &str) -> Option<SearchResult> {
        let doc = Html::parse_document(html);
        let code_upper = code.trim().to_uppercase();
        let base_url = self.build_url(&code_upper);
        let detail_root = find_detail_root(&doc, &code_upper);

        let raw_title = select_text(&doc, "#video-info h1.title")
            .or_else(|| detail_root.and_then(|root| select_text_in(&root, "h1")))
            .or_else(|| select_text(&doc, "h1"))
            .or_else(|| {
                select_attr(&doc, r#"meta[property="og:title"]"#, "content")
                    .map(|t| clean_title(&t))
            })
            .or_else(|| select_text(&doc, "title").map(|t| clean_title(&t)))
            .unwrap_or_default();
        let original_title = clean_title(&raw_title);
        let title = strip_code_prefix(&original_title, &code_upper);
        let sort_title = if original_title.is_empty() {
            code_upper.clone()
        } else {
            format!("{} {}", code_upper, original_title)
        };

        let cover_url = select_attr(&doc, r#"meta[property="og:image"]"#, "content")
            .or_else(|| {
                detail_root.and_then(|root| {
                    select_first_image_in(&root)
                        .filter(|value| is_probably_cover(value, &code_upper))
                })
            })
            .map(|value| resolve_url(&base_url, &value))
            .unwrap_or_default();
        let poster_url = cover_url.clone();

        let detail_text = detail_root
            .map(|root| normalize_text(&root.text().collect::<Vec<_>>().join(" ")))
            .unwrap_or_else(|| select_text(&doc, "body").unwrap_or_default());
        let detail_text = slice_before_related(&detail_text);

        let plot = extract_plot(&detail_text)
            .or_else(|| extract_meta_description(&doc, &code_upper));
        let plot = plot.unwrap_or_default();
        let outline = plot.clone();
        let original_plot = plot.clone();
        let premiered = extract_field(
            &detail_text,
            &["发布日期:", "发布日期:", "Release Date:", "Release date:", "Date:"],
        )
        .unwrap_or_default();
        let duration = extract_field(&detail_text, &["时长:", "Duration:", "长度:"])
            .unwrap_or_default();
        let tagline = if premiered.is_empty() {
            String::new()
        } else {
            format!("发行日期 {}", premiered)
        };

        let actors = detail_root
            .map(|root| collect_link_texts(&root, &["/actresses/"]))
            .unwrap_or_default()
            .join(", ");

        let studio = detail_root
            .and_then(|root| collect_link_texts(&root, &["/makers/"]).into_iter().next())
            .unwrap_or_default();
        let director = detail_root
            .and_then(|root| collect_link_texts(&root, &["/directors/"]).into_iter().next())
            .unwrap_or_default();
        let set_name = detail_root
            .and_then(|root| collect_link_texts(&root, &["/series/"]).into_iter().next())
            .unwrap_or_default();

        let mut tag_values = detail_root
            .map(|root| collect_link_texts(&root, &["/genres/", "/censored", "/uncensored"]))
            .unwrap_or_default();
        if tag_values.is_empty() {
            tag_values = extract_tag_values(&detail_text);
        }
        let tags = tag_values.join(", ");
        let genres = tags.clone();

        let thumbs = Vec::new();

        let page_url = select_attr(&doc, r#"meta[property="og:url"]"#, "content")
            .or_else(|| select_attr(&doc, r#"link[rel="canonical"]"#, "href"))
            .unwrap_or_default();

        if title.is_empty() && cover_url.is_empty() {
            return None;
        }

        Some(SearchResult {
            code: code_upper,
            title,
            actors,
            duration,
            studio: studio.clone(),
            source: self.name().to_string(),
            page_url,
            cover_url,
            poster_url,
            director,
            tags: tags.clone(),
            premiered,
            rating: None,
            thumbs,
            plot,
            outline,
            original_plot,
            original_title: if original_title.is_empty() {
                None
            } else {
                Some(original_title)
            },
            tagline,
            sort_title,
            mpaa: "JP-18+".to_string(),
            custom_rating: "JP-18+".to_string(),
            country_code: "JP".to_string(),
            set_name,
            maker: studio,
            genres,
            remote_cover_url: None,
            ..Default::default()
        })
    }
}

fn find_detail_root<'a>(doc: &'a Html, code_upper: &str) -> Option<ElementRef<'a>> {
    let selectors = [
        "main",
        "article",
        ".video-detail",
        ".detail",
        ".container",
        "section",
        "body",
    ];

    let mut best: Option<(usize, usize, ElementRef<'a>)> = None;
    for selector_str in selectors {
        let Ok(selector) = Selector::parse(selector_str) else {
            continue;
        };
        for element in doc.select(&selector) {
            let text = normalize_text(&element.text().collect::<Vec<_>>().join(" "));
            if text.is_empty() || !text.to_uppercase().contains(code_upper) {
                continue;
            }

            let mut score = 0usize;
            if text.contains("详情") {
                score += 10;
            }
            if text.contains("发布日期") || text.contains("发布日期") {
                score += 10;
            }
            if text.contains("时长") {
                score += 5;
            }
            if text.contains("你可能喜欢") {
                score += 1;
            }

            let text_len = text.len();
            match &best {
                Some((best_score, best_len, _)) if score < *best_score => continue,
                Some((best_score, best_len, _)) if score == *best_score && text_len >= *best_len => {
                    continue
                }
                _ => best = Some((score, text_len, element)),
            }
        }
    }

    best.map(|(_, _, element)| element)
}

fn select_text_in(root: &ElementRef<'_>, selector_str: &str) -> Option<String> {
    let selector = Selector::parse(selector_str).ok()?;
    let element = root.select(&selector).next()?;
    let text = normalize_text(&element.text().collect::<Vec<_>>().join(" "));
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn select_first_image_in(root: &ElementRef<'_>) -> Option<String> {
    let selector = Selector::parse("img").ok()?;
    for image in root.select(&selector) {
        for attr in ["src", "data-src", "data-original"] {
            if let Some(value) = image.value().attr(attr) {
                if !value.trim().is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

fn collect_link_texts(root: &ElementRef<'_>, href_patterns: &[&str]) -> Vec<String> {
    let Ok(selector) = Selector::parse("a[href]") else {
        return vec![];
    };

    let mut values = Vec::new();
    for link in root.select(&selector) {
        let href = link.value().attr("href").unwrap_or("");
        if !href_patterns.iter().any(|pattern| href.contains(pattern)) {
            continue;
        }
        let text = normalize_text(&link.text().collect::<Vec<_>>().join(" "));
        if !text.is_empty() {
            values.push(text);
        }
    }
    dedup_strings(values)
}

fn clean_title(raw_title: &str) -> String {
    raw_title
        .replace(" - JAVXX", "")
        .replace(" | JAVXX", "")
        .replace("JAVXX", "")
        .trim()
        .to_string()
}

fn strip_code_prefix(title: &str, code_upper: &str) -> String {
    let trimmed = title.trim();
    let trimmed_upper = trimmed.to_uppercase();
    if let Some(rest) = trimmed_upper.strip_prefix(code_upper) {
        let byte_index = trimmed.len() - rest.len();
        return trimmed[byte_index..]
            .trim_start_matches(|ch: char| ch == '-' || ch == ':' || ch == ' ' || ch == '　')
            .trim()
            .to_string();
    }

    trimmed
        .replace(code_upper, "")
        .trim_start_matches(|ch: char| ch == '-' || ch == ':' || ch == ' ' || ch == '　')
        .trim()
        .to_string()
}

fn normalize_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn resolve_url(base_url: &str, value: &str) -> String {
    if value.starts_with("http://") || value.starts_with("https://") {
        return value.to_string();
    }
    if value.starts_with("//") {
        return format!("https:{}", value);
    }
    Url::parse(base_url)
        .ok()
        .and_then(|base| base.join(value).ok())
        .map(|url| url.to_string())
        .unwrap_or_else(|| value.to_string())
}

fn slice_before_related(text: &str) -> String {
    for marker in ["你可能喜欢", "猜你喜欢", "相关推荐", "JAVXX 新 热门 最近"] {
        if let Some(index) = text.find(marker) {
            return text[..index].trim().to_string();
        }
    }
    text.trim().to_string()
}

fn extract_plot(text: &str) -> Option<String> {
    let source = if let Some(index) = text.find("详情") {
        text[index + "详情".len()..].trim()
    } else {
        text
    };

    for marker in ["代码:", "Code:", "发布日期:", "发布日期:"] {
        if let Some(index) = source.find(marker) {
            let plot = source[..index].trim().to_string();
            if !plot.is_empty() {
                return Some(plot);
            }
        }
    }

    None
}

/// 从 `<meta name="description">` 或 `og:description` 提取简介（去除模板前后缀）
fn extract_meta_description(doc: &Html, code_upper: &str) -> Option<String> {
    let raw = select_attr(doc, r#"meta[name="description"]"#, "content")
        .or_else(|| select_attr(doc, r#"meta[property="og:description"]"#, "content"))?;

    // 格式："免费在线观看DLDSS-479 JAV，{actors}，{title} missav"
    // 去掉前缀 "免费在线观看{CODE} JAV，" 和后缀 " missav"
    let mut text = raw.as_str();

    // 去掉前缀：匹配 "免费在线观看{CODE} JAV，" 或 "免费在线观看{CODE} JAV,"
    if let Some(pos) = text.find("JAV，").or_else(|| text.find("JAV,")) {
        let skip = if text[pos..].starts_with("JAV，") { "JAV，".len() } else { "JAV,".len() };
        text = text[pos + skip..].trim();
    }

    // 去掉后缀 " missav" / " MissAV"（大小写不敏感）
    let lower = text.to_lowercase();
    if let Some(pos) = lower.rfind("missav") {
        text = text[..pos].trim();
    }

    // 二次清理：如果以逗号开头则去掉
    let text = text.trim_start_matches(|c: char| c == ',' || c == '，' || c == ' ').trim();

    if text.is_empty() || text.to_uppercase() == *code_upper {
        return None;
    }

    Some(text.to_string())
}

fn extract_field(text: &str, labels: &[&str]) -> Option<String> {
    for label in labels {
        let Some(index) = text.find(label) else {
            continue;
        };
        let value = text[index + label.len()..]
            .trim()
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .trim_matches(',')
            .trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

fn extract_tag_values(text: &str) -> Vec<String> {
    let Some(index) = text.find("类别:") else {
        return vec![];
    };
    let after = &text[index + "类别:".len()..];
    let end = ["制作商:", "女演员:", "系列:", "导演:"]
        .iter()
        .filter_map(|marker| after.find(marker))
        .min()
        .unwrap_or(after.len());
    let candidate = &after[..end];
    let values = candidate
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_matches(|ch| ch == '[' || ch == ']'))
        .map(|value| value.to_string())
        .collect::<Vec<_>>();
    dedup_strings(values)
}

fn is_probably_cover(value: &str, code_upper: &str) -> bool {
    let lower = value.to_lowercase();
    lower.contains("cover")
        || lower.contains("poster")
        || lower.contains(&code_upper.to_lowercase())
        || is_image_url(&lower)
}

fn is_image_url(value: &str) -> bool {
    [".jpg", ".jpeg", ".png", ".webp", ".avif"]
        .iter()
        .any(|ext| value.contains(ext))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_extracts_core_fields_from_detail_page() {
        let html = r#"
        <html>
            <head>
                <meta property="og:title" content="DIGI-256 - Hyper Highleg Queen 28 藤井蕾拉">
                <meta property="og:image" content="https://cdn.javxx.to/images/digi-256-cover.jpg">
            </head>
            <body>
                <div id="video-info">
                    <h1 class="title">DIGI-256 - Hyper Highleg Queen 28 藤井蕾拉</h1>
                </div>
                <main>
                    <section class="video-detail">
                        <div class="detail-card">
                            <h2>详情</h2>
                            <p>
                                这个变态的促销女郎喜欢男人的阴茎，她穿着紧身高衩泳衣挑逗男人，然后一个接一个地榨干他们勃起阴茎里的精液。
                                代码:DIGI-256 发布日期:2026-02-21 时长:2:23:32
                                类别:
                                <a href="/cn/censored">有码</a>
                                <a href="/cn/genres/e7ee2e46bf">姐姐</a>
                                <a href="/cn/genres/8db9a42547">屁股恋物癖</a>
                                制作商:<a href="/cn/makers/prestige">PRESTIGE</a>
                                女演员:<a href="/cn/actresses/reira-fujii">藤井蕾拉</a>
                                系列:<a href="/cn/series/hyper-highleg-queen">Hyper Highleg Queen</a>
                            </p>
                            <div class="gallery">
                                <img src="https://cdn.javxx.to/images/digi-256-cover.jpg">
                                <img src="https://cdn.javxx.to/images/digi-256-1.jpg">
                                <img src="https://cdn.javxx.to/images/digi-256-2.jpg">
                            </div>
                        </div>
                        <section><h2>你可能喜欢</h2></section>
                    </section>
                </main>
            </body>
        </html>
        "#;

        let result = JavXX.parse(html, "DIGI-256").expect("应解析成功");

        assert_eq!(result.title, "Hyper Highleg Queen 28 藤井蕾拉");
        assert_eq!(result.original_title.as_deref(), Some("DIGI-256 - Hyper Highleg Queen 28 藤井蕾拉"));
        assert_eq!(result.actors, "藤井蕾拉");
        assert_eq!(result.duration, "2:23:32");
        assert_eq!(result.studio, "PRESTIGE");
        assert_eq!(result.cover_url, "https://cdn.javxx.to/images/digi-256-cover.jpg");
        assert_eq!(result.poster_url, "https://cdn.javxx.to/images/digi-256-cover.jpg");
        assert_eq!(result.premiered, "2026-02-21");
        assert_eq!(result.plot, "这个变态的促销女郎喜欢男人的阴茎，她穿着紧身高衩泳衣挑逗男人，然后一个接一个地榨干他们勃起阴茎里的精液。");
        assert_eq!(result.set_name, "Hyper Highleg Queen");
        assert_eq!(result.tags, "有码, 姐姐, 屁股恋物癖");
        assert_eq!(result.genres, "有码, 姐姐, 屁股恋物癖");
        assert!(result.thumbs.is_empty());
    }

    #[test]
    fn parse_ignores_footer_directory_links() {
        let html = r#"
        <html>
            <body>
                <div id="video-info">
                    <h1 class="title">ABP-123 - 示例标题</h1>
                </div>
                <section class="video-detail">
                    <div>
                        <h2>详情</h2>
                        <p>
                            简介文本。 代码:ABP-123 发布日期:2024-05-06 时长:120分钟
                            制作商:<a href="/cn/makers/s1">S1</a>
                            女演员:<a href="/cn/actresses/yua">三上悠亚</a>
                        </p>
                    </div>
                </section>
                <footer>
                    <a href="/cn/actresses/76579c493f">Nagi Hikaru</a>
                    <a href="/cn/makers/fc2">FC2 Videos</a>
                </footer>
            </body>
        </html>
        "#;

        let result = JavXX.parse(html, "ABP-123").expect("应解析成功");

        assert_eq!(result.actors, "三上悠亚");
        assert_eq!(result.studio, "S1");
    }
}