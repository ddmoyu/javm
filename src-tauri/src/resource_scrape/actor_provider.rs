//! 演员（star）页解析器：从数据源演员页抽取档案 + 作品全集（分页）。
//!
//! 以番号详情页同源的 javbus 风格 star 页为主源（`/star/{code}`）。页面结构（站点惯例）：
//! - 档案：`.avatar-box` > `.photo-frame img`(头像) + `.photo-info p`（生日/身高/罩杯/胸圍/腰圍/臀圍 等 `标签: 值`）
//! - 作品：`a.movie-box` > `.photo-frame img`(封面/title) + `.photo-info span` 内两个 `<date>`（番号、发行日期）
//! - 分页：`#next` / `.pagination` 含「下一頁」链接表示有下一页，URL 为 `/star/{code}/{page}`
//!
//! 解析为纯函数 + fixture 单测;选择器针对上述结构,站点改版需回归调整。

use scraper::{Html, Selector};

use crate::db::ActorProfileInput;

/// star 页解析出的单部作品
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StarWork {
    pub code: String,
    pub title: String,
    pub cover_url: String,
    pub release_date: String,
}

const HOST: &str = "https://www.javbus.com";

/// 构建演员页 URL。`page<=1` 为首页，否则 `/star/{code}/{page}`。
pub fn build_star_url(star_code: &str, page: u32) -> String {
    if page <= 1 {
        format!("{}/star/{}", HOST, star_code)
    } else {
        format!("{}/star/{}/{}", HOST, star_code, page)
    }
}

/// 维度（片商/系列/导演）列表页 URL：`/{facet_type}/{source_id}` (+ `/{page}`)。
/// `facet_type` 直接作路径段（studio/series/director，与站点一致）。
pub fn build_facet_url(facet_type: &str, source_id: &str, page: u32) -> String {
    if page <= 1 {
        format!("{}/{}/{}", HOST, facet_type, source_id)
    } else {
        format!("{}/{}/{}/{}", HOST, facet_type, source_id, page)
    }
}

/// 从影片详情页解析某维度在数据源的 id（`.info` 内 `<a href="/{facet_type}/{id}">`）。
///
/// `want_name` 提供时（如分类，一片多值）：仅取**链接文本等于该名字**的那条，
/// 避免在多分类影片里误取到别的分类；不提供时（片商/系列/导演，一片单值）：取首个匹配链接。
pub fn parse_facet_source_id(
    detail_html: &str,
    facet_type: &str,
    want_name: Option<&str>,
) -> Option<String> {
    let doc = Html::parse_document(detail_html);
    let needle = format!("/{}/", facet_type);
    let sel = Selector::parse(".info a[href]").ok()?;
    let want = want_name.map(str::trim);
    for a in doc.select(&sel) {
        let href = match a.value().attr("href") {
            Some(h) => h,
            None => continue,
        };
        let Some(pos) = href.find(&needle) else {
            continue;
        };
        // 指定名字时按链接文本精确匹配（多值维度必须认准目标）
        if let Some(want) = want {
            let text = a.text().collect::<String>();
            if text.trim() != want {
                continue;
            }
        }
        let id = href[pos + needle.len()..]
            .split(['/', '?', '#'])
            .next()
            .unwrap_or("")
            .trim();
        if !id.is_empty() {
            return Some(id.to_string());
        }
    }
    None
}

/// 按演员名搜索的 URL（`/searchstar/{name}`，路径段百分号编码以支持日文名）。
pub fn build_search_url(name: &str) -> String {
    match url::Url::parse(&format!("{HOST}/")) {
        Ok(mut u) => {
            u.set_path(&format!("searchstar/{name}"));
            u.to_string()
        }
        Err(_) => format!("{HOST}/searchstar/{name}"),
    }
}

/// 从 searchstar 结果页挑出 star（名字优先精确匹配，否则取首个有 star code 的）。
/// 结果页结构与详情页演员区一致（`.avatar-box`），复用同一解析。
pub fn pick_star_from_search(html: &str, want_name: &str) -> Option<super::types::ActorAvatar> {
    let doc = Html::parse_document(html);
    let mut hits: Vec<super::types::ActorAvatar> =
        super::sources::javbus::parse_actor_avatars(&doc)
            .into_iter()
            .filter(|a| !a.star_code.trim().is_empty())
            .collect();
    if hits.is_empty() {
        return None;
    }
    let want = want_name.trim();
    if let Some(pos) = hits.iter().position(|a| a.name.trim() == want) {
        return Some(hits.swap_remove(pos));
    }
    Some(hits.swap_remove(0))
}

fn absolutize(u: &str) -> String {
    if u.is_empty() || u.starts_with("http") {
        u.to_string()
    } else {
        format!("{}{}", HOST, u)
    }
}

/// 从形如 "158cm" / "88" 的文本中取首个整数
fn first_int(s: &str) -> Option<i32> {
    let digits: String = s.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// 解析演员档案（首页即含）。返回的字段缺失即为 None，不臆造。
pub fn parse_profile(html: &str) -> ActorProfileInput {
    let doc = Html::parse_document(html);
    let mut p = ActorProfileInput::default();

    // 头像
    if let Ok(sel) = Selector::parse(".avatar-box .photo-frame img") {
        if let Some(img) = doc.select(&sel).next() {
            if let Some(src) = img.value().attr("src") {
                let url = absolutize(src);
                if !url.to_lowercase().contains("nowprinting") {
                    p.avatar_url = Some(url);
                }
            }
        }
    }

    // 资料行：.photo-info p 每行 "标签: 值"
    if let Ok(sel) = Selector::parse(".avatar-box .photo-info p, .photo-info p") {
        for el in doc.select(&sel) {
            let text: String = el.text().collect::<String>();
            let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
            let (label, value) = match text.split_once(':').or_else(|| text.split_once('：')) {
                Some(v) => v,
                None => continue,
            };
            let label = label.trim();
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            // 标签兼容繁简
            if label.contains("生日") || label.contains("生年") {
                p.birthday.get_or_insert_with(|| value.to_string());
            } else if label.contains("身高") {
                p.height = p.height.or_else(|| first_int(value));
            } else if label.contains("罩杯") {
                p.cup.get_or_insert_with(|| value.to_string());
            } else if label.contains("胸") {
                p.bust = p.bust.or_else(|| first_int(value));
            } else if label.contains("腰") {
                p.waist = p.waist.or_else(|| first_int(value));
            } else if label.contains("臀") {
                p.hip = p.hip.or_else(|| first_int(value));
            }
        }
    }

    p
}

/// 解析当前页的作品列表。
pub fn parse_works(html: &str) -> Vec<StarWork> {
    let doc = Html::parse_document(html);
    let box_sel = match Selector::parse("a.movie-box") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let img_sel = Selector::parse(".photo-frame img").ok();
    let date_sel = Selector::parse("date").ok();

    doc.select(&box_sel)
        .filter_map(|el| {
            let img = img_sel.as_ref().and_then(|s| el.select(s).next());
            let cover_url = img
                .and_then(|i| i.value().attr("src"))
                .map(absolutize)
                .unwrap_or_default();
            let title = img
                .and_then(|i| i.value().attr("title"))
                .map(|s| s.trim().to_string())
                .unwrap_or_default();

            // .photo-info 内两个 <date>：首=番号，次=发行日期
            let dates: Vec<String> = date_sel
                .as_ref()
                .map(|s| {
                    el.select(s)
                        .map(|d| d.text().collect::<String>().trim().to_string())
                        .collect()
                })
                .unwrap_or_default();
            let code = dates.first().cloned().unwrap_or_default();
            let release_date = dates.get(1).cloned().unwrap_or_default();

            if code.is_empty() {
                return None;
            }
            Some(StarWork { code, title, cover_url, release_date })
        })
        .collect()
}

/// 是否存在下一页（分页含「下一頁/下一页」链接或 `#next`）。
pub fn parse_has_next_page(html: &str) -> bool {
    let doc = Html::parse_document(html);
    if let Ok(sel) = Selector::parse("#next") {
        if doc.select(&sel).next().is_some() {
            return true;
        }
    }
    if let Ok(sel) = Selector::parse(".pagination a") {
        return doc.select(&sel).any(|a| {
            let t = a.text().collect::<String>();
            t.contains("下一頁") || t.contains("下一页") || t.contains("Next")
        });
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_star_url_with_pagination() {
        assert_eq!(build_star_url("abc", 1), "https://www.javbus.com/star/abc");
        assert_eq!(build_star_url("abc", 0), "https://www.javbus.com/star/abc");
        assert_eq!(build_star_url("abc", 3), "https://www.javbus.com/star/abc/3");
    }

    #[test]
    fn parses_profile_fields() {
        let html = r#"
            <div class="avatar-box">
              <div class="photo-frame"><img src="https://img/a.jpg"></div>
              <div class="photo-info">
                <p>生日: 1993-08-16</p>
                <p>年齡: 30</p>
                <p>身高: 158cm</p>
                <p>罩杯: D</p>
                <p>胸圍: 88cm</p>
                <p>腰圍: 58cm</p>
                <p>臀圍: 85cm</p>
              </div>
            </div>
        "#;
        let p = parse_profile(html);
        assert_eq!(p.avatar_url.as_deref(), Some("https://img/a.jpg"));
        assert_eq!(p.birthday.as_deref(), Some("1993-08-16"));
        assert_eq!(p.height, Some(158));
        assert_eq!(p.cup.as_deref(), Some("D"));
        assert_eq!(p.bust, Some(88));
        assert_eq!(p.waist, Some(58));
        assert_eq!(p.hip, Some(85));
    }

    #[test]
    fn profile_missing_fields_stay_none() {
        let html = r#"<div class="avatar-box"><div class="photo-info"><p>身高: 160cm</p></div></div>"#;
        let p = parse_profile(html);
        assert_eq!(p.height, Some(160));
        assert!(p.birthday.is_none());
        assert!(p.cup.is_none());
        assert!(p.avatar_url.is_none());
    }

    #[test]
    fn parses_works_code_title_cover_date() {
        let html = r#"
            <div id="waterfall">
              <a class="movie-box" href="/SSIS-001">
                <div class="photo-frame"><img src="https://img/c1.jpg" title="标题一"></div>
                <div class="photo-info"><span>标题一<date>SSIS-001</date><date>2024-01-01</date></span></div>
              </a>
              <a class="movie-box" href="/ABP-002">
                <div class="photo-frame"><img src="/imgs/c2.jpg" title="标题二"></div>
                <div class="photo-info"><span>标题二<date>ABP-002</date><date>2023-05-09</date></span></div>
              </a>
            </div>
        "#;
        let works = parse_works(html);
        assert_eq!(works.len(), 2);
        assert_eq!(works[0].code, "SSIS-001");
        assert_eq!(works[0].title, "标题一");
        assert_eq!(works[0].cover_url, "https://img/c1.jpg");
        assert_eq!(works[0].release_date, "2024-01-01");
        // 相对封面 URL 补全为绝对
        assert_eq!(works[1].cover_url, "https://www.javbus.com/imgs/c2.jpg");
        assert_eq!(works[1].code, "ABP-002");
    }

    #[test]
    fn detects_next_page() {
        let with_next = r#"<ul class="pagination"><li><a>1</a></li><li id="next"><a href="/star/x/2">下一頁</a></li></ul>"#;
        let last = r#"<ul class="pagination"><li class="active"><a>3</a></li></ul>"#;
        assert!(parse_has_next_page(with_next));
        assert!(!parse_has_next_page(last));
    }

    #[test]
    fn builds_facet_url() {
        assert_eq!(build_facet_url("studio", "2xs", 1), "https://www.javbus.com/studio/2xs");
        assert_eq!(build_facet_url("series", "abc", 3), "https://www.javbus.com/series/abc/3");
    }

    #[test]
    fn parses_facet_source_id() {
        let html = r#"<div class="info">
            <p><span class="header">製作商:</span><a href="/studio/2xs">S1</a></p>
            <p><span>系列:</span><a href="https://www.javbus.com/series/9kx">系列A</a></p>
            <p><a href="/director/3dd">导演A</a></p>
        </div>"#;
        assert_eq!(parse_facet_source_id(html, "studio", None).as_deref(), Some("2xs"));
        assert_eq!(parse_facet_source_id(html, "series", None).as_deref(), Some("9kx"));
        assert_eq!(parse_facet_source_id(html, "director", None).as_deref(), Some("3dd"));
        assert_eq!(parse_facet_source_id(html, "label", None), None);
    }
}
