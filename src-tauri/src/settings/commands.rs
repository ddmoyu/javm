use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri::Manager;

use super::encryption::{encrypt_settings, decrypt_settings};
use super::{AppSettings, normalize_scrape_settings, get_settings_path};

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> Result<AppSettings, String> {
    let path = get_settings_path(&app)?;
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
    let path = get_settings_path(&app)?;
    let dir = path.parent()
        .ok_or_else(|| "设置文件路径无效".to_string())?;
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

    if let Some(manager) = app.try_state::<crate::download::manager::DownloadManager>() {
        manager
            .set_max_concurrent(settings.download.concurrent.max(1) as usize)
            .await;
    }

    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportLogsResult {
    pub export_path: String,
    pub file_count: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogDirectoryInfo {
    pub log_dir: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportDiagnosticInfo {
    exported_at: String,
    app_version: String,
    os: String,
    cpu_arch: String,
    source_log_dir: String,
    exported_file_count: u32,
    recent_issue_summaries: Vec<DiagnosticLogSummary>,
    event_issue_stats: Vec<DiagnosticEventIssueStat>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticLogSummary {
    level: String,
    source_file: String,
    message: String,
}

#[derive(Debug, Clone)]
struct DiagnosticIssueEntry {
    level: String,
    source_file: String,
    message: String,
    event: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticEventIssueStat {
    event: String,
    total_count: u32,
    error_count: u32,
    warn_count: u32,
    latest_source_file: String,
    latest_message: String,
}

#[tauri::command]
pub async fn get_log_directory(app: AppHandle) -> Result<LogDirectoryInfo, String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("获取日志目录失败: {}", e))?;

    Ok(LogDirectoryInfo {
        log_dir: log_dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn export_logs(app: AppHandle, destination_dir: String) -> Result<ExportLogsResult, String> {
    let trimmed = destination_dir.trim();
    if trimmed.is_empty() {
        return Err("导出目录不能为空".to_string());
    }

    let destination_root = PathBuf::from(trimmed);
    if !destination_root.exists() {
        fs::create_dir_all(&destination_root).map_err(|e| format!("创建导出目录失败: {}", e))?;
    }

    let source_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("获取日志目录失败: {}", e))?;

    if !source_dir.exists() {
        return Err("当前还没有可导出的日志文件".to_string());
    }

    let source_dir = source_dir
        .canonicalize()
        .unwrap_or(source_dir);
    let destination_root = destination_root
        .canonicalize()
        .unwrap_or(destination_root);

    if destination_root.starts_with(&source_dir) {
        return Err("导出目录不能位于日志目录内部".to_string());
    }

    log::logger().flush();

    let export_dir = destination_root.join(format!(
        "javm-logs-{}",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    ));
    fs::create_dir_all(&export_dir).map_err(|e| format!("创建日志导出目录失败: {}", e))?;

    let file_count = copy_log_dir(&source_dir, &export_dir)?;
    if file_count == 0 {
        let _ = fs::remove_dir_all(&export_dir);
        return Err("当前还没有可导出的日志文件".to_string());
    }

    write_export_diagnostic(&app, &source_dir, &export_dir, file_count)?;

    log::info!(
        "[日志] 已导出 {} 个日志文件到 {}",
        file_count,
        export_dir.display()
    );

    Ok(ExportLogsResult {
        export_path: export_dir.to_string_lossy().to_string(),
        file_count,
    })
}

fn copy_log_dir(source_dir: &Path, target_dir: &Path) -> Result<u32, String> {
    let entries = fs::read_dir(source_dir).map_err(|e| format!("读取日志目录失败: {}", e))?;
    let mut file_count = 0u32;

    for entry in entries {
        let entry = entry.map_err(|e| format!("读取日志目录项失败: {}", e))?;
        let path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|e| format!("读取日志文件元数据失败: {}", e))?;
        let target_path = target_dir.join(entry.file_name());

        if metadata.is_dir() {
            fs::create_dir_all(&target_path).map_err(|e| format!("创建子日志目录失败: {}", e))?;
            file_count += copy_log_dir(&path, &target_path)?;
        } else if metadata.is_file() {
            fs::copy(&path, &target_path).map_err(|e| {
                format!(
                    "复制日志文件失败 '{}' -> '{}': {}",
                    path.display(),
                    target_path.display(),
                    e
                )
            })?;
            file_count += 1;
        }
    }

    Ok(file_count)
}

fn write_export_diagnostic(
    app: &AppHandle,
    source_dir: &Path,
    export_dir: &Path,
    file_count: u32,
) -> Result<(), String> {
    let issue_entries = collect_issue_entries(export_dir)?;
    let recent_issue_summaries = build_recent_issue_summaries(&issue_entries, 50);
    let event_issue_stats = build_event_issue_stats(&issue_entries, 20);

    let diagnostic = ExportDiagnosticInfo {
        exported_at: chrono::Local::now().to_rfc3339(),
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        cpu_arch: std::env::consts::ARCH.to_string(),
        source_log_dir: source_dir.to_string_lossy().to_string(),
        exported_file_count: file_count,
        recent_issue_summaries,
        event_issue_stats,
    };

    let content = serde_json::to_string_pretty(&diagnostic)
        .map_err(|e| format!("序列化日志诊断信息失败: {}", e))?;
    fs::write(export_dir.join("diagnostic.json"), content)
        .map_err(|e| format!("写入日志诊断信息失败: {}", e))?;

    Ok(())
}

fn collect_issue_entries(log_dir: &Path) -> Result<Vec<DiagnosticIssueEntry>, String> {
    let mut files = Vec::new();
    collect_log_files(log_dir, &mut files)?;

    files.sort_by_key(|path| {
        path.metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
    });

    let mut entries = Vec::new();
    for file in files {
        let relative_path = file
            .strip_prefix(log_dir)
            .unwrap_or(&file)
            .to_string_lossy()
            .to_string();

        let content = fs::read(&file)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .map_err(|e| format!("读取日志文件失败 '{}': {}", file.display(), e))?;

        for line in content.lines() {
            let Some(level) = extract_issue_level(line) else {
                continue;
            };

            entries.push(DiagnosticIssueEntry {
                level: level.to_string(),
                source_file: relative_path.clone(),
                message: line.trim().to_string(),
                event: extract_event_name(line),
            });
        }
    }

    Ok(entries)
}

fn build_recent_issue_summaries(entries: &[DiagnosticIssueEntry], limit: usize) -> Vec<DiagnosticLogSummary> {
    let start = entries.len().saturating_sub(limit);
    entries[start..]
        .iter()
        .map(|entry| DiagnosticLogSummary {
            level: entry.level.clone(),
            source_file: entry.source_file.clone(),
            message: entry.message.clone(),
        })
        .collect()
}

fn build_event_issue_stats(entries: &[DiagnosticIssueEntry], limit: usize) -> Vec<DiagnosticEventIssueStat> {
    let mut grouped: HashMap<&str, DiagnosticEventIssueStat> = HashMap::new();

    for entry in entries {
        let Some(event) = entry.event.as_deref() else {
            continue;
        };

        let stat = grouped.entry(event).or_insert_with(|| DiagnosticEventIssueStat {
            event: event.to_string(),
            total_count: 0,
            error_count: 0,
            warn_count: 0,
            latest_source_file: entry.source_file.clone(),
            latest_message: entry.message.clone(),
        });

        stat.total_count += 1;
        if entry.level == "error" {
            stat.error_count += 1;
        } else if entry.level == "warn" {
            stat.warn_count += 1;
        }
        stat.latest_source_file = entry.source_file.clone();
        stat.latest_message = entry.message.clone();
    }

    let mut stats: Vec<DiagnosticEventIssueStat> = grouped.into_values().collect();
    stats.sort_by(|left, right| {
        right
            .total_count
            .cmp(&left.total_count)
            .then_with(|| right.error_count.cmp(&left.error_count))
            .then_with(|| left.event.cmp(&right.event))
    });
    stats.truncate(limit);
    stats
}

fn collect_log_files(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("读取日志目录失败: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("读取日志目录项失败: {}", e))?;
        let path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|e| format!("读取日志文件元数据失败: {}", e))?;

        if metadata.is_dir() {
            collect_log_files(&path, files)?;
        } else if metadata.is_file() {
            files.push(path);
        }
    }

    Ok(())
}

fn extract_issue_level(line: &str) -> Option<&'static str> {
    if line.contains("[ERROR]") {
        Some("error")
    } else if line.contains("[WARN]") {
        Some("warn")
    } else {
        None
    }
}

fn extract_event_name(line: &str) -> Option<String> {
    let start = line.find("event=")? + "event=".len();
    let rest = &line[start..];
    let end = rest
        .find(|character: char| character.is_whitespace())
        .unwrap_or(rest.len());
    let event = &rest[..end];
    if event.is_empty() {
        None
    } else {
        Some(event.to_string())
    }
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
