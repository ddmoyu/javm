//! javmenu.com 数据源解析器
//!
//! 页面结构（服务端渲染，无需 JS）：
//! - 封面：meta[property="og:image"] content
//! - 番号：.card-body .code a + span
//! - 标题：h1.display-5 strong 文本
//! - 发行日期：.card-body 中 "发佈于:" 后的 span
//! - 时长：.card-body 中 "时长:" 后的 span
//! - 类别：a.genre 文本
//! - 女优：a.actress 文本
//! - 预览图：a[data-fancybox="gallery"] href（大图）

use scraper::Html;
use super::common::{select_all_attr, select_all_text, select_attr, select_text};
use super::{SearchResult, Source};

pub struct Javmenu;

impl Source for Javmenu {
    fn name(&self) -> &str { "javmenu" }

    fn build_url(&self, code: &str) -> String {
        format!("https://javmenu.com/zh/{}", code)
    }

    fn parse(&self, html: &str, code: &str) -> Option<SearchResult> {
        let doc = Html::parse_document(html);

        // 封面图：og:image
        let cover_url = select_attr(&doc, r#"meta[property="og:image"]"#, "content")
            .unwrap_or_default();

        // 标题：h1.display-5 strong 的文本
        let raw_title = select_text(&doc, "h1.display-5 strong").unwrap_or_default();
        // 标题中包含番号和 "免费AV在线看"，需要清理
        let title = raw_title
            .replace("免费AV在线看", "")
            .replace(code, "")
            .trim()
            .to_string();

        // card-body 区域解析
        let card_text = select_text(&doc, ".card-body").unwrap_or_default();

        // 发行日期：在 "发佈于:" 后面
        let premiered = extract_after(&card_text, "发佈于:")
            .unwrap_or_default();

        // 时长
        let duration = extract_after(&card_text, "时长:")
            .unwrap_or_default();

        // 类别/标签
        let tags = select_all_text(&doc, "a.genre").join(", ");

        // 女优
        let actors = select_all_text(&doc, "a.actress").join(", ");

        // 制作商
        let studio = select_all_text(&doc, "a.maker")
            .first().cloned().unwrap_or_default();

        // 导演
        let director = select_all_text(&doc, "a.director")
            .first().cloned().unwrap_or_default();

        // 预览截图（大图链接）
        let thumbs = select_all_attr(&doc, r#"a[data-fancybox="gallery"]"#, "href");

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
/// 例如 extract_after("发佈于: 2020-12-07 时长: 480分钟", "发佈于:") => "2020-12-07"
fn extract_after(text: &str, label: &str) -> Option<String> {
    let pos = text.find(label)?;
    let after = &text[pos + label.len()..];
    let value = after.trim().split_whitespace().next()?;
    if value.is_empty() { None } else { Some(value.to_string()) }
}
