//! jav.guru 数据源解析器
//!
//! WordPress 站点，需要两步刮削：
//! 1. `build_url` 构造搜索页 `https://jav.guru/?s={code}`
//! 2. `extract_detail_url` 从搜索结果中提取详情页链接
//! 3. `parse` 从详情页提取数据
//!
//! 详情页结构（body）：
//! - 标题: `h1.titl`，格式为 `[CODE] title`
//! - 封面: `.large-screenimg img`
//! - Movie Information: `.infoleft ul li`，每个 li 含 `<strong>` 标签名 + 值/链接
//! - 截图: `.wp-content img`
//! - 剧情: `.wp-content p` 文本段落

use scraper::{Html, Selector};
use std::collections::HashSet;

use super::common::{dedup_strings, select_attr, select_text};
use super::{SearchResult, Source};

pub struct JavGuru;

impl Source for JavGuru {
    fn name(&self) -> &str {
        "javguru"
    }

    fn build_url(&self, code: &str) -> String {
        format!("https://jav.guru/?s={}", code.to_uppercase())
    }

    fn extract_detail_url(&self, html: &str, code: &str) -> Option<String> {
        let doc = Html::parse_document(html);
        let code_upper = code.trim().to_uppercase();
        let code_lower = code.trim().to_lowercase();

        // 搜索结果中的链接选择器
        let selectors = [
            "article a[href]",
            ".post-thumbnail a[href]",
            "h2 a[href]",
            "a[href]",
        ];

        let mut best: Option<(String, i32)> = None;

        for sel_str in &selectors {
            let sel = match Selector::parse(sel_str) {
                Ok(s) => s,
                Err(_) => continue,
            };

            for el in doc.select(&sel) {
                let href = el.value().attr("href").unwrap_or("");
                if href.is_empty() || !href.contains("jav.guru/") {
                    continue;
                }
                // 跳过搜索页、标签页、分类页等
                if href.contains("/?s=")
                    || href.contains("/tag/")
                    || href.contains("/category/")
                    || href.contains("/maker/")
                    || href.contains("/actress/")
                    || href.contains("/actor/")
                    || href.contains("/director/")
                    || href.contains("/series/")
                    || href.contains("/studio/")
                    || href.contains("/page/")
                {
                    continue;
                }

                let href_upper = href.to_uppercase();
                let text: String = el.text().collect::<Vec<_>>().join(" ").to_uppercase();

                // 必须在 href 或文本中包含番号
                let href_has_code = href_upper.contains(&code_upper)
                    || href.contains(&code_lower);
                let text_has_code = text.contains(&code_upper);

                if !href_has_code && !text_has_code {
                    continue;
                }

                // 排除变体（-MR、English subbed 等）
                let slug = href.rsplit('/').find(|s| !s.is_empty()).unwrap_or("");
                let slug_upper = slug.to_uppercase();
                let is_variant = slug_upper.contains("ENGLISH-SUBBED")
                    || slug_upper.contains("UNCENSORED")
                    || slug_upper.contains("DECENSORED")
                    || slug_upper.contains("LEAKED");
                // 检查番号变体如 JUR-448-MR
                let code_dash = format!("{}-", code_upper);
                let has_code_variant = slug_upper.contains(&code_dash)
                    && !slug_upper.starts_with(&format!(
                        "{}-{}",
                        code_upper.replace('-', ""),
                        ""
                    ));
                // 简单检查：slug 中番号后是否紧跟 "-mr" 等
                let code_in_slug =
                    slug_upper.find(&code_upper.replace('-', "-"));
                let is_mr_variant = if let Some(pos) = code_in_slug {
                    let after = &slug_upper[pos + code_upper.len()..];
                    after.starts_with("-MR") || after.starts_with("-UNCENSORED")
                } else {
                    false
                };

                let mut score: i32 = 0;
                if href_has_code {
                    score += 10;
                }
                if text_has_code {
                    score += 5;
                }
                if is_variant || is_mr_variant {
                    score -= 20;
                }
                if has_code_variant {
                    score -= 10;
                }

                if let Some((_, best_score)) = &best {
                    if score > *best_score {
                        best = Some((href.to_string(), score));
                    }
                } else {
                    best = Some((href.to_string(), score));
                }

                // 高分直接返回
                if score >= 15 {
                    return Some(href.to_string());
                }
            }

            // 如果在当前选择器中找到了候选，就不继续尝试更宽泛的选择器
            if best.is_some() {
                break;
            }
        }

        best.map(|(url, _)| url)
    }

    fn parse(&self, html: &str, code: &str) -> Option<SearchResult> {
        let doc = Html::parse_document(html);
        let code_upper = code.trim().to_uppercase();

        // 标题：h1.titl 或回退到 h1 / og:title
        let raw_title = select_text(&doc, "h1.titl")
            .or_else(|| select_text(&doc, "h1"))
            .or_else(|| select_attr(&doc, r#"meta[property="og:title"]"#, "content"))
            .unwrap_or_default();

        // 清理标题：去掉 [CODE] 前缀
        let title = raw_title
            .trim_start_matches('[')
            .trim_start_matches(&code_upper)
            .trim_start_matches(&code.to_lowercase())
            .trim_start_matches(']')
            .trim_start_matches(|c: char| c == ' ' || c == '-' || c == '\u{3000}')
            .trim()
            .to_string();

        // 封面图：.large-screenimg img 或 og:image
        let cover_url = select_attr(&doc, ".large-screenimg img", "src")
            .or_else(|| select_attr(&doc, r#"meta[property="og:image"]"#, "content"))
            .unwrap_or_default();

        // 从 .infoleft ul li 提取结构化字段
        let info_items = extract_info_items(&doc);

        let premiered = find_info_value(&info_items, "Release Date")
            .or_else(|| find_info_value(&info_items, "Release"))
            .unwrap_or_default();

        let director = find_info_link_text(&info_items, "Director")
            .unwrap_or_default();

        let studio = find_info_link_text(&info_items, "Studio")
            .or_else(|| find_info_link_text(&info_items, "Maker"))
            .unwrap_or_default();

        let label = find_info_link_text(&info_items, "Label")
            .unwrap_or_default();

        let series = find_info_link_text(&info_items, "Series")
            .unwrap_or_default();

        // 标签
        let tags = find_info_links_text(&info_items, "Tags");

        // 演员
        let actresses = find_info_links_text(&info_items, "Actress");
        let actors_male = find_info_links_text(&info_items, "Actor");
        let mut all_actors = actresses;
        all_actors.extend(actors_male);
        let actors = dedup_strings(all_actors).join(", ");

        let tags = dedup_strings(tags).join(", ");

        // 截图：.wp-content img
        let thumbs = extract_screenshots(&doc, &cover_url);

        // 剧情：.wp-content p 纯文本段落
        let plot = extract_plot(&doc)
            .or_else(|| select_attr(&doc, r#"meta[property="og:description"]"#, "content"))
            .unwrap_or_default();

        // 页面 URL
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
            duration: String::new(),
            studio: studio.clone(),
            source: "javguru".to_string(),
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
            outline: plot,
            original_plot: String::new(),
            maker: studio,
            label,
            set_name: series,
            genres: tags,
            ..Default::default()
        })
    }
}

// ── 辅助函数 ──

/// 单条信息项：标签名 + 原始 HTML 内容
struct InfoItem {
    label: String,
    html: String,
}

/// 从 `.infoleft ul li` 提取所有信息项
fn extract_info_items(doc: &Html) -> Vec<InfoItem> {
    let li_sel = match Selector::parse(".infoleft ul li") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let strong_sel = match Selector::parse("strong") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let mut items = Vec::new();
    for li in doc.select(&li_sel) {
        // 从 <strong> 中提取标签名
        let label = li
            .select(&strong_sel)
            .next()
            .map(|el| {
                el.text()
                    .collect::<Vec<_>>()
                    .join("")
                    .replace(':', "")
                    .trim()
                    .to_string()
            })
            .unwrap_or_default();

        if label.is_empty() {
            continue;
        }

        let html = li.inner_html();
        items.push(InfoItem { label, html });
    }
    items
}

/// 从信息项中查找指定标签的纯文本值
fn find_info_value(items: &[InfoItem], label: &str) -> Option<String> {
    let item = items.iter().find(|i| i.label.eq_ignore_ascii_case(label))?;
    // 解析 HTML 片段，提取纯文本（减去 strong 内文本）
    let fragment = Html::parse_fragment(&item.html);
    let strong_sel = Selector::parse("strong").ok();

    let full_text: String = fragment
        .root_element()
        .text()
        .collect::<Vec<_>>()
        .join("");

    let strong_text = strong_sel
        .and_then(|sel| {
            fragment
                .select(&sel)
                .next()
                .map(|el| el.text().collect::<Vec<_>>().join(""))
        })
        .unwrap_or_default();

    let value = full_text
        .replace(&strong_text, "")
        .trim()
        .to_string();

    (!value.is_empty()).then_some(value)
}

/// 从信息项中查找指定标签后的第一个链接文本
fn find_info_link_text(items: &[InfoItem], label: &str) -> Option<String> {
    let item = items.iter().find(|i| i.label.eq_ignore_ascii_case(label))?;
    let fragment = Html::parse_fragment(&item.html);
    let a_sel = Selector::parse("a").ok()?;

    fragment.select(&a_sel).next().map(|el| {
        el.text()
            .collect::<Vec<_>>()
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }).filter(|t| !t.is_empty())
}

/// 从信息项中查找指定标签后的所有链接文本
fn find_info_links_text(items: &[InfoItem], label: &str) -> Vec<String> {
    let item = match items.iter().find(|i| i.label.eq_ignore_ascii_case(label)) {
        Some(i) => i,
        None => return Vec::new(),
    };
    let fragment = Html::parse_fragment(&item.html);
    let a_sel = match Selector::parse("a") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    fragment
        .select(&a_sel)
        .map(|el| {
            el.text()
                .collect::<Vec<_>>()
                .join(" ")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|t| !t.is_empty())
        .collect()
}

/// 从 .wp-content p 提取剧情文本（排除只含图片的段落）
fn extract_plot(doc: &Html) -> Option<String> {
    let sel = Selector::parse(".wp-content p").ok()?;
    let img_sel = Selector::parse("img").ok()?;

    let mut paragraphs = Vec::new();
    for p in doc.select(&sel) {
        // 跳过含有 img 的段落
        if p.select(&img_sel).next().is_some() {
            continue;
        }
        let text: String = p.text().collect::<Vec<_>>().join(" ");
        let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if !cleaned.is_empty() {
            paragraphs.push(cleaned);
        }
    }

    let plot = paragraphs.join(" ");
    (!plot.is_empty()).then_some(plot)
}

/// 提取截图 URL（.wp-content img，排除封面）
fn extract_screenshots(doc: &Html, cover_url: &str) -> Vec<String> {
    let sel = match Selector::parse(".wp-content img[src]") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let mut seen = HashSet::new();
    let mut thumbs = Vec::new();

    for el in doc.select(&sel) {
        let src = el.value().attr("src").unwrap_or("");
        if src.is_empty() || src == cover_url {
            continue;
        }
        if seen.insert(src.to_string()) {
            thumbs.push(src.to_string());
        }
    }

    thumbs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_url_returns_search_page() {
        assert_eq!(JavGuru.build_url("JUR-448"), "https://jav.guru/?s=JUR-448");
    }

    #[test]
    fn extract_detail_url_finds_exact_match() {
        let html = r#"
        <html><body>
        <article>
            <h2><a href="https://jav.guru/954094/jur-448-english-subbed-tamed/">[JUR-448] (English subbed) title</a></h2>
        </article>
        <article>
            <h2><a href="https://jav.guru/846271/jur-448-mr-tamed/">[JUR-448-MR] tamed variant</a></h2>
        </article>
        <article>
            <h2><a href="https://jav.guru/751700/jur-448-as-my-husbands/">[JUR-448] As my husband's...</a></h2>
        </article>
        </body></html>
        "#;

        let result = JavGuru.extract_detail_url(html, "JUR-448");
        assert!(result.is_some());
        let url = result.unwrap();
        // 应该返回非变体的链接
        assert!(url.contains("jav.guru/"));
        assert!(url.contains("jur-448"));
    }

    #[test]
    fn extract_detail_url_skips_non_matching() {
        let html = r#"
        <html><body>
        <article>
            <h2><a href="https://jav.guru/123/abc-999-something/">ABC-999 unrelated</a></h2>
        </article>
        </body></html>
        "#;

        let result = JavGuru.extract_detail_url(html, "JUR-448");
        assert!(result.is_none());
    }

    #[test]
    fn parse_extracts_detail_page() {
        let html = r#"
        <html>
        <head>
            <meta property="og:title" content="[JUR-448] (English subbed) Tamed by my husband's younger boss">
            <meta property="og:image" content="https://cdn.javmiku.com/wp-content/uploads/2026/03/jur448pl.jpg">
            <meta property="og:description" content="Meguri's husband's caused a massive financial loss at work.">
            <meta property="og:url" content="https://jav.guru/954094/jur-448-english-subbed/">
        </head>
        <body>
        <div class="inside-article">
            <div class="content">
                <div class="posts">
                    <h1 class="titl">[JUR-448] (English subbed) Tamed by my husband's younger boss</h1>
                    <div class="large-screenshot">
                        <div class="large-screenimg">
                            <img src="https://cdn.javmiku.com/wp-content/uploads/2026/03/jur448pl.jpg" alt="cover">
                        </div>
                    </div>
                    <div class="infometa">
                        <div class="infoleft">
                            <h2>Movie Information:</h2>
                            <ul>
                                <li><strong><span>Code: </span></strong>JUR-448</li>
                                <li><strong><span>Release Date: </span></strong>2025-09-04</li>
                                <li><strong>Category:</strong> <a href="/category/1080p/">1080p</a>, <a href="/category/english-subbed/">English subbed JAV</a>, <a href="/category/hd/">HD</a>, <a href="/category/jav/">JAV</a></li>
                                <li><strong>Director:</strong> <a href="/director/kimura-hiroyuki/">Kimura Hiroyuki</a></li>
                                <li><strong>Studio:</strong> <a href="/maker/madonna/">Madonna</a></li>
                                <li><strong>Label:</strong> <a href="/studio/jur/">JUR</a></li>
                                <li class="w1"><strong>Tags: </strong><a href="/tag/big-tits/">Big tits</a>, <a href="/tag/cuckold/">Cuckold</a>, <a href="/tag/married/">Married</a>, <a href="/tag/mature/">Mature</a>, <a href="/tag/solowork/">Solowork</a></li>
                                <li class="w1"><strong>Series:</strong> <a href="/series/breast-slave/">I Was Tamed as an Exclusive Breast Slave</a></li>
                                <li class="w1"><strong>Actor:</strong> <a href="/actor/saji-hanzo/">Saji Hanzo</a></li>
                                <li class="w1"><strong>Actress:</strong> <a href="/actress/meguri/">Meguri</a></li>
                            </ul>
                        </div>
                    </div>
                    <div class="wp-content">
                        <p>Meguri's husband's caused a massive financial loss at work.</p>
                        <p>He then demands to be compensated by having his wife.</p>
                        <p><img src="https://cdn.javmiku.com/wp-content/uploads/2025-content/09/jur00448jp-1.jpg" alt="thumb1"><br>
                        <img src="https://cdn.javmiku.com/wp-content/uploads/2025-content/09/jur00448jp-3.jpg" alt="thumb2"><br>
                        <img src="https://cdn.javmiku.com/wp-content/uploads/2026-content/03/jur00448jp-4.jpg" alt="thumb3"><br>
                        <img src="https://cdn.javmiku.com/wp-content/uploads/2026-content/03/jur00448jp-10.jpg" alt="thumb4"></p>
                    </div>
                </div>
            </div>
        </div>
        </body>
        </html>
        "#;

        let result = JavGuru.parse(html, "JUR-448").expect("应解析详情页");
        assert_eq!(result.code, "JUR-448");
        assert_eq!(
            result.cover_url,
            "https://cdn.javmiku.com/wp-content/uploads/2026/03/jur448pl.jpg"
        );
        assert_eq!(result.premiered, "2025-09-04");
        assert_eq!(result.director, "Kimura Hiroyuki");
        assert_eq!(result.studio, "Madonna");
        assert_eq!(result.label, "JUR");
        assert_eq!(result.actors, "Meguri, Saji Hanzo");
        assert!(result.tags.contains("Big tits"));
        assert!(result.tags.contains("Cuckold"));
        assert!(result.tags.contains("Mature"));
        assert_eq!(result.set_name, "I Was Tamed as an Exclusive Breast Slave");
        assert_eq!(result.thumbs.len(), 4);
        assert!(result.thumbs[0].contains("jur00448jp-1.jpg"));
        assert!(result.plot.contains("Meguri"));
        assert!(result.plot.contains("financial loss"));
    }

    #[test]
    fn parse_returns_none_for_empty_page() {
        let html = r#"
        <html>
        <head></head>
        <body>
            <h1 class="entry-title"></h1>
            <div class="entry-content"></div>
        </body>
        </html>
        "#;

        assert!(JavGuru.parse(html, "JUR-448").is_none());
    }
}
