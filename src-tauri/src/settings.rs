use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use crate::resource_scrape::sources::{self, ResourceSite};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

// 简单的XOR加密密钥
const ENCRYPTION_KEY: &[u8] = b"javm_secure_key_2024";

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
    #[serde(rename = "enableVision")]
    pub enable_vision: bool,
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
            enable_vision: false,
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

// 简单的XOR加密/解密
fn xor_cipher(data: &[u8], key: &[u8]) -> Vec<u8> {
    data.iter()
        .enumerate()
        .map(|(i, &byte)| byte ^ key[i % key.len()])
        .collect()
}

/// 加密API Key
pub fn encrypt_api_key(api_key: &str) -> String {
    let encrypted = xor_cipher(api_key.as_bytes(), ENCRYPTION_KEY);
    BASE64.encode(encrypted)
}

/// 解密API Key
pub fn decrypt_api_key(encrypted: &str) -> Result<String, String> {
    let decoded = BASE64.decode(encrypted).map_err(|e| e.to_string())?;
    let decrypted = xor_cipher(&decoded, ENCRYPTION_KEY);
    String::from_utf8(decrypted).map_err(|e| e.to_string())
}

/// 加密设置中的所有API Key
fn encrypt_settings(settings: &mut AppSettings) {
    for provider in &mut settings.ai.providers {
        if !provider.api_key.is_empty() && !provider.api_key.starts_with("enc:") {
            provider.api_key = format!("enc:{}", encrypt_api_key(&provider.api_key));
        }
    }
}

/// 解密设置中的所有API Key
fn decrypt_settings(settings: &mut AppSettings) {
    for provider in &mut settings.ai.providers {
        if let Some(encrypted) = provider.api_key.strip_prefix("enc:") {
            if let Ok(decrypted) = decrypt_api_key(encrypted) {
                provider.api_key = decrypted;
            }
        }
    }
}

fn get_settings_path(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap().join("settings.json")
}

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> Result<AppSettings, String> {
    let path = get_settings_path(&app);
    if !path.exists() {
        return Ok(AppSettings::default());
    }

    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut settings: AppSettings = serde_json::from_str(&content).unwrap_or_default();

    // 解密API Key
    decrypt_settings(&mut settings);
    normalize_scrape_settings(&mut settings.scrape);

    Ok(settings)
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, mut settings: AppSettings) -> Result<(), String> {
    let path = get_settings_path(&app);
    let dir = path.parent().unwrap();
    if !dir.exists() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }

    // 加密API Key后再保存
    encrypt_settings(&mut settings);
    normalize_scrape_settings(&mut settings.scrape);

    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, &content).map_err(|e| e.to_string())?;

    // 刷新全局代理缓存
    if let Ok(config_dir) = app.path().app_config_dir() {
        crate::utils::proxy::refresh(&config_dir);
    }

    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TestApiRequest {
    pub provider: String,
    pub model: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    pub endpoint: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TestApiResponse {
    pub success: bool,
    pub message: String,
}

/// 测试AI API连接
#[tauri::command]
pub async fn test_ai_api(request: TestApiRequest) -> Result<TestApiResponse, String> {
    let client = crate::utils::proxy::apply_proxy_auto(
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15)),
    )
    .map_err(|e| e.to_string())?
    .build()
    .map_err(|e| e.to_string())?;

    // 构建测试端点URL
    let base_url = request
        .endpoint
        .unwrap_or_else(|| match request.provider.as_str() {
            "openai" => "https://api.openai.com/v1".to_string(),
            "deepseek" => "https://api.deepseek.com/v1".to_string(),
            "claude" => "https://api.anthropic.com/v1".to_string(),
            _ => String::new(),
        });

    if base_url.is_empty() {
        return Ok(TestApiResponse {
            success: false,
            message: "请提供有效的API端点".to_string(),
        });
    }

    // 根据provider构建不同的测试请求
    if request.provider == "claude" {
        // Claude使用messages端点
        let endpoint = format!("{}/messages", base_url.trim_end_matches('/'));

        let test_payload = serde_json::json!({
            "model": request.model,
            "max_tokens": 1,
            "messages": [{
                "role": "user",
                "content": "test"
            }]
        });

        let response = client
            .post(&endpoint)
            .header("x-api-key", &request.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&test_payload)
            .send()
            .await;

        match response {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    Ok(TestApiResponse {
                        success: true,
                        message: "API连接成功！".to_string(),
                    })
                } else {
                    let error_text = resp.text().await.unwrap_or_else(|_| "未知错误".to_string());
                    Ok(TestApiResponse {
                        success: false,
                        message: format!("API返回错误 ({}): {}", status.as_u16(), error_text),
                    })
                }
            }
            Err(e) => Ok(TestApiResponse {
                success: false,
                message: format!("连接失败: {}", e),
            }),
        }
    } else {
        // OpenAI兼容API使用chat/completions端点
        let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));

        let test_payload = serde_json::json!({
            "model": request.model,
            "messages": [{
                "role": "user",
                "content": "test"
            }],
            "max_tokens": 1
        });

        let response = client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", request.api_key))
            .header("content-type", "application/json")
            .json(&test_payload)
            .send()
            .await;

        match response {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    Ok(TestApiResponse {
                        success: true,
                        message: "API连接成功！".to_string(),
                    })
                } else {
                    let error_text = resp.text().await.unwrap_or_else(|_| "未知错误".to_string());
                    // 尝试解析JSON错误信息
                    if let Ok(error_json) = serde_json::from_str::<serde_json::Value>(&error_text) {
                        let error_msg = error_json["error"]["message"]
                            .as_str()
                            .or_else(|| error_json["message"].as_str())
                            .unwrap_or(&error_text);
                        Ok(TestApiResponse {
                            success: false,
                            message: format!("API返回错误 ({}): {}", status.as_u16(), error_msg),
                        })
                    } else {
                        Ok(TestApiResponse {
                            success: false,
                            message: format!("API返回错误 ({}): {}", status.as_u16(), error_text),
                        })
                    }
                }
            }
            Err(e) => {
                let error_msg = if e.is_timeout() {
                    "连接超时，请检查网络或API端点".to_string()
                } else if e.is_connect() {
                    "无法连接到服务器，请检查API端点是否正确".to_string()
                } else {
                    format!("连接失败: {}", e)
                };

                Ok(TestApiResponse {
                    success: false,
                    message: error_msg,
                })
            }
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RecognizeDesignationResponse {
    pub success: bool,
    pub designation: Option<String>,
    pub method: String, // "regex" | "ai" | "failed"
    pub message: String,
}

/// 使用AI识别视频标题中的番号
#[tauri::command]
pub async fn recognize_designation_with_ai(
    app: AppHandle,
    title: String,
    force_ai: Option<bool>, // 新增参数：是否强制使用 AI
) -> Result<RecognizeDesignationResponse, String> {
    use crate::utils::designation_recognizer::{
        AIProvider as RecognizerAIProvider, DesignationRecognizer, RecognitionMethod,
    };

    let force_ai = force_ai.unwrap_or(false);

    // 获取设置
    let settings = get_settings(app).await?;

    // 找到第一个启用的AI提供商
    let ai_provider = settings
        .ai
        .providers
        .iter()
        .filter(|p| p.active)
        .min_by_key(|p| p.priority)
        .map(|p| RecognizerAIProvider {
            provider: p.provider.clone(),
            model: p.model.clone(),
            api_key: p.api_key.clone(),
            endpoint: p.endpoint.clone(),
        });

    // 创建识别器
    let recognizer = if let Some(provider) = ai_provider {
        DesignationRecognizer::with_ai_provider(provider)
    } else {
        DesignationRecognizer::new()
    };

    // 执行识别
    let result = recognizer.recognize(&title, force_ai).await?;

    // 转换结果格式
    Ok(RecognizeDesignationResponse {
        success: result.success,
        designation: result.designation,
        method: match result.method {
            RecognitionMethod::Regex => "regex".to_string(),
            RecognitionMethod::AI => "ai".to_string(),
            RecognitionMethod::Failed => "failed".to_string(),
        },
        message: match result.method {
            RecognitionMethod::Regex => format!("智能识别成功（正则匹配）"),
            RecognitionMethod::AI => format!("智能识别成功（AI）"),
            RecognitionMethod::Failed => {
                if force_ai && !recognizer.has_ai_provider() {
                    "没有可用的AI提供商，请在设置中配置".to_string()
                } else {
                    result.message
                }
            }
        },
    })
}
