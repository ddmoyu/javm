//! 数据源注册表与资源网站配置
//!
//! 定义 Source trait、ResourceSite 结构体，
//! 以及数据源注册和默认网站配置函数。

pub mod av123;
pub mod common;
pub mod freejavbt;
pub mod javbus;
pub mod javguru;
pub mod javlibrary;
pub mod javmenu;
pub mod javplace;
pub mod javsb;
pub mod javtiful;
pub mod javxx;
pub mod myjav;
pub mod projectjav;
pub mod threexplanet;

#[cfg(test)]
mod parser_robustness_test;

use serde::{Deserialize, Serialize};
pub use super::types::SearchResult;

/// 数据源 trait
///
/// 每个数据源实现 `parse(html) -> Option<SearchResult>` 和 `build_url(code) -> String`。
/// 搜索时并发请求所有数据源，收集成功结果。
pub trait Source: Send + Sync {
    /// 数据源名称
    fn name(&self) -> &str;
    /// 根据番号构建请求 URL
    fn build_url(&self, code: &str) -> String;
    /// 解析 HTML 提取搜索结果
    fn parse(&self, html: &str, code: &str) -> Option<SearchResult>;
    /// 从搜索结果页提取详情页 URL（需要二次请求的数据源覆盖此方法）
    fn extract_detail_url(&self, _html: &str, _code: &str) -> Option<String> {
        None
    }
}

/// 资源网站定义
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceSite {
    /// 唯一标识，如 "javbus"
    pub id: String,
    /// 显示名称，如 "JavBus"
    pub name: String,
    /// 是否启用
    pub enabled: bool,
    /// 累计平均丰富度得分（0-100），多次刮削结果加权平均
    #[serde(rename = "avgScore", default, skip_serializing_if = "Option::is_none")]
    pub avg_score: Option<u32>,
    /// 累计刮削次数（有效返回结果的次数）
    #[serde(rename = "scrapeCount", default, skip_serializing_if = "Option::is_none")]
    pub scrape_count: Option<u32>,
}

/// 获取所有已注册的数据源
pub fn all_sources() -> Vec<Box<dyn Source>> {
    vec![
        Box::new(javbus::Javbus),
        Box::new(javmenu::Javmenu),
        Box::new(javsb::JavSb),
        Box::new(javxx::JavXX),
        Box::new(javplace::JavPlace),
        Box::new(projectjav::ProjectJav),
        Box::new(threexplanet::ThreeXPlanet),
        Box::new(freejavbt::FreeJavBT),
        Box::new(javlibrary::JavLibrary),
        Box::new(javguru::JavGuru),
        Box::new(javtiful::Javtiful),
        Box::new(av123::Av123),
        Box::new(myjav::MyJav),
    ]
}

/// 返回默认资源网站配置列表
pub fn default_sites() -> Vec<ResourceSite> {
    vec![
        ResourceSite {
            id: "javbus".to_string(),
            name: "数据源 1".to_string(),
            enabled: true,
            avg_score: None,
            scrape_count: None,
        },
        ResourceSite {
            id: "javmenu".to_string(),
            name: "数据源 2".to_string(),
            enabled: true,
            avg_score: None,
            scrape_count: None,
        },
        ResourceSite {
            id: "javsb".to_string(),
            name: "数据源 3".to_string(),
            enabled: true,
            avg_score: None,
            scrape_count: None,
        },
        ResourceSite {
            id: "javxx".to_string(),
            name: "数据源 4".to_string(),
            enabled: true,
            avg_score: None,
            scrape_count: None,
        },
        ResourceSite {
            id: "javplace".to_string(),
            name: "数据源 5".to_string(),
            enabled: true,
            avg_score: None,
            scrape_count: None,
        },
        ResourceSite {
            id: "projectjav".to_string(),
            name: "数据源 6".to_string(),
            enabled: true,
            avg_score: None,
            scrape_count: None,
        },
        ResourceSite {
            id: "3xplanet".to_string(),
            name: "数据源 7".to_string(),
            enabled: true,
            avg_score: None,
            scrape_count: None,
        },
        ResourceSite {
            id: "freejavbt".to_string(),
            name: "数据源 8".to_string(),
            enabled: true,
            avg_score: None,
            scrape_count: None,
        },
        ResourceSite {
            id: "javlibrary".to_string(),
            name: "数据源 9".to_string(),
            enabled: true,
            avg_score: None,
            scrape_count: None,
        },
        ResourceSite {
            id: "javguru".to_string(),
            name: "数据源 10".to_string(),
            enabled: true,
            avg_score: None,
            scrape_count: None,
        },
        ResourceSite {
            id: "javtiful".to_string(),
            name: "数据源 11".to_string(),
            enabled: true,
            avg_score: None,
            scrape_count: None,
        },
        ResourceSite {
            id: "123av".to_string(),
            name: "数据源 12".to_string(),
            enabled: true,
            avg_score: None,
            scrape_count: None,
        },
        ResourceSite {
            id: "myjav".to_string(),
            name: "数据源 13".to_string(),
            enabled: true,
            avg_score: None,
            scrape_count: None,
        },
    ]
}
