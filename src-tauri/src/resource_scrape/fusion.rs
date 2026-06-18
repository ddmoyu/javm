//! 字段级跨源融合
//!
//! 多源刮削结果不再「整条择优只留一个源」，而是以 `detail_score` 最高者为**主源**作基底，
//! 其余源按字段补全/并集：主源缺失的标量字段用其它源补；数组字段（演员/标签/genre/缩略图）
//! 并集去重。产出比任何单源都完整的一条结果。
//!
//! 方案阶段 1（基础融合）：主源 + 缺失补全 + 数组并集，无 per-field 优先源表。
//! 数组去重当前按归一化键（去空白 + 小写）；跨语言去重（三上悠亜/三上悠亚）待接别名方案。

use std::collections::HashSet;

use super::types::SearchResult;

/// 把多源结果融合为一条。空输入返回 `None`；单条原样返回。
pub fn merge_sources(mut results: Vec<SearchResult>) -> Option<SearchResult> {
    if results.is_empty() {
        return None;
    }
    if results.len() == 1 {
        return results.pop();
    }

    // 主源 = detail_score 最高（稳定排序保留先后）
    results.sort_by(|a, b| b.detail_score.cmp(&a.detail_score));
    let mut base = results[0].clone();
    let rest = &results[1..];

    // ===== 标量：主源为空则按 score 降序取第一个非空 =====
    fill_if_empty(&mut base.code, rest, |r| &r.code);
    fill_if_empty(&mut base.title, rest, |r| &r.title);
    fill_if_empty(&mut base.duration, rest, |r| &r.duration);
    fill_if_empty(&mut base.studio, rest, |r| &r.studio);
    fill_if_empty(&mut base.director, rest, |r| &r.director);
    fill_if_empty(&mut base.premiered, rest, |r| &r.premiered);
    fill_if_empty(&mut base.plot, rest, |r| &r.plot);
    fill_if_empty(&mut base.outline, rest, |r| &r.outline);
    fill_if_empty(&mut base.original_plot, rest, |r| &r.original_plot);
    fill_if_empty(&mut base.tagline, rest, |r| &r.tagline);
    fill_if_empty(&mut base.sort_title, rest, |r| &r.sort_title);
    fill_if_empty(&mut base.set_name, rest, |r| &r.set_name);
    fill_if_empty(&mut base.maker, rest, |r| &r.maker);
    fill_if_empty(&mut base.publisher, rest, |r| &r.publisher);
    fill_if_empty(&mut base.label, rest, |r| &r.label);
    fill_if_empty(&mut base.mpaa, rest, |r| &r.mpaa);
    fill_if_empty(&mut base.custom_rating, rest, |r| &r.custom_rating);
    fill_if_empty(&mut base.country_code, rest, |r| &r.country_code);
    fill_if_empty(&mut base.cover_url, rest, |r| &r.cover_url);
    fill_if_empty(&mut base.poster_url, rest, |r| &r.poster_url);

    // ===== Option：None / 空则补 =====
    if base.rating.is_none() {
        base.rating = rest.iter().find_map(|r| r.rating);
    }
    if base.critic_rating.is_none() {
        base.critic_rating = rest.iter().find_map(|r| r.critic_rating);
    }
    if base.original_title.as_deref().unwrap_or("").trim().is_empty() {
        if let Some(v) = rest
            .iter()
            .find_map(|r| r.original_title.as_deref().filter(|s| !s.trim().is_empty()))
        {
            base.original_title = Some(v.to_string());
        }
    }

    // 无码标记：任一源判定为无码即为无码（有码无码分轨）
    base.is_uncensored = results.iter().any(|r| r.is_uncensored);

    // ===== 数组：并集去重（用 results 含主源，主源项先入 seen 保留在前；标量补全用 rest 排除主源）=====
    base.actors = union_csv(results.iter().map(|r| r.actors.as_str()));
    base.tags = union_csv(results.iter().map(|r| r.tags.as_str()));
    base.genres = union_csv(results.iter().map(|r| r.genres.as_str()));
    base.thumbs = union_vec(results.iter().flat_map(|r| r.thumbs.iter().cloned()));

    Some(base)
}

fn fill_if_empty<F>(target: &mut String, rest: &[SearchResult], get: F)
where
    F: Fn(&SearchResult) -> &String,
{
    if !target.trim().is_empty() {
        return;
    }
    if let Some(v) = rest.iter().map(get).find(|s| !s.trim().is_empty()) {
        *target = v.clone();
    }
}

/// 逗号 / 、/ ， 分隔的多串并集去重（按归一化键去重，保留首次出现的原写法）。
fn union_csv<'a>(values: impl Iterator<Item = &'a str>) -> String {
    let mut seen = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for value in values {
        for item in value.split(['、', ',', '，']) {
            let item = item.trim();
            if item.is_empty() {
                continue;
            }
            if seen.insert(norm_key(item)) {
                out.push(item.to_string());
            }
        }
    }
    out.join(", ")
}

fn union_vec(items: impl Iterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        let item = item.trim().to_string();
        if item.is_empty() {
            continue;
        }
        if seen.insert(item.clone()) {
            out.push(item);
        }
    }
    out
}

/// 去重归一化键：去空白 + 小写。跨语言去重待接别名方案（阶段 3）。
fn norm_key(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(source: &str, score: i32) -> SearchResult {
        SearchResult {
            source: source.to_string(),
            detail_score: score,
            ..Default::default()
        }
    }

    #[test]
    fn empty_returns_none() {
        assert!(merge_sources(vec![]).is_none());
    }

    #[test]
    fn single_returns_as_is() {
        let merged = merge_sources(vec![r("a", 10)]).unwrap();
        assert_eq!(merged.source, "a");
    }

    #[test]
    fn highest_score_is_base_and_fills_missing_scalars() {
        let mut high = r("high", 90);
        high.title = "标题".into();
        high.studio = String::new(); // 缺片商
        let mut low = r("low", 50);
        low.title = "次标题".into();
        low.studio = "S1".into(); // 有片商
        low.director = "导演".into();

        let merged = merge_sources(vec![low, high]).unwrap();
        assert_eq!(merged.source, "high"); // 主源
        assert_eq!(merged.title, "标题"); // 主源非空保留
        assert_eq!(merged.studio, "S1"); // 主源缺 → 补
        assert_eq!(merged.director, "导演"); // 主源缺 → 补
    }

    #[test]
    fn arrays_union_dedup() {
        let mut a = r("a", 90);
        a.actors = "三上悠亜, 葵つかさ".into();
        a.genres = "巨乳".into();
        a.thumbs = vec!["t1".into(), "t2".into()];
        let mut b = r("b", 50);
        b.actors = "葵つかさ、深田えいみ".into(); // 葵つかさ 重复
        b.genres = "美少女, 巨乳".into(); // 巨乳 重复
        b.thumbs = vec!["t2".into(), "t3".into()]; // t2 重复

        let merged = merge_sources(vec![a, b]).unwrap();
        assert_eq!(merged.actors, "三上悠亜, 葵つかさ, 深田えいみ");
        assert_eq!(merged.genres, "巨乳, 美少女");
        assert_eq!(merged.thumbs, vec!["t1", "t2", "t3"]);
    }

    #[test]
    fn fills_optional_rating_from_other_source() {
        let mut high = r("high", 90);
        high.rating = None;
        let mut low = r("low", 50);
        low.rating = Some(4.5);
        let merged = merge_sources(vec![high, low]).unwrap();
        assert_eq!(merged.rating, Some(4.5));
    }
}
