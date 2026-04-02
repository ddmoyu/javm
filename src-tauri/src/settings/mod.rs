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
    pub mode: String,
    pub language: String,
    #[serde(default)]
    pub proxy: ProxySettings,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProxySettings {
    #[serde(rename = "type")]
    pub proxy_type: String,
    pub host: String,
    pub port: u16,
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
    pub scan_paths: Vec<String>,
    #[serde(rename = "viewMode", default = "default_view_mode")]
    pub view_mode: String,
    #[serde(rename = "playMethod", default = "default_play_method")]
    pub play_method: String,
    #[serde(rename = "coverClickToPlay", default = "default_true")]
    pub cover_click_to_play: bool,
}

fn default_play_method() -> String {
    "software".to_string()
}

fn default_view_mode() -> String {
    "card".to_string()
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

    let default_site_enabled = scrape
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

pub fn resolve_active_scrape_site(scrape: &ScrapeSettings) -> Option<ResourceSite> {
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIProvider {
    pub id: String,
    pub provider: String,
    pub name: String,
    #[serde(rename = "apiKey")]
    pub api_key: String, // 存储时已加密
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
            keywords: Vec::new(),
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
