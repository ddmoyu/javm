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
    #[serde(default)]
    pub metatube: MetaTubeSettings,
    #[serde(default)]
    pub update: UpdateSettings,
    #[serde(default)]
    pub metadata: MetadataSettings,
}

/// 元数据（NFO + 图片）存储设置
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MetadataSettings {
    /// 存储模式："follow_video"（跟随视频，默认）/ "independent"（独立目录）
    #[serde(rename = "storageMode", default = "default_metadata_storage_mode")]
    pub storage_mode: String,
    /// 独立目录模式下的元数据根目录（绝对路径）
    #[serde(rename = "rootDir", default)]
    pub root_dir: String,
}

/// 元数据独立目录模式的标识值
pub const METADATA_MODE_INDEPENDENT: &str = "independent";

fn default_metadata_storage_mode() -> String {
    "follow_video".to_string()
}

impl Default for MetadataSettings {
    fn default() -> Self {
        Self {
            storage_mode: default_metadata_storage_mode(),
            root_dir: String::new(),
        }
    }
}

impl MetadataSettings {
    /// 是否启用独立目录模式（需选择 independent 且根目录非空）
    pub fn is_independent(&self) -> bool {
        self.storage_mode == METADATA_MODE_INDEPENDENT && !self.root_dir.trim().is_empty()
    }
}

/// 应用更新设置
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UpdateSettings {
    /// 更新通道："stable"（仅正式版）/ "rc"（含 RC）/ "beta"（含 Beta 和 RC）
    #[serde(default = "default_update_channel")]
    pub channel: String,
}

fn default_update_channel() -> String {
    "stable".to_string()
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            channel: default_update_channel(),
        }
    }
}

/// MetaTube sidecar 聚合源设置
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MetaTubeSettings {
    /// 是否启用（默认开启；关闭则不拉起 sidecar、该源被跳过）
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 偏好的 provider 列表（搜索时优先；空 = 服务端默认全部）
    #[serde(default)]
    pub providers: Vec<String>,
}

impl Default for MetaTubeSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            providers: Vec::new(),
        }
    }
}

impl MetaTubeSettings {
    /// 派生 sidecar 运行配置
    pub fn to_config(&self) -> crate::metatube::MetaTubeConfig {
        crate::metatube::MetaTubeConfig {
            enabled: self.enabled,
            providers: self.providers.clone(),
            extra_args: Vec::new(),
        }
    }
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
    /// 演员面板作品卡片大小（网格 min 列宽 px）
    #[serde(rename = "actorCardSize", default = "default_actor_card_size")]
    pub actor_card_size: u32,
}

fn default_play_method() -> String {
    "software".to_string()
}

fn default_actor_card_size() -> u32 {
    160
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
        .map(|s| DownloadSource {
            id: s.id.to_string(),
            name: s.name.to_string(),
            url_template: s.url_template.to_string(),
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
    #[serde(rename = "linkFinderConcurrency", default = "default_link_finder_concurrency")]
    pub link_finder_concurrency: u32,
    #[serde(rename = "linkFinderSourceTimeoutSecs", default = "default_link_finder_source_timeout")]
    pub link_finder_source_timeout_secs: u32,
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
    /// 一键无码模式：开启后所有刮削强制走无码路由（番号无论有码无码都视为无码，
    /// 纳入无码/综合源、跳过纯有码源）。有码无码分轨·全局开关。
    #[serde(rename = "uncensoredMode", default)]
    pub uncensored_mode: bool,
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

fn default_link_finder_concurrency() -> u32 {
    3
}

fn default_link_finder_source_timeout() -> u32 {
    60
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
    scrape.link_finder_concurrency = scrape.link_finder_concurrency.clamp(1, 3);
    scrape.link_finder_source_timeout_secs = scrape.link_finder_source_timeout_secs.clamp(30, 600);
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
            link_finder_concurrency: default_link_finder_concurrency(),
            link_finder_source_timeout_secs: default_link_finder_source_timeout(),
            webview_enabled: false,
            webview_fallback_enabled: false,
            dev_show_webview: false,
            default_site: default_scrape_default_site(),
            sites: default_scrape_sites(),
            link_finder_site: default_link_finder_site(),
            anti_block: AntiBlockSettings::default(),
            uncensored_mode: false,
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
                actor_card_size: 160,
            },
            download: DownloadSettings::default(),
            scrape: ScrapeSettings::default(),
            ai: AISettings::default(),
            ad_filter: AdFilterSettings::default(),
            video_player: VideoPlayerSettings::default(),
            main_window: MainWindowSettings::default(),
            metatube: MetaTubeSettings::default(),
            update: UpdateSettings::default(),
            metadata: MetadataSettings::default(),
        }
    }
}

pub(crate) fn get_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| format!("无法获取应用配置目录: {}", e))?;
    Ok(config_dir.join("settings.json"))
}
