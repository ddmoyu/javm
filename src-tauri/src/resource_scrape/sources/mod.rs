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
            name: "JavBus".to_string(),
            enabled: true,
        },
        ResourceSite {
            id: "javmenu".to_string(),
            name: "JavMenu".to_string(),
            enabled: true,
        },
        ResourceSite {
            id: "javsb".to_string(),
            name: "JavSB".to_string(),
            enabled: true,
        },
        ResourceSite {
            id: "javxx".to_string(),
            name: "JAVXX".to_string(),
            enabled: true,
        },
        ResourceSite {
            id: "javplace".to_string(),
            name: "JavPlace".to_string(),
            enabled: true,
        },
        ResourceSite {
            id: "projectjav".to_string(),
            name: "ProjectJav".to_string(),
            enabled: true,
        },
        ResourceSite {
            id: "3xplanet".to_string(),
            name: "3xplanet".to_string(),
            enabled: true,
        },
        ResourceSite {
            id: "freejavbt".to_string(),
            name: "FreeJavBT".to_string(),
            enabled: true,
        },
        ResourceSite {
            id: "javlibrary".to_string(),
            name: "JavLibrary".to_string(),
            enabled: true,
        },
        ResourceSite {
            id: "javguru".to_string(),
            name: "JavGuru".to_string(),
            enabled: true,
        },
        ResourceSite {
            id: "javtiful".to_string(),
            name: "Javtiful".to_string(),
            enabled: true,
        },
        ResourceSite {
            id: "123av".to_string(),
            name: "123AV".to_string(),
            enabled: true,
        },
        ResourceSite {
            id: "myjav".to_string(),
            name: "MyJav".to_string(),
            enabled: true,
        },
    ]
}
