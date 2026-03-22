//! freejavbt.com 数据源解析器
//!
//! BT 资源站，直接通过番号拼接详情页 URL。
//! - 详情页 URL: `https://freejavbt.com/zh/{code}`
//!
//! 页面 head 中有多组重复的 meta 标签（通用回退 + 视频特定），
//! 通用 meta 排在前面，`select_attr` 只取第一个会命中通用的空数据。
//! 因此必须用 `select_all_attr` 遍历所有 meta 标签，
//! 找到包含视频信息的那个（如 description 中含 "影片番号为"）。
//!
//! description 结构化文本格式：
//!   "影片番号为XXX，影片名是YYY，发佈日期为YYYY-MM-DD，主演女优是A、B、C，
//!    影片时长NNN分钟，由Z拍摄的作品，属于系列作，主题为T1、T2、T3。"
//!
//! body 结构（可能 JS 渲染，作为回退）：
//!   - 信息区: `.single-video-info`
//!   - 导演: `.director a`
//!   - 女优: `a.actress`
//!   - 标签: `a[href*="/genre/"]`

use regex::Regex;
use scraper::Html;
use super::common::{dedup_strings, select_all_attr, select_all_text, select_text};
use super::{SearchResult, Source};

pub struct FreeJavBT;

impl Source for FreeJavBT {
    fn name(&self) -> &str {
        "freejavbt"
    }

    fn build_url(&self, code: &str) -> String {
        // 直接拼接详情页 URL（搜索页是 JS 动态渲染，无法从 HTML 提取视频链接）
        format!("https://freejavbt.com/zh/{}", code)
    }

    fn parse(&self, html: &str, code: &str) -> Option<SearchResult> {
        let doc = Html::parse_document(html);
        let code_upper = code.to_uppercase();
        let html_upper = html.to_uppercase();

        // HTTP 可能拿到广告页/错页；若整页 HTML 连目标番号都不包含，直接判为无效。
        if !html_upper.contains(&code_upper) {
            println!(
                "[freejavbt] 丢弃页面：HTML 不包含目标番号 {}",
                code_upper
            );
            return None;
        }

        // ---- head meta 提取（遍历所有匹配，找到视频特定的那个） ----

        // 封面图：遍历所有 og:image，取第一个非空值
        let cover_url = select_all_attr(&doc, r#"meta[property="og:image"]"#, "content")
            .into_iter()
            .find(|u| !u.is_empty())
            .or_else(|| {
                select_all_attr(&doc, r#"meta[name="twitter:image"]"#, "content")
                    .into_iter()
                    .find(|u| !u.is_empty())
            })
            .unwrap_or_default();

        // description：遍历所有 meta description，找含 "影片番号为" 的视频特定描述
        let desc = select_all_attr(&doc, r#"meta[name="description"]"#, "content")
            .into_iter()
            .find(|d| d.contains("影片番号为") || d.contains("影片名是"))
            .unwrap_or_default();

        // og:title：遍历所有 og:title，找含番号的那个
        let og_title = select_all_attr(&doc, r#"meta[property="og:title"]"#, "content")
            .into_iter()
            .find(|t| t.to_uppercase().contains(&code_upper));

        // ---- body 信息区文本（回退用） ----
        let info_text = select_text(&doc, ".single-video-info")
            .unwrap_or_default();

        // ---- 各字段提取 ----

        // 标题：description > og:title > h1 > <title>
        let title = extract_between(&desc, "影片名是", "，")
            .or_else(|| og_title.map(|t| clean_title(&t, code)).filter(|t| !t.is_empty()))
            .or_else(|| {
                select_text(&doc, "h1")
                    .map(|t| clean_title(&t, code))
                    .filter(|t| !t.is_empty())
            })
            .or_else(|| {
                select_text(&doc, "title")
                    .map(|t| clean_title(&t, code))
                    .filter(|t| !t.is_empty())
            })
            .unwrap_or_default();

        // 发行日期：description > body 文本
        let premiered = extract_between(&desc, "发佈日期为", "，")
            .or_else(|| extract_after(&info_text, "日期:"))
            .or_else(|| extract_labeled_span_value(html, "日期"))
            .or_else(|| extract_date_pattern(&desc))
            .or_else(|| extract_date_pattern(&info_text))
            .unwrap_or_default();

        // 时长：description > body 文本
        let duration = extract_between(&desc, "影片时长", "，")
            .or_else(|| extract_between(&desc, "影片时长", "。"))
            .or_else(|| extract_after(&info_text, "时长:"))
            .or_else(|| extract_labeled_span_value(html, "时长"))
            .unwrap_or_default();

        // 导演：body 选择器
        let director = select_all_text(&doc, ".director a")
            .into_iter()
            .next()
            .or_else(|| extract_block_anchor_text(html, "director"))
            .unwrap_or_default();

        // 制作商：body 选择器
        let studio = select_all_text(&doc, ".maker a")
            .into_iter()
            .chain(select_all_text(&doc, "a.maker"))
            .next()
            .or_else(|| extract_block_anchor_text(html, "maker"))
            .unwrap_or_default();

        // 演员：description > body a.actress
        let actors = extract_between(&desc, "主演女优是", "，")
            .map(|s| s.replace('、', ", "))
            .or_else(|| {
                let list = dedup_strings(select_all_text(&doc, "a.actress"));
                if list.is_empty() { None } else { Some(list.join(", ")) }
            })
            .or_else(|| {
                let list = extract_anchor_texts_by_class(html, "actress");
                if list.is_empty() { None } else { Some(list.join(", ")) }
            })
            .unwrap_or_default();

        // 标签：description > body genre 链接
        let tags = extract_between(&desc, "主题为", "。")
            .map(|s| s.replace('、', ", "))
            .or_else(|| {
                let list = dedup_strings(
                    select_all_text(&doc, r#"a[href*="/genre/"]"#)
                );
                if list.is_empty() { None } else { Some(list.join(", ")) }
            })
            .or_else(|| {
                let list = extract_anchor_texts_by_href(html, "/genre/");
                if list.is_empty() { None } else { Some(list.join(", ")) }
            })
            .unwrap_or_default();

        // 预览截图
        let thumbs = dedup_strings(
            select_all_attr(&doc, r#"a[data-fancybox="gallery"]"#, "href")
                .into_iter()
                .chain(select_all_attr(&doc, ".preview img, .screenshot img", "src"))
                .collect()
        );

        println!(
            "[freejavbt] code={} desc={} info_text={} title='{}' date='{}' duration='{}' director='{}' actors='{}' tags='{}' thumbs={}",
            code,
            !desc.is_empty(),
            !info_text.is_empty(),
            title,
            premiered,
            duration,
            director,
            actors,
            tags,
            thumbs.len()
        );

        // 至少要有标题或封面才算有效结果
        if title.is_empty() && cover_url.is_empty() {
            println!("[freejavbt] 丢弃页面：标题和封面都为空");
            return None;
        }

        // 进一步防止误解析错页：如果关键字段几乎全空，则丢弃结果。
        if premiered.is_empty()
            && duration.is_empty()
            && director.is_empty()
            && actors.is_empty()
            && tags.is_empty()
        {
            println!("[freejavbt] 丢弃页面：关键元数据全部为空");
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

/// 清理标题：去掉番号和常见后缀
fn clean_title(raw: &str, code: &str) -> String {
    raw.replace(code, "")
        .replace(&code.to_uppercase(), "")
        .replace(&code.to_lowercase(), "")
        .replace("免费AV在线看", "")
        .trim_start_matches(|c: char| c == '-' || c == ' ' || c == '　')
        .trim()
        .to_string()
}

/// 从文本中提取两个标记之间的内容
/// 例如 extract_between("影片名是歡迎來到男士美容，发佈日期为...", "影片名是", "，") => "歡迎來到男士美容"
fn extract_between(text: &str, start: &str, end: &str) -> Option<String> {
    let s = text.find(start)?;
    let after = &text[s + start.len()..];
    let value = if let Some(e) = after.find(end) {
        &after[..e]
    } else {
        after
    };
    let trimmed = value.trim();
    if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
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

/// 从文本中提取指定标签后面的值（按空白分割取第一个词）
fn extract_after(text: &str, label: &str) -> Option<String> {
    let pos = text.find(label)?;
    let after = &text[pos + label.len()..];
    let value = after.trim().split_whitespace().next()?;
    if value.is_empty() { None } else { Some(value.to_string()) }
}

fn extract_labeled_span_value(html: &str, label: &str) -> Option<String> {
        let pattern = format!(
                r#"(?s)<div class="single-video-meta[^"]*">.*?<span>\s*{}:(?:&nbsp;|\s)*</span>\s*<span>\s*([^<]+?)\s*</span>"#,
                regex::escape(label)
        );
        let regex = Regex::new(&pattern).ok()?;
        let captures = regex.captures(html)?;
        clean_html_text(captures.get(1)?.as_str())
}

fn extract_block_anchor_text(html: &str, class_name: &str) -> Option<String> {
        let pattern = format!(
                r#"(?s)<div class="single-video-meta[^"]*{}[^"]*">.*?<a[^>]*>(.*?)</a>"#,
                regex::escape(class_name)
        );
        let regex = Regex::new(&pattern).ok()?;
        let captures = regex.captures(html)?;
        clean_html_text(captures.get(1)?.as_str())
}

fn extract_anchor_texts_by_class(html: &str, class_name: &str) -> Vec<String> {
        let pattern = format!(
                r#"(?s)<a[^>]*class="[^"]*{}[^"]*"[^>]*>(.*?)</a>"#,
                regex::escape(class_name)
        );
        let regex = match Regex::new(&pattern) {
                Ok(regex) => regex,
                Err(_) => return vec![],
        };
        dedup_strings(
                regex
                        .captures_iter(html)
                        .filter_map(|captures| captures.get(1).and_then(|m| clean_html_text(m.as_str())))
                        .collect(),
        )
}

fn extract_anchor_texts_by_href(html: &str, href_fragment: &str) -> Vec<String> {
        let pattern = format!(
                r#"(?s)<a[^>]*href="[^"]*{}[^"]*"[^>]*>(.*?)</a>"#,
                regex::escape(href_fragment)
        );
        let regex = match Regex::new(&pattern) {
                Ok(regex) => regex,
                Err(_) => return vec![],
        };
        dedup_strings(
                regex
                        .captures_iter(html)
                        .filter_map(|captures| captures.get(1).and_then(|m| clean_html_text(m.as_str())))
                        .collect(),
        )
}

fn clean_html_text(text: &str) -> Option<String> {
        let tag_regex = Regex::new(r#"<[^>]+>"#).ok()?;
        let text = tag_regex.replace_all(text, " ");
        let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if cleaned.is_empty() { None } else { Some(cleaned) }
}

#[cfg(test)]
mod tests {
        use super::*;

        #[test]
        fn parse_extracts_fields_from_single_video_info_html() {
                let html = r#"
                <html>
                    <head>
                        <meta property="og:image" content="https://example.com/cover.jpg">
                        <meta property="og:title" content="SSIS-392 歡迎來到男士美容 三上悠亞 鲛岛">
                        <meta name="description" content="影片番号为SSIS-392，影片名是歡迎來到男士美容 三上悠亞，发佈日期为2022-05-11，主演女优是鲛岛、三上悠亜、マッスル澤野，影片时长120分钟，由拍摄的作品，属于系列作，主题为偶像、足交、乳液、美容院、过膝袜、4K、无码破解、单体作品。">
                    </head>
                    <body>
                        <div class="single-video-info col-12">
                            <div class="single-video-meta code d-flex">
                                <span>番号:&nbsp;</span><a href="https://freejavbt.com/zh/code/SSIS">SSIS</a><span>-392</span>
                            </div>
                            <div class="single-video-meta d-flex">
                                <span>日期:&nbsp;</span><span>2022-05-11</span>
                            </div>
                            <div class="single-video-meta d-flex">
                                <span>时长:&nbsp;</span><span>120分钟</span>
                            </div>
                            <div class="single-video-meta director d-flex">
                                <span>导演:&nbsp;</span>
                                <a href="https://freejavbt.com/zh/censored/director/5970">TAKE-D</a>
                            </div>
                            <div class="single-video-meta d-flex">
                                <span>类别:&nbsp;</span>
                                <div>
                                    <a href="https://freejavbt.com/zh/censored/genre/32?test">偶像</a>
                                    <a href="https://freejavbt.com/zh/censored/genre/61?test">足交</a>
                                </div>
                            </div>
                            <div class="single-video-meta d-flex">
                                <span>女优:&nbsp;</span>
                                <div>
                                    <a class="actress text-primary" href="https://freejavbt.com/zh/actor/9gAX">鮫島</a>
                                    <a class="actress text-primary" href="https://freejavbt.com/zh/actor/E2Z3M">マッスル澤野</a>
                                    <a class="actress" href="https://freejavbt.com/zh/actor/Av2e">三上悠亜</a>
                                </div>
                            </div>
                        </div>
                    </body>
                </html>
                "#;

                let parser = FreeJavBT;
                let result = parser.parse(html, "SSIS-392").expect("should parse freejavbt snippet");

                assert_eq!(result.premiered, "2022-05-11");
                assert_eq!(result.duration, "120分钟");
                assert_eq!(result.director, "TAKE-D");
                assert_eq!(result.actors, "鲛岛, 三上悠亜, マッスル澤野");
                assert!(result.tags.contains("偶像"));
                assert!(result.tags.contains("足交"));
                assert_eq!(result.cover_url, "https://example.com/cover.jpg");
        }
}