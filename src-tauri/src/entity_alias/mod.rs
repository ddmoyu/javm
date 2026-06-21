//! 跨语言别名与实体规范化
//!
//! 女优/片商/标签常有中日英多种写法。本模块把同一实体的多语言名归并到同一
//! `entity_id`，使「输入任一语言都能定位实体、并展开出源偏好语言(日文)的名字去查」。
//!
//! ## 架构：证据 → 投影（可重建、可清洗）
//! - **`alias_evidence`（append-only 原始证据）**：每条 = 某源在某番号给出的某名字。**唯一真相源**。
//! - **`alias_overrides`（校正规则）**：`merge` 强制归并 / `block` 拉黑名字 / `canonical` 锁定展示名。
//!   种子表也以 `merge` 规则形式存在。实时关联与重建都尊重它，故修正不会被重刮覆盖。
//! - **`entity_aliases` + `designation_entities`（投影/缓存）**：由证据 + 规则**推导**而来，可随时
//!   [`rebuild`] 重算。清洗脏数据 = 删证据/源或加规则 → 重建，**合并因此可逆**。
//!
//! ## 模块划分
//! - [`text`]：归一化 / 语言判断 / 书写体系排序（纯函数）
//! - [`cluster`]：投影簇两张表的底层 SQL 原语
//! - [`evidence`]：原始证据读写 + 实体证据反查
//! - [`overrides`]：校正规则读写（block/merge/canonical）
//! - 本文件：编排（[`apply_designation`] / [`rebuild`]）、读 API（[`resolve_entity`] / [`expand`]）
//!
//! ## 关联策略（保守，避免误并）
//! - **片商**：每部影片唯一片商 → 同番号各源给的片商名永远可安全归并。
//! - **女优**：仅当该番号是**单人作**（各源报告的女优数 ≤ 1）才归并，多人作不归并以免错并合演者。

pub mod commands;
mod cluster;
mod evidence;
mod overrides;
mod seed;
mod text;

use rusqlite::{params, Connection};
use serde::Serialize;

use cluster::{
    ensure_entity, entity_id_for_norm, remove_designation_entity, unify_names,
    upsert_designation_entity,
};
use evidence::{all_designations, evidence_names, max_source_count};
use overrides::{blocked_norms, merge_groups};
use text::script_rank;

// 对外公开 API（供 commands / database_writer / 搜索 / seed / lib 调用）
pub use cluster::designation_entity;
pub use evidence::{evidence_for_entity, purge_source, record_evidence, EvidenceRow};
pub use overrides::{add_block, add_canonical, add_force_merge, apply_force_merge_group};
pub use seed::import_seed_if_needed;
pub use text::{detect_lang, normalize_name};

/// 实体类型常量
pub const ENTITY_ACTOR: &str = "actor";
pub const ENTITY_STUDIO: &str = "studio";
pub const ENTITY_TAG: &str = "tag";

/// 一条别名记录（下发前端/供调用方使用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasRow {
    pub name: String,
    pub lang: String,
    pub is_canonical: bool,
    pub source: Option<String>,
    pub confidence: f64,
}

// ==================== 投影构建：实时关联 + 重建 ====================

/// 把某番号的证据投影到簇（实时 + 重建共用）：片商总是归并；女优仅单人作归并。
pub fn apply_designation(conn: &Connection, designation: &str) -> rusqlite::Result<()> {
    let designation = designation.trim();
    if designation.is_empty() {
        return Ok(());
    }
    apply_designation_type(conn, designation, ENTITY_STUDIO)?;
    apply_designation_type(conn, designation, ENTITY_ACTOR)?;
    Ok(())
}

fn apply_designation_type(
    conn: &Connection,
    designation: &str,
    entity_type: &str,
) -> rusqlite::Result<()> {
    let blocked = blocked_norms(conn, entity_type)?;
    let names = evidence_names(conn, designation, entity_type, &blocked)?;
    if names.is_empty() {
        remove_designation_entity(conn, designation, entity_type)?;
        return Ok(());
    }

    // 片商总是归并；女优仅单人作（各源女优数 ≤ 1）才归并
    let should_union = if entity_type == ENTITY_ACTOR {
        max_source_count(conn, designation, entity_type, &blocked)? <= 1
    } else {
        true
    };

    if should_union {
        let refs: Vec<&str> = names.iter().map(|(name, _)| name.as_str()).collect();
        if let Some(eid) = unify_names(conn, entity_type, &refs, "scrape")? {
            upsert_designation_entity(conn, designation, entity_type, eid)?;
        }
    } else {
        // 多人作：每个名字仍作为可检索的单实体存在，但不归并、不绑番号
        for (name, norm) in &names {
            ensure_entity(conn, entity_type, name, norm, "scrape")?;
        }
        remove_designation_entity(conn, designation, entity_type)?;
    }
    Ok(())
}

/// 从证据 + 校正规则**整体重建**所有别名簇（清洗脏数据后调用）。
/// 先清空投影，应用 merge 规则（含种子），再按番号重放全部证据——与实时关联同一套规则，
/// 故重建是权威结果，能抹掉实时增量在边界情形下的过度合并。
pub fn rebuild(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM entity_aliases", [])?;
    conn.execute("DELETE FROM designation_entities", [])?;

    for entity_type in [ENTITY_STUDIO, ENTITY_TAG, ENTITY_ACTOR] {
        let blocked = blocked_norms(conn, entity_type)?;
        for group in merge_groups(conn, entity_type)? {
            let refs: Vec<&str> = group
                .iter()
                .filter(|(_, norm)| !blocked.contains(norm))
                .map(|(name, _)| name.as_str())
                .collect();
            if !refs.is_empty() {
                unify_names(conn, entity_type, &refs, "override")?;
            }
        }
    }

    for designation in all_designations(conn)? {
        apply_designation(conn, &designation)?;
    }
    Ok(())
}

// ==================== 读 API ====================

/// 解析名字到实体 id（命中任一别名即定位）。
pub fn resolve_entity(
    conn: &Connection,
    entity_type: &str,
    name: &str,
) -> rusqlite::Result<Option<i64>> {
    let norm = normalize_name(name);
    if norm.is_empty() {
        return Ok(None);
    }
    entity_id_for_norm(conn, entity_type, &norm)
}

/// 展开：返回 `name` 所属实体的全部别名，按查询偏好排序（日文/汉字名优先，canonical 居前）。
pub fn expand(
    conn: &Connection,
    entity_type: &str,
    name: &str,
) -> rusqlite::Result<Vec<AliasRow>> {
    let Some(eid) = resolve_entity(conn, entity_type, name)? else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT name, lang, is_canonical, source, confidence
         FROM entity_aliases WHERE entity_type = ?1 AND entity_id = ?2",
    )?;
    let mut rows = stmt
        .query_map(params![entity_type, eid], |row| {
            Ok(AliasRow {
                name: row.get(0)?,
                lang: row.get(1)?,
                is_canonical: row.get::<_, i64>(2)? != 0,
                source: row.get(3)?,
                confidence: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    rows.sort_by(|a, b| {
        script_rank(&a.name)
            .cmp(&script_rank(&b.name))
            .then(b.is_canonical.cmp(&a.is_canonical))
            .then(a.name.cmp(&b.name))
    });
    Ok(rows)
}

/// 一个实体簇（含 ≥2 个名字）：供前端列表把同一实体的多个名字合并成一条、显示主名。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasCluster {
    pub entity_id: i64,
    /// 主名（展示名）：canonical 标记的名字
    pub canonical: String,
    /// 簇内全部名字（含主名）
    pub names: Vec<String>,
}

/// 列出某类型下所有「含 ≥2 个名字」的实体簇。单名实体无需合并，省略以减小载荷。
pub fn clusters(conn: &Connection, entity_type: &str) -> rusqlite::Result<Vec<AliasCluster>> {
    let mut stmt = conn.prepare(
        "SELECT entity_id, name, is_canonical FROM entity_aliases
         WHERE entity_type = ?1 ORDER BY entity_id",
    )?;
    let rows = stmt
        .query_map(params![entity_type], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? != 0,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // 已按 entity_id 排序，逐段（同一 id 的连续行）聚成一簇
    let mut out: Vec<AliasCluster> = Vec::new();
    let mut i = 0;
    while i < rows.len() {
        let eid = rows[i].0;
        let mut names: Vec<String> = Vec::new();
        let mut canonical: Option<String> = None;
        while i < rows.len() && rows[i].0 == eid {
            let (_, name, is_canon) = &rows[i];
            if *is_canon && canonical.is_none() {
                canonical = Some(name.clone());
            }
            names.push(name.clone());
            i += 1;
        }
        if names.len() < 2 {
            continue;
        }
        let canonical = canonical.unwrap_or_else(|| names[0].clone());
        out.push(AliasCluster {
            entity_id: eid,
            canonical,
            names,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE entity_aliases (
                id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL,
                entity_id INTEGER NOT NULL, name TEXT NOT NULL, name_norm TEXT NOT NULL,
                lang TEXT NOT NULL DEFAULT 'unknown', is_canonical INTEGER NOT NULL DEFAULT 0,
                source TEXT, confidence REAL NOT NULL DEFAULT 1.0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(entity_type, name_norm));
            CREATE TABLE designation_entities (
                designation TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
                PRIMARY KEY (designation, entity_type));
            CREATE TABLE alias_evidence (
                id INTEGER PRIMARY KEY AUTOINCREMENT, designation TEXT NOT NULL,
                entity_type TEXT NOT NULL, name TEXT NOT NULL, name_norm TEXT NOT NULL,
                source TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(designation, entity_type, name_norm, source));
            CREATE TABLE alias_overrides (
                id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, entity_type TEXT NOT NULL,
                group_key TEXT, name TEXT NOT NULL, name_norm TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP);",
        )
        .unwrap();
        conn
    }

    /// 模拟一次搜索：记录各源证据后应用关联
    fn scrape(conn: &Connection, designation: &str, per_source: &[(&str, &[&str], &[&str])]) {
        for (source, studios, actors) in per_source {
            for s in *studios {
                record_evidence(conn, designation, ENTITY_STUDIO, s, source).unwrap();
            }
            for a in *actors {
                record_evidence(conn, designation, ENTITY_ACTOR, a, source).unwrap();
            }
        }
        apply_designation(conn, designation).unwrap();
    }

    #[test]
    fn single_actress_links_cross_language() {
        let conn = mem();
        scrape(
            &conn,
            "SSIS-001",
            &[
                ("srcJa", &["エスワン"], &["三上悠亜"]),
                ("srcEn", &["S1"], &["Yua Mikami"]),
                ("srcZh", &["S1"], &["三上悠亚"]),
            ],
        );
        let aliases = expand(&conn, ENTITY_ACTOR, "三上悠亚").unwrap();
        assert_eq!(aliases.len(), 3);
        // 可靠保证：汉字名(日文/中文)排在罗马音之前，供 JAV 源查询；两个汉字变体谁先不强求
        // （亜/亚 同为 CJK，无法可靠区分日文汉字与简中，探索会把 query_names 都试一遍）。
        assert_eq!(aliases[2].name, "Yua Mikami");
        assert!(aliases[0].name == "三上悠亜" || aliases[0].name == "三上悠亚");
        // 片商也归并
        assert_eq!(expand(&conn, ENTITY_STUDIO, "S1").unwrap().len(), 2);
    }

    #[test]
    fn multi_actress_not_merged_but_resolvable() {
        let conn = mem();
        scrape(
            &conn,
            "SSNI-888",
            &[
                ("srcJa", &["エスワン"], &["三上悠亜", "葵つかさ"]),
                ("srcEn", &["S1"], &["Yua Mikami", "Tsukasa Aoi"]),
            ],
        );
        // 多人作：女优名各自可检索，但不跨语言归并
        assert_eq!(expand(&conn, ENTITY_ACTOR, "三上悠亜").unwrap().len(), 1);
        assert!(resolve_entity(&conn, ENTITY_ACTOR, "Yua Mikami").unwrap().is_some());
        assert_ne!(
            resolve_entity(&conn, ENTITY_ACTOR, "三上悠亜").unwrap(),
            resolve_entity(&conn, ENTITY_ACTOR, "Yua Mikami").unwrap()
        );
        // 片商不受多人作影响，照常归并
        assert_eq!(expand(&conn, ENTITY_STUDIO, "S1").unwrap().len(), 2);
    }

    #[test]
    fn purge_bad_source_then_rebuild_cleans_wrong_merge() {
        let conn = mem();
        // 两部单人片各自正确
        scrape(&conn, "AAA-1", &[("good", &[], &["三上悠亜"])]);
        scrape(&conn, "BBB-2", &[("good", &[], &["葵つかさ"])]);
        assert_ne!(
            resolve_entity(&conn, ENTITY_ACTOR, "三上悠亜").unwrap(),
            resolve_entity(&conn, ENTITY_ACTOR, "葵つかさ").unwrap()
        );
        // 坏源在 DDD-4 把两人各报 1 人（单人作误报）→ 误并三上悠亜与葵つかさ
        scrape(&conn, "DDD-4", &[("bad", &[], &["三上悠亜"])]);
        scrape(&conn, "DDD-4", &[("bad2", &[], &["葵つかさ"])]);
        assert_eq!(
            resolve_entity(&conn, ENTITY_ACTOR, "三上悠亜").unwrap(),
            resolve_entity(&conn, ENTITY_ACTOR, "葵つかさ").unwrap(),
            "构造的误并应已发生"
        );
        // 清洗：删掉坏源证据 → 重建 → 误并解开
        purge_source(&conn, "bad").unwrap();
        purge_source(&conn, "bad2").unwrap();
        rebuild(&conn).unwrap();
        assert_ne!(
            resolve_entity(&conn, ENTITY_ACTOR, "三上悠亜").unwrap(),
            resolve_entity(&conn, ENTITY_ACTOR, "葵つかさ").unwrap(),
            "删坏源 + 重建后应恢复为两个实体"
        );
    }

    #[test]
    fn block_survives_rescrape() {
        let conn = mem();
        scrape(&conn, "AAA-1", &[("s", &["广告垃圾名"], &[])]);
        add_block(&conn, ENTITY_STUDIO, "广告垃圾名").unwrap();
        rebuild(&conn).unwrap();
        assert!(resolve_entity(&conn, ENTITY_STUDIO, "广告垃圾名").unwrap().is_none());
        // 重刮（再次记录同名证据）也不应复活
        scrape(&conn, "AAA-1", &[("s", &["广告垃圾名"], &[])]);
        assert!(resolve_entity(&conn, ENTITY_STUDIO, "广告垃圾名").unwrap().is_none());
    }

    #[test]
    fn force_merge_links_unrelated_writings() {
        let conn = mem();
        scrape(&conn, "AAA-1", &[("s", &["IdeaPocket"], &[])]);
        scrape(&conn, "BBB-2", &[("s", &["アイデアポケット"], &[])]);
        assert_ne!(
            resolve_entity(&conn, ENTITY_STUDIO, "IdeaPocket").unwrap(),
            resolve_entity(&conn, ENTITY_STUDIO, "アイデアポケット").unwrap()
        );
        add_force_merge(
            &conn,
            ENTITY_STUDIO,
            &["IdeaPocket".into(), "アイデアポケット".into()],
        )
        .unwrap();
        rebuild(&conn).unwrap();
        assert_eq!(
            resolve_entity(&conn, ENTITY_STUDIO, "IdeaPocket").unwrap(),
            resolve_entity(&conn, ENTITY_STUDIO, "アイデアポケット").unwrap()
        );
    }

    #[test]
    fn force_merge_clears_prior_block_and_refreshes_writing() {
        let conn = mem();
        scrape(&conn, "AAA-1", &[("s", &[], &["山岸逢花"])]);
        // 编辑里把「山岸 あや花」改成「山岸あや花」=> 旧逻辑会拉黑同归一化键（含空格被去掉），名字消失
        add_force_merge(&conn, ENTITY_ACTOR, &["山岸逢花".into(), "山岸 あや花".into()]).unwrap();
        add_block(&conn, ENTITY_ACTOR, "山岸 あや花").unwrap();
        rebuild(&conn).unwrap();
        assert!(
            resolve_entity(&conn, ENTITY_ACTOR, "山岸あや花").unwrap().is_none(),
            "构造的误拉黑应已发生"
        );
        // 再次显式归并（最新写法，无空格）：应解除拉黑、名字回归，且以新写法展示
        add_force_merge(&conn, ENTITY_ACTOR, &["山岸逢花".into(), "山岸あや花".into()]).unwrap();
        rebuild(&conn).unwrap();
        assert!(
            resolve_entity(&conn, ENTITY_ACTOR, "山岸あや花").unwrap().is_some(),
            "显式归并应解除拉黑、名字回归"
        );
        let aliases = expand(&conn, ENTITY_ACTOR, "山岸逢花").unwrap();
        assert!(aliases.iter().any(|a| a.name == "山岸あや花"), "应以最新无空格写法存在");
        assert!(!aliases.iter().any(|a| a.name == "山岸 あや花"), "旧带空格写法应被替换掉");
    }

    #[test]
    fn rebuild_corrects_overeager_live_merge() {
        let conn = mem();
        // 第一次只看到 1 个女优（实时误判为单人作 → 绑定）
        scrape(&conn, "SSNI-1", &[("srcA", &[], &["三上悠亜"])]);
        assert!(resolve_entity(&conn, ENTITY_ACTOR, "三上悠亜").unwrap().is_some());
        // 后续证据显示其实是双人作
        record_evidence(&conn, "SSNI-1", ENTITY_ACTOR, "葵つかさ", "srcA").unwrap();
        // 重建：用全部证据判定为多人作 → 不应有番号→女优绑定
        rebuild(&conn).unwrap();
        let bound = designation_entity(&conn, "SSNI-1", ENTITY_ACTOR).unwrap();
        assert!(bound.is_none(), "重建后多人作不应绑定单一女优实体");
    }

    #[test]
    fn canonical_pin_overrides_script_rank() {
        let conn = mem();
        scrape(&conn, "AAA-1", &[("ja", &["エスワン"], &[]), ("en", &["S1"], &[])]);
        // 默认 canonical 是日文「エスワン」(script 0)
        assert_eq!(expand(&conn, ENTITY_STUDIO, "S1").unwrap()[0].name, "エスワン");
        add_canonical(&conn, ENTITY_STUDIO, "S1").unwrap();
        rebuild(&conn).unwrap();
        let aliases = expand(&conn, ENTITY_STUDIO, "エスワン").unwrap();
        let canonical = aliases.iter().find(|a| a.is_canonical).unwrap();
        assert_eq!(canonical.name, "S1");
    }
}
