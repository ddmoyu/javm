//! projectjav.com 数据源解析器
//!
//! 搜索型网站，URL 格式：https://projectjav.com/?searchTerm={CODE}
//! 请求后 reqwest 自动跟随 HTTP 重定向到详情页：/movie/{code}-{id}
//! 详情页结构：
//! - 封面：.movie-detail img[src*="covers"]
//! - 标题：.second-main
//! - 信息：.row > .col-3（标签） + .col-9（值）的行式布局
//! - 演员：a[href*="/actress/"]
//! - 标签：.badge-info a[href*="/tag/"]

use super::common::{dedup_strings, select_all_attr, select_attr, select_text};
use super::{SearchResult, Source};
use scraper::{Html, Selector};

pub struct ProjectJav;

impl Source for ProjectJav {
    fn name(&self) -> &str {
        "projectjav"
    }

    fn build_url(&self, code: &str) -> String {
        format!("https://projectjav.com/?searchTerm={}", code.to_lowercase())
    }

    /// 从搜索结果页提取精确匹配番号的详情页 URL
    fn extract_detail_url(&self, html: &str, code: &str) -> Option<String> {
        let doc = Html::parse_document(html);
        let code_lower = code.to_lowercase();
        // 匹配 href="/movie/{code}-{id}" 格式的链接
        let prefix = format!("/movie/{}-", code_lower);
        let sel = Selector::parse("a[href]").ok()?;
        for el in doc.select(&sel) {
            let href = el.value().attr("href").unwrap_or("");
            if href.starts_with(&prefix) {
                return Some(format!("https://projectjav.com{}", href));
            }
        }
        None
    }

    fn parse(&self, html: &str, code: &str) -> Option<SearchResult> {
        let doc = Html::parse_document(html);
        let code_upper = code.to_uppercase();
        let code_lower = code.to_lowercase();

        // 封面图：优先找 img[src*="covers"]，再 fallback
        let cover_url = select_cover_img(&doc)
            .or_else(|| select_attr(&doc, r#"meta[property="og:image"]"#, "content"))
            .or_else(|| find_cover_image(&doc, &code_upper, &code_lower))
            .unwrap_or_default();

        // 标题：优先 .second-main 容器，其次 h1/meta/title
        let raw_title = select_projectjav_title(&doc)
            .or_else(|| select_attr(&doc, r#"meta[property="og:title"]"#, "content"))
            .or_else(|| select_text(&doc, "title"))
            .unwrap_or_default();

        // 清理标题：去掉番号、网站名等
        let title = raw_title
            .replace(&code_upper, "")
            .replace(&code_lower, "")
            .replace("ProjectJav", "")
            .replace("- High Speed Jav Torrent", "")
            .replace("jav torrents", "")
            .trim_start_matches(|c: char| c == '-' || c == ' ' || c == '　')
            .trim()
            .to_string();

        // 从行式布局 .row > .col-3 + .col-9 提取字段
        let fields = extract_row_fields(&doc);

        // 制作商
        let studio = fields
            .get("Publisher")
            .or_else(|| fields.get("Studio"))
            .or_else(|| fields.get("Maker"))
            .cloned()
            .unwrap_or_default();

        // 发行日期（格式 DD/MM/YYYY，需转换为 YYYY-MM-DD）
        let raw_date = fields
            .get("Date added")
            .or_else(|| fields.get("Release Date"))
            .cloned()
            .unwrap_or_default();
        let premiered = normalize_date(&raw_date);

        // 演员：.actress-item a 中的文本
        let actors = select_actress_names(&doc).join(", ");

        // 标签：.badge-info a 中的文本
        let tags = select_badge_tags(&doc).join(", ");

        // 预览图：优先详情页底部 thumbnail 区块中的原图链接
        let thumbs = select_projectjav_thumbs(&doc);

        if title.is_empty() && cover_url.is_empty() {
            return None;
        }

        Some(SearchResult {
            code: code_upper,
            title,
            actors,
            duration: String::new(),
            studio,
            source: self.name().to_string(),
            cover_url,
            poster_url: String::new(),
            director: String::new(),
            tags,
            premiered,
            rating: None,
            thumbs,
            remote_cover_url: None,
            ..Default::default()
        })
    }
}

// ============ 辅助函数 ============

/// 从详情页查找封面图：img[src*="covers"] 或 img.mw-100
fn select_cover_img(doc: &Html) -> Option<String> {
    // 优先找 src 包含 "covers" 的 img
    let sel = Selector::parse("img").ok()?;
    for el in doc.select(&sel) {
        let src = el.value().attr("src").unwrap_or("");
        if src.contains("/covers/") {
            return Some(src.to_string());
        }
    }
    // fallback: img.mw-100
    let sel2 = Selector::parse("img.mw-100").ok()?;
    doc.select(&sel2)
        .next()
        .and_then(|el| el.value().attr("src"))
        .map(|s| s.to_string())
}

fn select_projectjav_title(doc: &Html) -> Option<String> {
    select_text(doc, ".second-main")
        .or_else(|| select_text(doc, ".second-main h1"))
        .or_else(|| select_text(doc, "h1"))
}

fn select_projectjav_thumbs(doc: &Html) -> Vec<String> {
    let mut thumbs = select_all_attr(doc, r#".thumbnail a[data-featherlight=\"image\"]"#, "href");

    if thumbs.is_empty() {
        thumbs = select_all_attr(doc, ".thumbnail img", "src")
            .into_iter()
            .map(|src| src.split('?').next().unwrap_or(&src).to_string())
            .collect();
    }

    dedup_strings(
        thumbs
            .into_iter()
            .filter(|url| url.contains("/screenshots/") || url.contains("screenshot"))
            .collect(),
    )
}

/// 提取演员名：.actress-item a 的文本
fn select_actress_names(doc: &Html) -> Vec<String> {
    let sel = match Selector::parse(".actress-item a") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    doc.select(&sel)
        .filter_map(|el| {
            let text: String = el.text().collect::<Vec<_>>().join(" ");
            let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if cleaned.is_empty() {
                None
            } else {
                Some(cleaned)
            }
        })
        .collect()
}

/// 提取标签：.badge-info a 的文本
fn select_badge_tags(doc: &Html) -> Vec<String> {
    let sel = match Selector::parse(".badge-info a") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    doc.select(&sel)
        .filter_map(|el| {
            let text: String = el.text().collect::<Vec<_>>().join(" ");
            let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if cleaned.is_empty() {
                None
            } else {
                Some(cleaned)
            }
        })
        .collect()
}

/// 提取行式布局字段：.row 中 .col-3 为标签，.col-9 为值
fn extract_row_fields(doc: &Html) -> std::collections::HashMap<String, String> {
    let mut fields = std::collections::HashMap::new();
    let row_sel = match Selector::parse(".row") {
        Ok(s) => s,
        Err(_) => return fields,
    };
    let col3_sel = Selector::parse(".col-3").unwrap();
    let col9_sel = Selector::parse(".col-9").unwrap();

    for row in doc.select(&row_sel) {
        let label = row
            .select(&col3_sel)
            .next()
            .map(|el| el.text().collect::<Vec<_>>().join(" ").trim().to_string());
        let value = row
            .select(&col9_sel)
            .next()
            .map(|el| el.text().collect::<Vec<_>>().join(" ").trim().to_string());
        if let (Some(l), Some(v)) = (label, value) {
            if !l.is_empty() && !v.is_empty() {
                fields.insert(l, v);
            }
        }
    }
    fields
}

/// 将 DD/MM/YYYY 格式转换为 YYYY-MM-DD
fn normalize_date(raw: &str) -> String {
    let parts: Vec<&str> = raw.split('/').collect();
    if parts.len() == 3 {
        // DD/MM/YYYY -> YYYY-MM-DD
        format!(
            "{}-{}-{}",
            parts[2].trim(),
            parts[1].trim(),
            parts[0].trim()
        )
    } else {
        raw.to_string()
    }
}

/// 在页面图片中查找与番号相关的封面图（fallback）
fn find_cover_image(doc: &Html, code_upper: &str, code_lower: &str) -> Option<String> {
    let sel = Selector::parse("img").ok()?;
    for el in doc.select(&sel) {
        let src = el.value().attr("src").unwrap_or("");
        let alt = el.value().attr("alt").unwrap_or("");
        if src.contains(code_upper)
            || src.contains(code_lower)
            || alt.contains(code_upper)
            || alt.contains(code_lower)
        {
            return Some(src.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_prefers_second_main_for_title() {
        let html = r#"
        <html>
            <head>
                <title>FSDSS-496 - 错误标题</title>
                <meta property="og:title" content="FSDSS-496 - 元标题">
            </head>
            <body>
                <div class="row mb-2 movie-detail">
                    <img src="https://images.projectjav.com/data/covers/121543.jpg" alt="fsdss-496" class="mw-100 mb-2">
                    <div class="row mb-1 second-main">
                        <div class="col-12">
                            FSDSS-496 真实标题
                        </div>
                    </div>
                    <div class="row">
                        <div class="col-3">Publisher</div>
                        <div class="col-9">测试片商</div>
                    </div>
                    <div class="row">
                        <div class="col-3">Date added</div>
                        <div class="col-9">02/10/2022</div>
                    </div>
                    <div class="actress-item col-3 mb-1">
                        <a href="/actress/moe-amatsuka-1728">Moe Amatsuka</a>
                    </div>
                </div>
            </body>
        </html>
        "#;

        let result = ProjectJav.parse(html, "FSDSS-496").expect("应解析成功");

        assert_eq!(result.title, "真实标题");
        assert_eq!(result.studio, "测试片商");
        assert_eq!(result.premiered, "2022-10-02");
        assert_eq!(result.actors, "Moe Amatsuka");
    }

    #[test]
    fn parse_falls_back_to_h1_when_second_main_missing() {
        let html = r#"
        <html>
            <body>
                <img src="https://images.projectjav.com/data/covers/121543.jpg" alt="fsdss-496">
                <h1>FSDSS-496 备用标题</h1>
            </body>
        </html>
        "#;

        let result = ProjectJav.parse(html, "FSDSS-496").expect("应解析成功");

        assert_eq!(result.title, "备用标题");
    }

    #[test]
    fn parse_extracts_thumbnail_preview_images() {
        let html = r#"
        <html>
            <body>
                <div class="row mb-2 movie-detail">
                    <img src="https://images.projectjav.com/data/covers/221127.jpg" alt="doks-663" class="mw-100 mb-2">
                    <div class="row mb-1 second-main">
                        <div class="col-12">
                            <h1>doks-663 working woman's trembling horn masturbation</h1>
                        </div>
                    </div>
                </div>

                <div class="row">
                    <div class="col-md-12 thumbnail text-center">
                        <h3 id="screenshot">Click screenshot to zoom bigger</h3>
                        <a href="https://images.projectjav.com/data/screenshots/221127.jpg" data-featherlight="image">
                            <img src="https://images.projectjav.com/data/screenshots/221127.jpg?width=300" alt="preview" class="mw-100">
                        </a>
                    </div>
                </div>
            </body>
        </html>
        "#;

        let result = ProjectJav.parse(html, "DOKS-663").expect("应解析成功");

        assert_eq!(
            result.thumbs,
            vec!["https://images.projectjav.com/data/screenshots/221127.jpg"]
        );
    }
}
