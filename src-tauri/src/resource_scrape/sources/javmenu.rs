//! javmenu.com 数据源解析器
//!
//! 页面 head 中存在重复的 title / meta 标签，不能只取第一个；
//! body `.card-body` 同时提供稳定的结构化兜底数据。
//!
//! 提取策略：
//! - head：遍历所有 og:title / description / og:image，优先匹配包含番号的项
//! - body：`.card-body` 里的日期、时长、导演、系列、类别、女优作为稳定兜底

use regex::Regex;
use scraper::Html;
use super::common::{dedup_strings, select_all_attr, select_all_text, select_text};
use super::{SearchResult, Source};

pub struct Javmenu;

impl Source for Javmenu {
    fn name(&self) -> &str { "javmenu" }

    fn build_url(&self, code: &str) -> String {
        format!("https://javmenu.com/zh/{}", code)
    }

    fn parse(&self, html: &str, code: &str) -> Option<SearchResult> {
        let doc = Html::parse_document(html);
        let code_upper = code.to_uppercase();

        if !html.to_uppercase().contains(&code_upper) {
            return None;
        }

        // 重复 head 场景下，遍历所有同名 meta，优先选择包含目标番号的项。
        let cover_url = select_all_attr(&doc, r#"meta[property="og:image"]"#, "content")
            .into_iter()
            .find(|value| !value.is_empty())
            .or_else(|| {
                select_all_attr(&doc, r#"meta[name="twitter:image"]"#, "content")
                    .into_iter()
                    .find(|value| !value.is_empty())
            })
            .unwrap_or_default();

        let desc = select_all_attr(&doc, r#"meta[name="description"]"#, "content")
            .into_iter()
            .find(|value| value.contains("影片番号为") || value.contains("影片名是"))
            .unwrap_or_default();

        let og_title = select_all_attr(&doc, r#"meta[property="og:title"]"#, "content")
            .into_iter()
            .find(|value| value.to_uppercase().contains(&code_upper));

        // 标题：description > og:title > h1/body > title
        let title = extract_between(&desc, "影片名是", "，")
            .or_else(|| og_title.map(|value| clean_title(&value, code)).filter(|value| !value.is_empty()))
            .or_else(|| select_text(&doc, "h1.display-5 strong").map(|value| clean_title(&value, code)).filter(|value| !value.is_empty()))
            .or_else(|| select_text(&doc, "title").map(|value| clean_title(&value, code)).filter(|value| !value.is_empty()))
            .unwrap_or_default();

        // card-body 区域解析
        let card_text = select_text(&doc, ".card-body").unwrap_or_default();

        // 发行日期：description > card-body > 原始 HTML
        let premiered = extract_between(&desc, "发佈日期为", "，")
            .or_else(|| extract_after(&card_text, "发佈于:"))
            .or_else(|| extract_labeled_span_value(html, "发佈于"))
            .unwrap_or_default();

        // 时长：description > card-body > 原始 HTML
        let duration = extract_between(&desc, "影片时长", "，")
            .or_else(|| extract_between(&desc, "影片时长", "。"))
            .or_else(|| extract_after(&card_text, "时长:"))
            .or_else(|| extract_labeled_span_value(html, "时长"))
            .unwrap_or_default();

        // 类别/标签
        let tags = extract_between(&desc, "主题为", "。")
            .map(|value| value.replace('、', ", "))
            .or_else(|| {
                let list = dedup_strings(select_all_text(&doc, "a.genre"));
                if list.is_empty() {
                    let list = extract_anchor_texts_by_class(html, "genre");
                    if list.is_empty() { None } else { Some(list.join(", ")) }
                } else {
                    Some(list.join(", "))
                }
            })
            .unwrap_or_default();

        // 女优
        let actors = extract_between(&desc, "主演女优是", "，")
            .map(|value| value.replace('、', ", "))
            .or_else(|| {
                let list = dedup_strings(select_all_text(&doc, "a.actress"));
                if list.is_empty() {
                    let list = extract_anchor_texts_by_class(html, "actress");
                    if list.is_empty() { None } else { Some(list.join(", ")) }
                } else {
                    Some(list.join(", "))
                }
            })
            .unwrap_or_default();

        // 制作商
        let studio = select_all_text(&doc, "a.maker")
            .into_iter()
            .next()
            .or_else(|| extract_block_anchor_text(html, "maker"))
            .unwrap_or_default();

        // 导演：真实 DOM 是 .director a，不是 a.director
        let director = select_all_text(&doc, ".director a")
            .into_iter()
            .next()
            .or_else(|| extract_block_anchor_text(html, "director"))
            .unwrap_or_default();

        // 预览截图（大图链接）
        let thumbs = select_all_attr(&doc, r#"a[data-fancybox="gallery"]"#, "href");

        // 至少要有标题或封面才算有效结果
        if title.is_empty() && cover_url.is_empty() {
            return None;
        }

        if premiered.is_empty()
            && duration.is_empty()
            && director.is_empty()
            && actors.is_empty()
            && tags.is_empty()
        {
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

fn clean_title(raw: &str, code: &str) -> String {
        raw.replace("世界上最齊全的日本AV資料庫", "")
                .replace("世界上最齐全的日本AV资料库", "")
                .replace("JAV目錄大全", "")
                .replace("JAV目录大全", "")
                .replace("免费AV在线看", "")
                .replace(code, "")
                .replace(&code.to_uppercase(), "")
                .replace(&code.to_lowercase(), "")
                .trim_matches(|c: char| c == '-' || c == '|' || c == ' ' || c == '　')
                .trim()
                .to_string()
}

fn extract_between(text: &str, start: &str, end: &str) -> Option<String> {
        let start_pos = text.find(start)?;
        let after = &text[start_pos + start.len()..];
        let value = if let Some(end_pos) = after.find(end) {
                &after[..end_pos]
        } else {
                after
        };
        let trimmed = value.trim();
        if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
}

/// 从文本中提取指定标签后面的值
/// 例如 extract_after("发佈于: 2020-12-07 时长: 480分钟", "发佈于:") => "2020-12-07"
fn extract_after(text: &str, label: &str) -> Option<String> {
    let pos = text.find(label)?;
    let after = &text[pos + label.len()..];
    let value = after.trim().split_whitespace().next()?;
    if value.is_empty() { None } else { Some(value.to_string()) }
}

fn extract_labeled_span_value(html: &str, label: &str) -> Option<String> {
        let pattern = format!(
                r#"(?s)<div class="[^"]*d-flex[^"]*">.*?<span[^>]*>\s*{}:(?:&nbsp;|\s)*</span>\s*<span[^>]*>\s*([^<]+?)\s*</span>"#,
                regex::escape(label)
        );
        let regex = Regex::new(&pattern).ok()?;
        let captures = regex.captures(html)?;
        clean_html_text(captures.get(1)?.as_str())
}

fn extract_block_anchor_text(html: &str, class_name: &str) -> Option<String> {
        let pattern = format!(
                r#"(?s)<div class="[^"]*{}[^"]*">.*?<a[^>]*>(.*?)</a>"#,
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
        fn parse_extracts_fields_from_javmenu_detail_html() {
                let html = r#"
                <html>
                    <head>
                        <title>SSIS-392 歡迎來到男士美容 三上悠亞 鲛岛</title>
                        <meta name="description" content="影片番号为SSIS-392，影片名是歡迎來到男士美容 三上悠亞，发佈日期为2022-05-11，主演女优是鲛岛、三上悠亜、マッスル澤野，影片时长120分钟，由拍摄的作品，属于系列作，主题为偶像、足交、乳液。">
                        <meta property="og:title" content="SSIS-392 歡迎來到男士美容 三上悠亞 鲛岛">
                        <meta property="og:image" content="https://example.com/cover.jpg">
                        <title>JAV目錄大全 | JAV目錄大全 | 世界上最齊全的日本AV資料庫</title>
                        <meta property="og:title" content="JAV目錄大全 | JAV目錄大全">
                    </head>
                    <body>
                        <div class="card rounded">
                            <div class="card-body">
                                <div class="code d-flex mt-3">
                                    <span>番号:&nbsp;</span><a href="https://javmenu.com/zh/code/SSIS">SSIS</a><span>-392</span>
                                </div>
                                <div class="d-flex mt-1"><span>发佈于:&nbsp;</span><span>2022-05-11</span></div>
                                <div class="d-flex mt-1"><span>时长:&nbsp;</span><span>120分钟</span></div>
                                <div class="director d-flex"><span>导演:&nbsp;</span><a href="https://javmenu.com/zh/censored/director/5970"><span>TAKE-D</span></a></div>
                                <div class="d-flex mt-1">
                                    <span class="white-space-nowrap">类别:&nbsp;</span>
                                    <div>
                                        <a class="genre" href="https://javmenu.com/zh/censored/genre/32">偶像</a>
                                        /
                                        <a class="genre" href="https://javmenu.com/zh/censored/genre/61">足交</a>
                                    </div>
                                </div>
                                <div class="d-flex mt-1">
                                    <span>女优:&nbsp;</span>
                                    <div>
                                        <a class="actress text-primary" href="https://javmenu.com/zh/actor/9gAX">鲛岛</a>
                                        /
                                        <a class="actress" href="https://javmenu.com/zh/actor/Av2e">三上悠亜</a>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </body>
                </html>
                "#;

                let parser = Javmenu;
                let result = parser.parse(html, "SSIS-392").expect("should parse javmenu snippet");

                assert_eq!(result.premiered, "2022-05-11");
                assert_eq!(result.duration, "120分钟");
                assert_eq!(result.director, "TAKE-D");
                assert_eq!(result.actors, "鲛岛, 三上悠亜, マッスル澤野");
                assert!(result.tags.contains("偶像"));
                assert!(result.tags.contains("足交"));
                assert_eq!(result.cover_url, "https://example.com/cover.jpg");
        }
}
