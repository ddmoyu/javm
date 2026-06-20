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
}
