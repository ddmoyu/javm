mod encryption;
pub mod commands;

pub use commands::get_settings;

use crate::resource_scrape::sources::{self, ResourceSite};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    pub theme: ThemeSettings,
    pub general: GeneralSettings,
    #[serde(default)]
    pub download: DownloadSettings,
    #[serde(default)]
    pub scrape: ScrapeSettings,
    #[serde(default)]
    pub ai: AISettings,
    #[serde(default)]
    pub ad_filter: AdFilterSettings,
    #[serde(default, rename = "videoPlayer")]
    pub video_player: VideoPlayerSettings,
    #[serde(default, rename = "mainWindow")]
    pub main_window: MainWindowSettings,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ThemeSettings {
    #[serde(default = "default_theme_mode")]
    pub mode: String,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default)]
    pub proxy: ProxySettings,
}

fn default_theme_mode() -> String {
    "system".to_string()
}

fn default_language() -> String {
    "zh-CN".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProxySettings {
    #[serde(rename = "type", default = "default_proxy_type")]
    pub proxy_type: String,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_proxy_port")]
    pub port: u16,
}

fn default_proxy_type() -> String {
    "system".to_string()
}

fn default_proxy_port() -> u16 {
    7890
}

impl Default for ProxySettings {
    fn default() -> Self {
        Self {
            proxy_type: "system".to_string(),
            host: String::new(),
            port: 7890,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GeneralSettings {
    #[serde(default)]
    pub scan_paths: Vec<String>,
    #[serde(rename = "viewMode", default = "default_view_mode")]
    pub view_mode: String,
    #[serde(rename = "playMethod", default = "default_play_method")]
    pub play_method: String,
    #[serde(rename = "coverClickToPlay", default = "default_true")]
    pub cover_click_to_play: bool,
    #[serde(rename = "coverType", default = "default_cover_type")]
    pub cover_type: String,
}

fn default_play_method() -> String {
    "software".to_string()
}

fn default_view_mode() -> String {
    "card".to_string()
}

fn default_cover_type() -> String {
    "landscape".to_string()
}

fn default_true() -> bool {
    true
}

fn default_false() -> bool {
    false
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DownloadSettings {
    #[serde(rename = "savePath")]
    pub save_path: String,
    pub concurrent: u32,
    #[serde(rename = "autoRetry")]
    pub auto_retry: bool,
    #[serde(rename = "maxRetries")]
    pub max_retries: u32,
    #[serde(rename = "downloaderPriority")]
    pub downloader_priority: Vec<String>,
    #[serde(default)]
    pub tools: Vec<DownloaderTool>,
    #[serde(default = "default_true", rename = "autoScrape", alias = "autoscrape")]
    pub auto_scrape: bool,
    /// 下载源（资源链接站点）列表，含启用状态与下载成功次数（用于排序/评分）
    #[serde(default = "default_download_sources")]
    pub sources: Vec<DownloadSource>,
}

/// 下载源（资源链接视频站）。模板/名称随版本由代码默认值决定，
/// 用户仅持久化启用状态与成功次数。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DownloadSource {
    pub id: String,
    pub name: String,
    #[serde(rename = "urlTemplate")]
    pub url_template: String,
    pub enabled: bool,
    /// 下载成功累计次数：越高排名越靠前
    #[serde(rename = "successCount", default)]
    pub success_count: u32,
}

fn default_download_sources() -> Vec<DownloadSource> {
    crate::resource_scrape::video_finder::DEFAULT_DOWNLOAD_SITES
        .iter()
        .map(|(id, name, tpl)| DownloadSource {
            id: id.to_string(),
            name: name.to_string(),
            url_template: tpl.to_string(),
            enabled: true,
            success_count: 0,
        })
        .collect()
}

/// 合并：以代码默认列表为基准（名称/模板随版本更新），叠加用户保存的启用状态与成功次数。
/// 不在默认列表中的旧站点会被自然丢弃。
fn merge_download_sources(saved: &[DownloadSource]) -> Vec<DownloadSource> {
    let mut merged = default_download_sources();
    for site in &mut merged {
        if let Some(s) = saved.iter().find(|x| x.id == site.id) {
            site.enabled = s.enabled;
            site.success_count = s.success_count;
        }
    }
    merged
}

pub fn normalize_download_settings(download: &mut DownloadSettings) {
    download.sources = merge_download_sources(&download.sources);
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DownloaderTool {
    pub name: String,
    pub executable: String,
    #[serde(rename = "customPath")]
    pub custom_path: Option<String>,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScrapeSettings {
    pub concurrent: u32,
    #[serde(rename = "scraperPriority")]
    pub scraper_priority: Vec<String>,
    #[serde(rename = "maxWebviewWindows", default = "default_scrape_max_webview_windows")]
    pub max_webview_windows: u32,
    #[serde(rename = "webviewEnabled", default)]
    pub webview_enabled: bool,
    #[serde(rename = "webviewFallbackEnabled", default)]
    pub webview_fallback_enabled: bool,
    #[serde(rename = "devShowWebview", default)]
    pub dev_show_webview: bool,
    #[serde(rename = "defaultSite", default = "default_scrape_default_site")]
    pub default_site: String,
    #[serde(default = "default_scrape_sites")]
    pub sites: Vec<ResourceSite>,
    /// 资源链接查找器上次选择的视频站点 id（与 sites 不同，独立的视频源列表）
    #[serde(rename = "linkFinderSite", default = "default_link_finder_site")]
    pub link_finder_site: String,
    /// 反爬工具箱配置（限速/退避/UA 轮换/代理池/镜像轮换）
    #[serde(rename = "antiBlock", default)]
    pub anti_block: AntiBlockSettings,
}

/// 反爬工具箱设置。字段与 `resource_scrape::anti_block::config::AntiBlockConfig` 对应，
/// 由引擎在启动/保存时从 settings.json 读取。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AntiBlockSettings {
    /// 总开关：关闭后退化为系统代理直连 + 不限速 + 不重试
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 请求间隔限速开关
    #[serde(rename = "rateLimitEnabled", default = "default_true")]
    pub rate_limit_enabled: bool,
    /// 同一 host 两次请求的最小间隔（毫秒）
    #[serde(rename = "minIntervalMs", default = "default_anti_block_min_interval")]
    pub min_interval_ms: u64,
    /// 同一 host 两次请求的最大间隔（毫秒）
    #[serde(rename = "maxIntervalMs", default = "default_anti_block_max_interval")]
    pub max_interval_ms: u64,
    /// 失败最大重试次数（不含首次）
    #[serde(rename = "maxRetries", default = "default_anti_block_max_retries")]
    pub max_retries: u32,
    /// UA / 指纹轮换开关
    #[serde(rename = "uaRotationEnabled", default = "default_true")]
    pub ua_rotation_enabled: bool,
    /// 多镜像域名轮换开关
    #[serde(rename = "mirrorRotationEnabled", default = "default_true")]
    pub mirror_rotation_enabled: bool,
    /// 成功率加权代理池开关
    #[serde(rename = "proxyPoolEnabled", default)]
    pub proxy_pool_enabled: bool,
    /// 代理 URL 列表
    #[serde(default)]
    pub proxies: Vec<String>,
}

fn default_anti_block_min_interval() -> u64 {
    800
}

fn default_anti_block_max_interval() -> u64 {
    2000
}

fn default_anti_block_max_retries() -> u32 {
    2
}

impl Default for AntiBlockSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            rate_limit_enabled: true,
            min_interval_ms: 800,
            max_interval_ms: 2000,
            max_retries: 2,
            ua_rotation_enabled: true,
            mirror_rotation_enabled: true,
            proxy_pool_enabled: false,
            proxies: Vec::new(),
        }
    }
}

fn normalize_anti_block_settings(anti_block: &mut AntiBlockSettings) {
    if anti_block.min_interval_ms > anti_block.max_interval_ms {
        std::mem::swap(&mut anti_block.min_interval_ms, &mut anti_block.max_interval_ms);
    }
    anti_block.max_interval_ms = anti_block.max_interval_ms.min(60_000);
    anti_block.min_interval_ms = anti_block.min_interval_ms.min(anti_block.max_interval_ms);
    anti_block.max_retries = anti_block.max_retries.min(5);

    let mut seen = std::collections::HashSet::new();
    let proxies = std::mem::take(&mut anti_block.proxies);
    anti_block.proxies = proxies
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty() && seen.insert(p.clone()))
        .collect();
}

#[derive(Debug, Clone, Copy)]
pub struct ScrapeFetchSettings {
    pub webview_enabled: bool,
    pub webview_fallback_enabled: bool,
    pub dev_show_webview: bool,
    pub max_webview_windows: usize,
}

fn default_scrape_default_site() -> String {
    sources::default_sites()
        .into_iter()
        .find(|site| site.enabled)
        .map(|site| site.id)
        .unwrap_or_else(|| "javbus".to_string())
}

fn default_link_finder_site() -> String {
    "missav".to_string()
}

fn default_scrape_sites() -> Vec<ResourceSite> {
    sources::default_sites()
}

fn default_scrape_max_webview_windows() -> u32 {
    3
}

fn merge_scrape_sites(saved_sites: &[ResourceSite]) -> Vec<ResourceSite> {
    let mut merged = sources::default_sites();
    for site in &mut merged {
        if let Some(saved) = saved_sites.iter().find(|item| item.id == site.id) {
            site.enabled = saved.enabled;
            site.avg_score = saved.avg_score;
            site.scrape_count = saved.scrape_count;
        }
    }
    merged
}

fn normalize_scrape_settings(scrape: &mut ScrapeSettings) {
    scrape.concurrent = scrape.concurrent.clamp(1, 10);
    scrape.max_webview_windows = scrape.max_webview_windows.clamp(1, 8);
    scrape.sites = merge_scrape_sites(&scrape.sites);
    normalize_anti_block_settings(&mut scrape.anti_block);

    if scrape.scraper_priority.is_empty() {
        scrape.scraper_priority = scrape.sites.iter().map(|site| site.id.clone()).collect();
    } else {
        scrape.scraper_priority = scrape
            .scraper_priority
            .iter()
            .filter(|site_id| scrape.sites.iter().any(|site| &site.id == *site_id))
            .cloned()
            .collect();
    }

    let default_site_enabled = scrape.default_site == AUTO_HIGHEST_SCORE_SITE
        || scrape
            .sites
            .iter()
            .any(|site| site.id == scrape.default_site && site.enabled);
    if !default_site_enabled {
        scrape.default_site = scrape
            .sites
            .iter()
            .find(|site| site.enabled)
            .map(|site| site.id.clone())
            .unwrap_or_else(default_scrape_default_site);
    }
}

pub fn enabled_scrape_sites(scrape: &ScrapeSettings) -> Vec<ResourceSite> {
    scrape
        .sites
        .iter()
        .filter(|site| site.enabled)
        .cloned()
        .collect()
}

/// `default_site` 的特殊取值：自动选择累计丰富度得分最高的已启用数据源。
pub const AUTO_HIGHEST_SCORE_SITE: &str = "__auto_highest_score__";

pub fn resolve_active_scrape_site(scrape: &ScrapeSettings) -> Option<ResourceSite> {
    // 自动模式：在已启用数据源中选丰富度得分最高者（得分并列时取靠前者）；
    // 都没有得分时退化为第一个已启用的数据源。
    if scrape.default_site == AUTO_HIGHEST_SCORE_SITE {
        let mut best: Option<&ResourceSite> = None;
        for site in scrape.sites.iter().filter(|s| s.enabled) {
            let cur = (site.avg_score.unwrap_or(0), site.scrape_count.unwrap_or(0));
            let is_better = match best {
                Some(b) => cur > (b.avg_score.unwrap_or(0), b.scrape_count.unwrap_or(0)),
                None => true,
            };
            if is_better {
                best = Some(site);
            }
        }
        return best.cloned();
    }

    scrape
        .sites
        .iter()
        .find(|site| site.id == scrape.default_site && site.enabled)
        .cloned()
        .or_else(|| scrape.sites.iter().find(|site| site.enabled).cloned())
}

pub fn resolve_scrape_fetch_settings(scrape: &ScrapeSettings) -> ScrapeFetchSettings {
    ScrapeFetchSettings {
        webview_enabled: scrape.webview_enabled,
        webview_fallback_enabled: scrape.webview_fallback_enabled,
        dev_show_webview: cfg!(debug_assertions) && scrape.dev_show_webview,
        max_webview_windows: scrape.max_webview_windows.max(1) as usize,
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AISettings {
    pub providers: Vec<AIProvider>,
    #[serde(rename = "cacheEnabled")]
    pub cache_enabled: bool,
    #[serde(rename = "cacheDuration")]
    pub cache_duration: u32,
    #[serde(
        default = "default_false",
        rename = "translateScrapeResult",
        alias = "translate_scrape_result"
    )]
    pub translate_scrape_result: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AdFilterSettings {
    pub keywords: Vec<String>,
    #[serde(default)]
    pub exclude_keywords: Vec<String>,
}

const DEFAULT_AD_FILTER_KEYWORDS: &[&str] = &["全網網黃國"];

fn normalize_keyword_list(keywords: &mut Vec<String>) {
    let mut normalized = Vec::new();

    for keyword in keywords.drain(..) {
        let trimmed = keyword.trim();
        if trimmed.is_empty() {
            continue;
        }

        let exists = normalized
            .iter()
            .any(|item: &String| item.eq_ignore_ascii_case(trimmed) || item == trimmed);
        if !exists {
            normalized.push(trimmed.to_string());
        }
    }

    *keywords = normalized;
}

pub fn normalize_ad_filter_settings(ad_filter: &mut AdFilterSettings) {
    normalize_keyword_list(&mut ad_filter.keywords);
    normalize_keyword_list(&mut ad_filter.exclude_keywords);

    for keyword in DEFAULT_AD_FILTER_KEYWORDS {
        if !ad_filter.keywords.iter().any(|item| item == keyword) {
            ad_filter.keywords.push((*keyword).to_string());
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIProvider {
    pub id: String,
    pub provider: String,
    pub name: String,
    #[serde(rename = "apiKey")]
    pub api_key: String, // 存储时混淆（非真正加密，见 encryption.rs 警示）
    pub endpoint: Option<String>,
    pub model: String,
    pub priority: u32,
    pub active: bool,
    #[serde(rename = "rateLimit")]
    pub rate_limit: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VideoPlayerSettings {
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    #[serde(rename = "alwaysOnTop")]
    pub always_on_top: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MainWindowSettings {
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub x: Option<f64>,
    pub y: Option<f64>,
}

impl Default for MainWindowSettings {
    fn default() -> Self {
        Self {
            width: None,
            height: None,
            x: None,
            y: None,
        }
    }
}

impl Default for VideoPlayerSettings {
    fn default() -> Self {
        Self {
            width: None,
            height: None,
            x: None,
            y: None,
            always_on_top: false,
        }
    }
}

// Default implementations
impl Default for DownloadSettings {
    fn default() -> Self {
        Self {
            save_path: String::new(),
            concurrent: 3,
            auto_retry: true,
            max_retries: 3,
            downloader_priority: vec!["N_m3u8DL-RE".to_string(), "ffmpeg".to_string()],
            tools: vec![
                DownloaderTool {
                    name: "N_m3u8DL-RE".to_string(),
                    executable: "N_m3u8DL-RE".to_string(),
                    custom_path: None,
                    enabled: true,
                    status: None,
                },
                DownloaderTool {
                    name: "ffmpeg".to_string(),
                    executable: "ffmpeg".to_string(),
                    custom_path: None,
                    enabled: true,
                    status: None,
                },
            ],
            auto_scrape: true,
            sources: default_download_sources(),
        }
    }
}

impl Default for ScrapeSettings {
    fn default() -> Self {
        Self {
            concurrent: 5,
            scraper_priority: vec!["javbus".to_string(), "javmenu".to_string(), "javxx".to_string()],
            max_webview_windows: default_scrape_max_webview_windows(),
            webview_enabled: false,
            webview_fallback_enabled: false,
            dev_show_webview: false,
            default_site: default_scrape_default_site(),
            sites: default_scrape_sites(),
            link_finder_site: default_link_finder_site(),
            anti_block: AntiBlockSettings::default(),
        }
    }
}

impl Default for AISettings {
    fn default() -> Self {
        Self {
            providers: Vec::new(),
            cache_enabled: true,
            cache_duration: 3600,
            translate_scrape_result: false,
        }
    }
}

impl Default for AdFilterSettings {
    fn default() -> Self {
        Self {
            keywords: DEFAULT_AD_FILTER_KEYWORDS
                .iter()
                .map(|keyword| (*keyword).to_string())
                .collect(),
            exclude_keywords: Vec::new(),
        }
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: ThemeSettings {
                mode: "system".to_string(),
                language: "zh-CN".to_string(),
                proxy: ProxySettings::default(),
            },
            general: GeneralSettings {
                scan_paths: Vec::new(),
                view_mode: "card".to_string(),
                play_method: "software".to_string(),
                cover_click_to_play: true,
                cover_type: "landscape".to_string(),
            },
            download: DownloadSettings::default(),
            scrape: ScrapeSettings::default(),
            ai: AISettings::default(),
            ad_filter: AdFilterSettings::default(),
            video_player: VideoPlayerSettings::default(),
            main_window: MainWindowSettings::default(),
        }
    }
}

pub(crate) fn get_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| format!("无法获取应用配置目录: {}", e))?;
    Ok(config_dir.join("settings.json"))
}
