//! 校正规则（`alias_overrides`）读写：`merge` 强制归并 / `block` 拉黑 / `canonical` 锁定展示名。
//!
//! 这些规则实时关联与 [`super::rebuild`] 都尊重，故人工修正与种子不会被重刮覆盖。

use std::collections::HashSet;

use rusqlite::{params, Connection};

use super::cluster::unify_names;
use super::text::normalize_name;

const KIND_MERGE: &str = "merge";
const KIND_BLOCK: &str = "block";
const KIND_CANONICAL: &str = "canonical";

pub(super) fn blocked_norms(
    conn: &Connection,
    entity_type: &str,
) -> rusqlite::Result<HashSet<String>> {
    let mut stmt = conn
        .prepare("SELECT name_norm FROM alias_overrides WHERE entity_type = ?1 AND kind = ?2")?;
    let set = stmt
        .query_map(params![entity_type, KIND_BLOCK], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<HashSet<_>>>()?;
    Ok(set)
}

pub(super) fn canonical_norms(
    conn: &Connection,
    entity_type: &str,
) -> rusqlite::Result<HashSet<String>> {
    let mut stmt = conn
        .prepare("SELECT name_norm FROM alias_overrides WHERE entity_type = ?1 AND kind = ?2")?;
    let set = stmt
        .query_map(params![entity_type, KIND_CANONICAL], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<HashSet<_>>>()?;
    Ok(set)
}

/// 校正：拉黑一个名字（永不入簇）。返回后需 [`super::rebuild`] 使其对存量生效。
pub fn add_block(conn: &Connection, entity_type: &str, name: &str) -> rusqlite::Result<()> {
    let norm = normalize_name(name);
    if norm.is_empty() {
        return Ok(());
    }
    conn.execute(
        "DELETE FROM alias_overrides WHERE kind = ?1 AND entity_type = ?2 AND name_norm = ?3",
        params![KIND_BLOCK, entity_type, norm],
    )?;
    conn.execute(
        "INSERT INTO alias_overrides (kind, entity_type, group_key, name, name_norm)
         VALUES (?1, ?2, NULL, ?3, ?4)",
        params![KIND_BLOCK, entity_type, name.trim(), norm],
    )?;
    Ok(())
}

/// 校正：锁定某名字为该实体展示名。
pub fn add_canonical(conn: &Connection, entity_type: &str, name: &str) -> rusqlite::Result<()> {
    let norm = normalize_name(name);
    if norm.is_empty() {
        return Ok(());
    }
    conn.execute(
        "DELETE FROM alias_overrides WHERE kind = ?1 AND entity_type = ?2 AND name_norm = ?3",
        params![KIND_CANONICAL, entity_type, norm],
    )?;
    conn.execute(
        "INSERT INTO alias_overrides (kind, entity_type, group_key, name, name_norm)
         VALUES (?1, ?2, NULL, ?3, ?4)",
        params![KIND_CANONICAL, entity_type, name.trim(), norm],
    )?;
    Ok(())
}

/// 校正：强制把一组名字归并为同一实体（自动关联没认出的等价名时用）。
pub fn add_force_merge(
    conn: &Connection,
    entity_type: &str,
    names: &[String],
) -> rusqlite::Result<()> {
    let valid: Vec<&String> = names
        .iter()
        .filter(|n| !normalize_name(n).is_empty())
        .collect();
    if valid.len() < 2 {
        return Ok(());
    }
    // group_key 用首名归一化值，稳定且便于去重
    let group_key = format!("manual:{}", normalize_name(valid[0]));
    for name in valid {
        let norm = normalize_name(name);
        // 显式归并 = 用户最新意图：先按归一化键清掉该名字旧的「拉黑」与旧写法的「归并」，
        // 既解除可能存在的拉黑（恢复被误删的名字），又让最新书写形态成为展示名
        // （否则同键的旧写法——如带空格版——因 id 更小会在 rebuild 时盖住新写法）。
        conn.execute(
            "DELETE FROM alias_overrides
             WHERE entity_type = ?1 AND name_norm = ?2 AND kind IN (?3, ?4)",
            params![entity_type, norm, KIND_MERGE, KIND_BLOCK],
        )?;
        conn.execute(
            "INSERT INTO alias_overrides (kind, entity_type, group_key, name, name_norm)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![KIND_MERGE, entity_type, group_key, name.trim(), norm],
        )?;
    }
    Ok(())
}

/// 立即把一组名字归并到投影簇（种子导入用，避免等到下次 rebuild 才生效）。
pub fn apply_force_merge_group(
    conn: &Connection,
    entity_type: &str,
    names: &[String],
) -> rusqlite::Result<()> {
    let blocked = blocked_norms(conn, entity_type)?;
    let refs: Vec<&str> = names
        .iter()
        .filter(|n| !blocked.contains(&normalize_name(n)))
        .map(|n| n.as_str())
        .collect();
    if !refs.is_empty() {
        unify_names(conn, entity_type, &refs, "seed")?;
    }
    Ok(())
}

/// 读取所有 merge 规则组（用于 rebuild）。返回每组的 (name, name_norm) 列表。
pub(super) fn merge_groups(
    conn: &Connection,
    entity_type: &str,
) -> rusqlite::Result<Vec<Vec<(String, String)>>> {
    let mut stmt = conn.prepare(
        "SELECT group_key, name, name_norm FROM alias_overrides
         WHERE entity_type = ?1 AND kind = ?2 ORDER BY group_key, id",
    )?;
    let rows = stmt
        .query_map(params![entity_type, KIND_MERGE], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut groups: Vec<Vec<(String, String)>> = Vec::new();
    let mut cur_key: Option<String> = None;
    for (key, name, norm) in rows {
        if cur_key.as_deref() != Some(key.as_str()) {
            groups.push(Vec::new());
            cur_key = Some(key);
        }
        groups.last_mut().unwrap().push((name, norm));
    }
    Ok(groups)
}
