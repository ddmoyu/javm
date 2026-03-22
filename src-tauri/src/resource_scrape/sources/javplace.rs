//! jav.place 数据源解析器
//!
//! 页面结构：
//! - 封面：meta[property="og:image"] content 或 img.cover
//! - 标题：meta[property="og:title"] content 或 h1/title 标签
//! - 信息：table.table 中 th/td 配对提取日期、时长、演员等
//! - 演员链接：/actors/xxx
//! - 标签链接：/q/xxx
//! - URL 格式：https://jav.place/video/{CODE}

use regex::Regex;
use serde::Deserialize;
use scraper::{Html, Selector};
use super::common::{dedup_strings, extract_head_meta, select_all_attr, select_attr, select_text};
use super::{SearchResult, Source};

pub struct JavPlace;

impl Source for JavPlace {
    fn name(&self) -> &str { "javplace" }

    fn build_url(&self, code: &str) -> String {
        format!("https://jav.place/video/{}", code.to_uppercase())
    }

    fn parse(&self, html: &str, code: &str) -> Option<SearchResult> {
        let doc = Html::parse_document(html);
        let code_upper = code.to_uppercase();

        if !html.to_uppercase().contains(&code_upper) {
            return None;
        }

        // 第一步：从 <head> 提取基础数据
        let head = extract_head_meta(&doc);
        let node = extract_embedded_node(html);

        // 封面图：优先 head，其次页面中的大图
        let cover_url = if !head.cover_url.is_empty() {
            head.cover_url
        } else if let Some(node_cover) = node.as_ref().and_then(|item| item.thumbnail.clone()) {
            node_cover
        } else {
            select_attr(&doc, "img.cover", "src")
                .or_else(|| select_attr(&doc, ".poster img", "src"))
                .or_else(|| select_attr(&doc, "video", "poster"))
                .unwrap_or_default()
        };

        // 标题：优先 head，其次 h1，最后 title 标签
        let raw_title = if let Some(title) = node.as_ref().and_then(|item| item.title.clone()) {
            title
        } else if let Some(title) = extract_h1_title(html) {
            title
        } else if !head.title.is_empty() {
            head.title
        } else {
            select_text(&doc, "h1.title")
                .or_else(|| select_text(&doc, "h1"))
                .or_else(|| select_text(&doc, "title"))
                .unwrap_or_default()
        };

        // 清理标题
        let title = clean_title(&raw_title, code);

        // 从 table 中提取 th/td 配对数据
        let table_data = extract_table_fields(&doc);

        // 发行日期：从表格提取，回退到全文日期匹配
        let premiered = table_data.get("日期")
            .cloned()
            .or_else(|| node.as_ref().and_then(|item| item.created.clone()))
            .or_else(|| {
                let body_text = select_text(&doc, "body").unwrap_or_default();
                extract_date_pattern(&body_text)
            })
            .unwrap_or_default();

        // 时长
        let duration = table_data.get("時長")
            .or_else(|| table_data.get("时长"))
            .cloned()
            .or_else(|| {
                node.as_ref()
                    .and_then(|item| item.duration)
                    .map(|value| format!("{}分钟", value))
            })
            .unwrap_or_default();

        // 制作商
        let studio = table_data.get("製作")
            .or_else(|| table_data.get("制作"))
            .or_else(|| table_data.get("製作商"))
            .or_else(|| table_data.get("制作商"))
            .cloned()
            .or_else(|| node.as_ref().and_then(|item| item.maker.clone()))
            .unwrap_or_default();

        // 导演
        let director = table_data.get("導演")
            .or_else(|| table_data.get("导演"))
            .cloned()
            .or_else(|| node.as_ref().and_then(|item| item.director.clone()))
            .unwrap_or_default();

        let set_name = table_data.get("系列")
            .or_else(|| table_data.get("系列作"))
            .cloned()
            .or_else(|| node.as_ref().and_then(|item| item.serie.clone()))
            .unwrap_or_default();

        // 演员：优先从表格中 "女優" 行的链接提取，回退到 /actors/ 链接
        let actors_list = extract_table_link_texts(&doc, &["女優", "女优", "演員", "演员"])
            .or_else(|| {
                let v = select_all_text_by_href(&doc, "/actors/");
                if v.is_empty() { None } else { Some(v) }
            })
            .or_else(|| {
                node.as_ref().map(|item| split_pipe_or_comma(&item.actors))
                    .filter(|items| !items.is_empty())
            })
            .map(dedup_strings)
            .unwrap_or_default();

        // 标签：优先从表格中 "標籤" 行的链接提取，回退到 /q/ 链接
        let tags_list = extract_table_link_texts(&doc, &["標籤", "标签", "類別", "类别"])
            .or_else(|| {
                let v = select_all_text_by_href(&doc, "/q/")
                    .into_iter()
                    .filter(|item| !looks_like_code_token(item))
                    .collect::<Vec<_>>();
                if v.is_empty() { None } else { Some(v) }
            })
            .or_else(|| {
                node.as_ref().map(|item| split_pipe_or_comma(&item.tags))
                    .filter(|items| !items.is_empty())
            })
            .map(dedup_strings)
            .unwrap_or_default();

        // 预览截图
        let thumbs = dedup_strings(
            select_all_attr(&doc, "img.lazyimage, .preview img, .screenshot img, .gallery img", "src")
                .into_iter()
                .filter(|url| is_preview_image(url))
                .collect(),
        );

        let page_url = node.as_ref()
            .and_then(|item| item.url.clone())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                if head.page_url.is_empty() { None } else { Some(head.page_url) }
            })
            .unwrap_or_else(|| self.build_url(code));

        let plot = extract_ld_json_description(html)
            .unwrap_or_default();

        let actors = actors_list.join(", ");
        let tags = tags_list.join(", ");

        if title.is_empty() && cover_url.is_empty() {
            return None;
        }

        if premiered.is_empty()
            && duration.is_empty()
            && studio.is_empty()
            && director.is_empty()
            && actors.is_empty()
            && tags.is_empty()
        {
            return None;
        }

        Some(SearchResult {
            code: node.as_ref().and_then(|item| item.code.clone()).unwrap_or(code_upper),
            title,
            actors,
            duration,
            studio,
            source: self.name().to_string(),
            page_url,
            cover_url,
            poster_url: String::new(),
            director,
            tags,
            premiered,
            rating: None,
            thumbs,
            plot,
            set_name,
            maker: table_data.get("製作")
                .or_else(|| table_data.get("制作"))
                .cloned()
                .unwrap_or_default(),
            genres: table_data.get("標籤")
                .or_else(|| table_data.get("标签"))
                .cloned()
                .unwrap_or_default(),
            remote_cover_url: None,
            ..Default::default()
        })
    }
}

// ============ 辅助函数 ============

#[derive(Debug, Deserialize)]
struct EmbeddedNode {
    code: Option<String>,
    title: Option<String>,
    serie: Option<String>,
    tags: String,
    duration: Option<u32>,
    thumbnail: Option<String>,
    created: Option<String>,
    url: Option<String>,
    director: Option<String>,
    maker: Option<String>,
    actors: String,
}

fn clean_title(raw: &str, code: &str) -> String {
    raw.replace("- 日本情色視頻", "")
        .replace("- JAV", "")
        .replace("jav.place", "")
        .replace(code, "")
        .replace(&code.to_uppercase(), "")
        .replace(&code.to_lowercase(), "")
        .trim_matches(|c: char| c == '-' || c == '|' || c == ' ' || c == '　')
        .trim()
        .to_string()
}

fn extract_h1_title(html: &str) -> Option<String> {
    let regex = Regex::new(r#"(?s)<h1[^>]*class=\"[^\"]*title[^\"]*\"[^>]*>(.*?)<button"#).ok()?;
    let captures = regex.captures(html)?;
    clean_html_text(captures.get(1)?.as_str())
}

fn extract_embedded_node(html: &str) -> Option<EmbeddedNode> {
    let regex = Regex::new(r#"(?s)node:(\{.*?\}),\s*likedNodes"#).ok()?;
    let captures = regex.captures(html)?;
    serde_json::from_str(captures.get(1)?.as_str()).ok()
}

fn extract_ld_json_description(html: &str) -> Option<String> {
    let regex = Regex::new(r#"(?s)<script type=\"application/ld\+json\">(.*?)</script>"#).ok()?;
    let captures = regex.captures(html)?;
    let value: serde_json::Value = serde_json::from_str(captures.get(1)?.as_str()).ok()?;
    value.get("description")?.as_str().map(|value| value.to_string())
}

fn split_pipe_or_comma(text: &str) -> Vec<String> {
    text.split(['|', ',', '，'])
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .map(|item| item.to_string())
        .collect()
}

fn looks_like_code_token(text: &str) -> bool {
    let cleaned = text.trim();
    if cleaned.is_empty() {
        return false;
    }

    let mut has_ascii_alnum = false;
    for ch in cleaned.chars() {
        if ch.is_ascii_alphanumeric() {
            has_ascii_alnum = true;
            continue;
        }
        if ch == '-' || ch == '_' || ch == '.' || ch.is_whitespace() {
            continue;
        }
        return false;
    }

    has_ascii_alnum && cleaned.chars().any(|ch| ch.is_ascii_digit())
}

fn is_preview_image(url: &str) -> bool {
    (url.contains("/images/image/") || url.contains("/screenshot/") || url.contains("/sample/"))
        && (url.ends_with(".jpg") || url.ends_with(".png") || url.ends_with(".webp") || url.contains(".avif"))
}

fn clean_html_text(text: &str) -> Option<String> {
    let tag_regex = Regex::new(r#"<[^>]+>"#).ok()?;
    let text = tag_regex.replace_all(text, " ");
    let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() { None } else { Some(cleaned) }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_extracts_fields_from_javplace_detail_html() {
        let html = r#"
        <html>
            <head>
                <meta property="og:image" content="https://img.jav.place/images/node/66/665034.avif?1751214209">
                <title>SSIS-392 - jav.place</title>
            </head>
            <body>
                <h1 class="title py-1">
                    メンエスでしようよ 三上悠亜 （ブルーレイディスク） 生寫真3枚付き
                    <button id="app" class="btn btn-success btn-sm">2250</button>
                </h1>
                <div class="row mb-3">
                    <div class="col-md-6">
                        <video poster="https://img.jav.place/images/node/66/665034.avif?1751214209"></video>
                    </div>
                    <div class="col-md-6">
                        <table class="table table-striped table-bordered"><tbody>
                            <tr><th>番號</th><td><a href="/q/SSIS">SSIS</a>-392</td></tr>
                            <tr><th>日期</th><td>2022-05-11</td></tr>
                            <tr><th>時長</th><td>120分鐘</td></tr>
                            <tr><th>製作</th><td><a href="/maker/S1+NO.1+STYLE">S1 NO.1 STYLE</a></td></tr>
                            <tr><th>系列</th><td><a href="/serie/test">超ゴージャスメンズエステ</a></td></tr>
                            <tr><th>標籤</th><td><a href="/q/a">單體作品</a>, <a href="/q/b">偶像</a>, <a href="/q/c">美容院</a>, <a href="/q/d">乳液</a></td></tr>
                            <tr><th>女優</th><td><a href="/actors/mikami">三上悠亞</a></td></tr>
                        </tbody></table>
                    </div>
                </div>
                <img class="lazyimage mr-1 mb-1" src="https://jav.place/images/image/1022/10227303.avif?1751271162">
                <img class="lazyimage mr-1 mb-1" src="https://jav.place/images/image/1022/10227304.avif?1751271162">
                <img class="lazyimage mr-1 mb-1" src="https://img.jav.place/images/node/68/683023.avif?1751213784">
                <script>
                window.addEventListener("load",function(){
                    new Vue({
                        el: '#app',
                        data: {
                            node:{"id":665034,"code":"SSIS-392","title":"メンエスでしようよ 三上悠亜 （ブルーレイディスク） 生寫真3枚付き","serie":"超ゴージャスメンズエステ","tags":"單體作品|偶像|美容院|乳液","duration":120,"thumbnail":"https:\/\/img.jav.place\/images\/node\/66\/665034.avif?1751214209","created":"2022-05-11","url":"https:\/\/javdb.com\/v\/EW89M","director":"","maker":"S1 NO.1 STYLE","actors":"三上悠亞"},
                            likedNodes : {}
                        }
                    })
                });
                </script>
                <script type="application/ld+json">
                {"@context":"http://schema.org","@type":"VideoObject","description":"メンエスでしようよ 三上悠亜 （ブルーレイディスク） 生寫真3枚付き。番号:SSIS-392。女优:三上悠亞。标签:單體作品，偶像，美容院，乳液。时长:120分鐘"}
                </script>
            </body>
        </html>
        "#;

        let result = JavPlace.parse(html, "SSIS-392").expect("should parse javplace detail page");

        assert_eq!(result.code, "SSIS-392");
        assert_eq!(result.title, "メンエスでしようよ 三上悠亜 （ブルーレイディスク） 生寫真3枚付き");
        assert_eq!(result.premiered, "2022-05-11");
        assert_eq!(result.duration, "120分鐘");
        assert_eq!(result.studio, "S1 NO.1 STYLE");
        assert_eq!(result.set_name, "超ゴージャスメンズエステ");
        assert_eq!(result.page_url, "https://javdb.com/v/EW89M");
        assert!(result.actors.contains("三上悠亞"));
        assert!(result.tags.contains("單體作品"));
        assert!(result.tags.contains("偶像"));
        assert_eq!(result.thumbs.len(), 2);
        assert!(result.plot.contains("番号:SSIS-392"));
    }
}
