//! 演员中心模块：演员档案 + 作品全集（star 页抓取）+ 本地匹配。
//!
//! 抓取走 `resource_scrape::actor_provider`（star 页解析）+ 反爬引擎;落库复用
//! `db::Database` 的 `upsert_actor_work` / `relink_actor_works_local` / `update_actor_profile`。

pub mod commands;
