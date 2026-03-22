//! 3xplanet.com 数据源解析器
//!
//! WordPress 站点，内容区 .tdb_single_content 中：
//! - 每个字段独立 <p> 标签，英文+日文混合标签
//! - 英文：Starring, Studio, Tags
//! - 日文：品番, 発売日, 収録時間, 監督, メーカー, レーベル, ジャンル, 出演者
//! - 封面：img 含 _cover
//! - 预览图：img 含 /screens/
//! - 下载区在 <h1 class="postdownload"> 之后，需要截断

use super::common::{extract_head_meta, select_all_attr, select_text};
use super::{SearchResult, Source};
use scraper::{ElementRef, Html, Selector};
use std::collections::HashMap;

pub struct ThreeXPlanet;

impl Source for ThreeXPlanet {
    fn name(&self) -> &str {
        "3xplanet"
    }

    fn build_url(&self, code: &str) -> String {
        format!("https://3xplanet.com/{}", code.to_lowercase())
    }

    fn parse(&self, html: &str, code: &str) -> Option<SearchResult> {
        let doc = Html::parse_document(html);

        // 第一步：从 <head> 提取基础数据
        let head = extract_head_meta(&doc);
        let spec_fields = extract_spec_fields(&doc);

        // 标题
        let title = select_text(&doc, "h1.tdb-title-text")
            .map(|t| {
                t.replace(code, "")
                    .replace(&code.to_uppercase(), "")
                    .replace(&code.to_lowercase(), "")
                    .trim_start_matches(|c: char| c == '-' || c == ' ' || c == '\u{3000}')
                    .to_string()
            })
            .unwrap_or_default();

        // 提取内容区 <p> 标签文本，在 postdownload 之前截断
        let paragraphs = extract_content_paragraphs(&doc);

        // 从内容区提取所有图片
        let content_images = select_all_attr(&doc, ".tdb_single_content img", "src");

        // 封面图：内容区 cover 图优先，回退 head
        let cover_url = content_images
            .iter()
            .find(|u| u.contains("_cover") || u.contains("cover"))
            .cloned()
            .unwrap_or_else(|| head.cover_url.clone());

        // 预览截图
        let thumbs: Vec<String> = content_images
            .iter()
            .filter(|u| (u.contains("_s.") || u.contains("/screens/")) && !u.contains("_cover"))
            .map(|u| u.replace("/s200/", "/s0/").replace("/s100/", "/s0/"))
            .collect();

        // 演员：日文 出演者 优先
        let actors = find_field(
            &spec_fields,
            &["出演者", "Starring", "Actress", "Cast"],
        )
        .or_else(|| find_field_in_paragraphs(
            &paragraphs,
            &[
                "出演者:",
                "出演者：",
                "Starring:",
                "Starring：",
                "Actress:",
                "Actress：",
                "Cast:",
                "Cast：",
            ],
        ))
        .map(|value| clean_bilingual_value(&value))
        .unwrap_or_default();

        // 制作商：日文 メーカー 优先（真正的制作公司名）
        let studio = find_field(
            &spec_fields,
            &["メーカー", "Maker", "Studio"],
        )
        .or_else(|| find_field_in_paragraphs(
            &paragraphs,
            &[
                "\u{30e1}\u{30fc}\u{30ab}\u{30fc}:",
                "\u{30e1}\u{30fc}\u{30ab}\u{30fc}\u{ff1a}",
                "Maker:",
                "Maker\u{ff1a}",
                "Studio:",
                "Studio\u{ff1a}",
            ],
        ))
        .unwrap_or_default();

        let maker = studio.clone();

        // 发行日期：日文 発売日 优先
        let premiered = find_field(
            &spec_fields,
            &["発売日", "配信開始日", "Release Date", "Release"],
        )
        .or_else(|| find_field_in_paragraphs(
            &paragraphs,
            &[
                "\u{767a}\u{58f2}\u{65e5}:",
                "\u{767a}\u{58f2}\u{65e5}\u{ff1a}",
                "\u{914d}\u{4fe1}\u{958b}\u{59cb}\u{65e5}:",
                "\u{914d}\u{4fe1}\u{958b}\u{59cb}\u{65e5}\u{ff1a}",
                "Release Date:",
                "Release Date\u{ff1a}",
                "Release:",
                "Release\u{ff1a}",
            ],
        ))
        .map(|d| normalize_date(&d))
        .unwrap_or_default();

        // 时长：日文 収録時間 优先
        let duration = find_field(
            &spec_fields,
            &["収録時間", "Duration", "Runtime"],
        )
        .or_else(|| find_field_in_paragraphs(
            &paragraphs,
            &[
                "\u{53ce}\u{9332}\u{6642}\u{9593}:",
                "\u{53ce}\u{9332}\u{6642}\u{9593}\u{ff1a}",
                "Duration:",
                "Duration\u{ff1a}",
                "Runtime:",
                "Runtime\u{ff1a}",
            ],
        ))
        .map(|d| normalize_duration(&d))
        .unwrap_or_default();

        // 导演：日文 監督 优先
        let director = find_field(
            &spec_fields,
            &["監督", "Director"],
        )
        .or_else(|| find_field_in_paragraphs(
            &paragraphs,
            &[
                "\u{76e3}\u{7763}:",
                "\u{76e3}\u{7763}\u{ff1a}",
                "Director:",
                "Director\u{ff1a}",
            ],
        ))
        .map(|value| clean_bilingual_value(&value))
        .unwrap_or_default();

        // 类型：日文 ジャンル 优先
        let tags = find_field(
            &spec_fields,
            &["ジャンル", "Genres", "Genre"],
        )
        .or_else(|| find_field_in_paragraphs(
            &paragraphs,
            &[
                "\u{30b8}\u{30e3}\u{30f3}\u{30eb}:",
                "\u{30b8}\u{30e3}\u{30f3}\u{30eb}\u{ff1a}",
                "Genre:",
                "Genre\u{ff1a}",
            ],
        ))
        .map(|value| clean_bilingual_value(&value))
        .unwrap_or_default();

        let label = find_field(
            &spec_fields,
            &["レーベル", "Label"],
        )
        .or_else(|| find_field_in_paragraphs(
            &paragraphs,
            &["レーベル:", "レーベル：", "Label:", "Label："],
        ))
        .unwrap_or_default();

        let set_name = find_field(
            &spec_fields,
            &["シリーズ", "Series"],
        )
        .or_else(|| find_field_in_paragraphs(
            &paragraphs,
            &["シリーズ:", "シリーズ：", "Series:", "Series："],
        ))
        .map(|value| clean_bilingual_value(&value))
        .unwrap_or_default();

        let genres = tags.clone();

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
            maker,
            label,
            set_name,
            genres,
            ..Default::default()
        })
    }
}

// ============ 辅助函数 ============

/// 提取规格表中的 dt/dd 字段映射，支持中英双语标签。
fn extract_spec_fields(doc: &Html) -> HashMap<String, String> {
    let mut fields = HashMap::new();
    let dl_sel = match Selector::parse("dl") {
        Ok(s) => s,
        Err(_) => return fields,
    };
    let dt_sel = match Selector::parse("dt") {
        Ok(s) => s,
        Err(_) => return fields,
    };
    let dd_sel = match Selector::parse("dd") {
        Ok(s) => s,
        Err(_) => return fields,
    };

    for dl in doc.select(&dl_sel) {
        let dts: Vec<String> = dl.select(&dt_sel).map(|dt| collect_element_text(&dt)).collect();
        let dds: Vec<String> = dl.select(&dd_sel).map(|dd| collect_element_text(&dd)).collect();

        if dts.is_empty() || dts.len() != dds.len() {
            continue;
        }

        for (label, value) in dts.into_iter().zip(dds.into_iter()) {
            if label.is_empty() || value.is_empty() {
                continue;
            }
            for alias in split_spec_label(&label) {
                fields.entry(alias).or_insert_with(|| value.clone());
            }
        }
    }

    fields
}

fn split_spec_label(label: &str) -> Vec<String> {
    label
        .split('/')
        .map(|part| part.trim().trim_end_matches(':').trim_end_matches('：'))
        .filter(|part| !part.is_empty())
        .map(|part| part.to_string())
        .collect()
}

/// 提取内容区中 postdownload 之前的所有 <p> 标签文本
fn extract_content_paragraphs(doc: &Html) -> Vec<String> {
    // 先找到内容区容器
    let content_sel = match Selector::parse(".tdb_single_content") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let content_el = match doc.select(&content_sel).next() {
        Some(el) => el,
        None => return vec![],
    };

    let p_sel = match Selector::parse("p") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    // 收集所有 <p> 文本，遇到含 "~~DOWNLOAD~~" 的就停止（下载区标记）
    let mut paragraphs = Vec::new();
    for p in content_el.select(&p_sel) {
        let text = collect_element_text(&p);
        if text.contains("~~DOWNLOAD~~") || text.contains("~~Download~~") {
            break;
        }
        if !text.is_empty() {
            paragraphs.push(text);
        }
    }
    paragraphs
}

/// 收集元素的纯文本，合并空白
fn collect_element_text(el: &ElementRef) -> String {
    let text: String = el.text().collect::<Vec<_>>().join("");
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 从键值映射中按优先级查找字段值。
fn find_field(fields: &HashMap<String, String>, labels: &[&str]) -> Option<String> {
    for label in labels {
        if let Some(value) = fields.get(*label) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// 从段落列表中查找指定标签的值（先遍历 labels 按优先级，再遍历段落）
fn find_field_in_paragraphs(paragraphs: &[String], labels: &[&str]) -> Option<String> {
    for label in labels {
        for para in paragraphs {
            if para.starts_with(label) {
                let value = para[label.len()..].trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

fn clean_bilingual_value(value: &str) -> String {
    strip_trailing_parenthetical(value).trim().to_string()
}

fn strip_trailing_parenthetical(value: &str) -> &str {
    let trimmed = value.trim();
    if !trimmed.ends_with(')') {
        return trimmed;
    }
    if let Some(index) = trimmed.rfind(" (") {
        return trimmed[..index].trim_end();
    }
    trimmed
}

fn normalize_date(value: &str) -> String {
    value.trim().replace('/', "-").replace('.', "-")
}

fn normalize_duration(value: &str) -> String {
    let trimmed = value.trim();
    let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
    if let Ok(minutes) = digits.parse::<u32>() {
        return format!("{}分钟", minutes);
    }
    if trimmed.ends_with("分") {
        format!("{}钟", trimmed)
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_extracts_bilingual_dl_specs() {
        let html = r#"
        <html>
            <head>
                <meta property="og:image" content="https://cdn.example.com/images/doks663_4k_cover.jpg">
            </head>
            <body>
                <h1 class="tdb-title-text">doks663_4k 働くオンナの●●●●角オナニー</h1>
                <div class="tdb_single_content">
                    <img src="https://cdn.example.com/images/doks663_4k_cover.jpg">
                    <img src="https://cdn.example.com/screens/doks663_4k_s1.jpg">
                    <dl class="xplanet-specs">
                        <dt>配信開始日 / Release Date</dt>
                        <dd>2026/03/01</dd>
                        <dt>収録時間 / Duration</dt>
                        <dd>106分 (106 min)</dd>
                        <dt>出演者 / Actress</dt>
                        <dd>ゆうきすず, 渡来ふう, 朝海凪咲, 音羽美鈴, るるちゃ。 (Asami nagisa, Misuzu Otowa)</dd>
                        <dt>監督 / Director</dt>
                        <dd>助平オムツ (Sukebe Omutsu)</dd>
                        <dt>シリーズ / Series</dt>
                        <dd>働くオンナの●●●●角オナニー (Working Woman's Corner Masturbation)</dd>
                        <dt>メーカー / Studio</dt>
                        <dd>OFFICE K'S</dd>
                        <dt>レーベル / Label</dt>
                        <dd>OFFICE K'S</dd>
                        <dt>ジャンル / Genres</dt>
                        <dd>OL, 痴女, 巨乳, パンスト・タイツ, 4K (4K, Big tits, Office lady)</dd>
                        <dt>品番 / Code</dt>
                        <dd>doks663_4k</dd>
                    </dl>
                </div>
            </body>
        </html>
        "#;

        let result = ThreeXPlanet.parse(html, "doks663_4k").expect("应解析成功");

        assert_eq!(result.title, "働くオンナの●●●●角オナニー");
        assert_eq!(result.premiered, "2026-03-01");
        assert_eq!(result.duration, "106分钟");
        assert_eq!(result.actors, "ゆうきすず, 渡来ふう, 朝海凪咲, 音羽美鈴, るるちゃ。");
        assert_eq!(result.director, "助平オムツ");
        assert_eq!(result.studio, "OFFICE K'S");
        assert_eq!(result.maker, "OFFICE K'S");
        assert_eq!(result.label, "OFFICE K'S");
        assert_eq!(result.set_name, "働くオンナの●●●●角オナニー");
        assert_eq!(result.tags, "OL, 痴女, 巨乳, パンスト・タイツ, 4K");
        assert_eq!(result.genres, "OL, 痴女, 巨乳, パンスト・タイツ, 4K");
        assert_eq!(result.thumbs, vec!["https://cdn.example.com/screens/doks663_4k_s1.jpg"]);
    }

    #[test]
    fn parse_falls_back_to_paragraph_fields() {
        let html = r#"
        <html>
            <body>
                <h1 class="tdb-title-text">ABP-123 示例标题</h1>
                <div class="tdb_single_content">
                    <p>出演者: 演员A, 演员B</p>
                    <p>メーカー: 测试片商</p>
                    <p>発売日: 2024/05/06</p>
                    <p>収録時間: 95分</p>
                    <p>監督: 测试导演</p>
                    <p>ジャンル: 标签A, 标签B</p>
                    <img src="https://cdn.example.com/abp123_cover.jpg">
                </div>
            </body>
        </html>
        "#;

        let result = ThreeXPlanet.parse(html, "ABP-123").expect("应解析成功");

        assert_eq!(result.actors, "演员A, 演员B");
        assert_eq!(result.studio, "测试片商");
        assert_eq!(result.premiered, "2024-05-06");
        assert_eq!(result.duration, "95分钟");
        assert_eq!(result.director, "测试导演");
        assert_eq!(result.tags, "标签A, 标签B");
    }
}
