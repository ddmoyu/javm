use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::{Mutex, Semaphore};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone)]
pub struct DownloadTask {
    pub id: String,
    pub url: String,
    pub save_path: String,
    pub filename: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub task_id: String,
    pub progress: f64,
    pub speed: u64,
    pub downloaded: u64,
    pub total: u64,
    pub status: i32,
}

fn strip_ansi_escape_codes(line: &str) -> String {
    static ANSI_ESCAPE_REGEX: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = ANSI_ESCAPE_REGEX.get_or_init(|| {
        Regex::new(r"\x1B\[[0-?]*[ -/]*[@-~]").unwrap()
    });

    re.replace_all(line, "").to_string()
}

fn collect_output_segments(pending: &mut String) -> Vec<String> {
    let mut segments = Vec::new();
    let mut last_index = 0usize;

    for (index, ch) in pending.char_indices() {
        if ch == '\n' || ch == '\r' {
            let segment = pending[last_index..index].trim();
            if !segment.is_empty() {
                segments.push(segment.to_string());
            }
            last_index = index + ch.len_utf8();
        }
    }

    if last_index > 0 {
        pending.drain(..last_index);
    }

    segments
}

#[derive(Clone)]
pub struct DownloadManager {
    queue: Arc<Mutex<VecDeque<DownloadTask>>>,
    active_tasks: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    active_processes: Arc<Mutex<HashMap<String, Arc<Mutex<Option<tokio::process::Child>>>>>>,
    semaphore: Arc<Semaphore>,
    max_concurrent: Arc<AtomicUsize>,
    pending_permits_to_forget: Arc<AtomicUsize>,
}

impl DownloadManager {
    pub fn new(max_concurrent: usize) -> Self {
        let max_concurrent = max_concurrent.max(1);
        Self {
            queue: Arc::new(Mutex::new(VecDeque::new())),
            active_tasks: Arc::new(Mutex::new(HashMap::new())),
            active_processes: Arc::new(Mutex::new(HashMap::new())),
            semaphore: Arc::new(Semaphore::new(max_concurrent)),
            max_concurrent: Arc::new(AtomicUsize::new(max_concurrent)),
            pending_permits_to_forget: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub async fn set_max_concurrent(&self, max_concurrent: usize) {
        let max_concurrent = max_concurrent.max(1);
        let previous = self.max_concurrent.swap(max_concurrent, Ordering::SeqCst);

        if max_concurrent > previous {
            self.semaphore.add_permits(max_concurrent - previous);
            self.pending_permits_to_forget.store(0, Ordering::SeqCst);
            return;
        }

        if max_concurrent < previous {
            let to_forget = previous - max_concurrent;
            let forgotten = self.semaphore.forget_permits(to_forget);
            let remaining = to_forget.saturating_sub(forgotten);
            self.pending_permits_to_forget.store(remaining, Ordering::SeqCst);
        }
    }

    fn reconcile_semaphore_limit(&self) {
        let pending = self.pending_permits_to_forget.load(Ordering::SeqCst);
        if pending == 0 {
            return;
        }

        let forgotten = self.semaphore.forget_permits(pending);
        if forgotten == 0 {
            return;
        }

        let remaining = pending.saturating_sub(forgotten);
        self.pending_permits_to_forget.store(remaining, Ordering::SeqCst);
    }

    pub async fn stop_task(&self, task_id: &str) -> Result<(), String> {
        // 1. 从队列中移除任务（如果还在队列中）
        {
            let mut queue = self.queue.lock().await;
            queue.retain(|t| t.id != task_id);
        }

        // 2. 终止正在运行的进程
        {
            let mut processes = self.active_processes.lock().await;
            if let Some(process_mutex) = processes.remove(task_id) {
                let mut process_opt = process_mutex.lock().await;
                if let Some(mut child) = process_opt.take() {
                    let _ = terminate_child_process(&mut child).await;
                }
            }
        }

        // 3. 取消 tokio 任务
        {
            let mut active = self.active_tasks.lock().await;
            if let Some(handle) = active.remove(task_id) {
                handle.abort();
            }
        }

        Ok(())
    }

    pub async fn shutdown(&self) {
        {
            let mut queue = self.queue.lock().await;
            queue.clear();
        }

        let task_ids = {
            let active = self.active_tasks.lock().await;
            active.keys().cloned().collect::<Vec<_>>()
        };

        for task_id in task_ids {
            let _ = self.stop_task(&task_id).await;
        }
    }

    pub async fn add_task(&self, task: DownloadTask) {
        let mut queue = self.queue.lock().await;
        queue.push_back(task);
    }

    pub fn schedule_next(
        &self,
        app: tauri::AppHandle,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        let manager = self.clone();
        Box::pin(async move {
            let task = {
                let mut queue = manager.queue.lock().await;
                queue.pop_front()
            };

            if let Some(task) = task {
                let permit = manager.semaphore.clone().acquire_owned().await;
                if permit.is_err() {
                    return;
                }

                let task_id = task.id.clone();
                let task_id_for_map = task_id.clone();
                let app_clone = app.clone();
                let app_state = app.clone();

                let handle = tokio::spawn(async move {
                    let permit = permit.unwrap();
                    let result = execute_download(app_clone, task).await;
                    let _ = result;

                    drop(permit);

                    if let Some(manager_state) = app_state.try_state::<DownloadManager>() {
                        manager_state.reconcile_semaphore_limit();
                        {
                            let mut active = manager_state.active_tasks.lock().await;
                            active.remove(&task_id);
                        }

                        let app_next = app_state.clone();
                        let manager_clone = (*manager_state).clone();
                        tokio::spawn(async move {
                            manager_clone.schedule_next(app_next).await;
                        });
                    }
                });

                let mut active = manager.active_tasks.lock().await;
                active.insert(task_id_for_map.clone(), handle);
            } else {
            }
        })
    }
}

/// 触发自动刮削任务
async fn trigger_auto_scrape(app: tauri::AppHandle, task: &DownloadTask) {
    use tauri::Emitter;
    
    let settings = match crate::settings::get_settings(app.clone()).await {
        Ok(s) => s,
        Err(_) => return,
    };

    if !settings.download.auto_scrape {
        return;
    }

    let filename = match &task.filename {
        Some(f) => f,
        None => return,
    };

    let Some(target_file) = crate::download::find_existing_video_path(&task.save_path, filename)
    else {
        // 如果没找到文件，可能还没合并完成或者名字不对，暂时忽略
        return;
    };

    let file_path_str = target_file.to_string_lossy().to_string();
    println!("[AutoScrape] Triggering for: {}", file_path_str);

    let db = match crate::db::Database::new(&app) {
        Ok(db) => db,
        Err(e) => {
            println!("[AutoScrape] Database::new failed: {}", e);
            return;
        }
    };

    // 检查是否已刮削
    if let Ok(scraped) = db.is_video_completely_scraped(&file_path_str) {
        if scraped {
            println!("[AutoScrape] Video already scraped: {}", file_path_str);
            return;
        }
    }

    // 更新下载任务状态为"刮削中"(状态码4)
    if let Ok(conn) = db.get_connection() {
        let _ = conn.execute(
            "UPDATE downloads SET status = 4, updated_at = datetime('now') WHERE id = ?",
            rusqlite::params![task.id],
        );
    }

    // 获取下载任务的字节数信息用于发送进度事件
    let (downloaded, total) = if let Ok(conn) = db.get_connection() {
        conn.query_row(
            "SELECT downloaded_bytes, total_bytes FROM downloads WHERE id = ?",
            rusqlite::params![task.id],
            |row| {
                let d: i64 = row.get(0).unwrap_or(0);
                let t: i64 = row.get(1).unwrap_or(0);
                Ok((d as u64, t as u64))
            },
        )
        .unwrap_or((0, 0))
    } else {
        (0, 0)
    };

    // 发送进度事件，通知前端状态变更为"刮削中"
    let scraping_progress = DownloadProgress {
        task_id: task.id.clone(),
        progress: 100.0,
        speed: 0,
        downloaded,
        total,
        status: 4, // 刮削中
    };
    app.emit("download-progress", &scraping_progress).ok();

    // 异步执行刮削任务
    let app_clone = app.clone();
    let task_id = task.id.clone();
    let file_path = file_path_str.clone();
    
    tokio::spawn(async move {
        match perform_scrape(&app_clone, &file_path).await {
            Ok(_) => {
                // 更新下载任务状态为"已完成"
                update_download_status_completed(&app_clone, &task_id).await;
            }
            Err(_) => {
                // 刮削失败也标记为已完成，不影响下载状态
                update_download_status_completed(&app_clone, &task_id).await;
            }
        }
    });
}

/// 执行刮削操作
async fn perform_scrape(app: &tauri::AppHandle, video_path: &str) -> Result<(), String> {
    use crate::resource_scrape::{webclaw_client, fetcher::Fetcher, sources::{self, ResourceSite}};
    use crate::resource_scrape::database_writer::DatabaseWriter;
    use crate::media::assets::save_nfo_for_video;
    use crate::db::Database;

    // 1. 提取番号
    let designation = extract_designation_from_path(video_path)?;
    println!("[AutoScrape] 提取到番号: {}", designation);

    // 2. 获取元数据
    let settings = crate::settings::get_settings(app.clone()).await.unwrap_or_default();
    let site = crate::settings::resolve_active_scrape_site(&settings.scrape)
        .ok_or_else(|| "未启用任何刮削网站，请先在设置中开启至少一个网站".to_string())?;
    let source = sources::all_sources()
        .into_iter()
        .find(|item| item.name() == site.id)
        .ok_or_else(|| format!("未找到默认刮削网站解析器: {}", site.id))?;

    let url = source.build_url(&designation);
    println!("[AutoScrape] 使用 {} 获取: {}", source.name(), url);

    // 创建 Fetcher 获取 HTML
    let http_client = webclaw_client::create_client()?;
    let fetcher = Fetcher::new(http_client);

    let fetch_settings = crate::settings::resolve_scrape_fetch_settings(&settings.scrape);
    let html = fetcher
        .fetch(
            app,
            &url,
            &site,
            crate::resource_scrape::fetcher::FetchOptions {
                webview_enabled: fetch_settings.webview_enabled,
                webview_fallback_enabled: fetch_settings.webview_fallback_enabled,
                show_webview: fetch_settings.dev_show_webview,
                max_webview_windows: fetch_settings.max_webview_windows,
            },
        )
        .await
        .map_err(|e| format!("获取页面失败: {}", e))?;

    println!("[AutoScrape] 获取到 {} 字符 HTML", html.len());

    // 检查是否需要二次请求详情页
    let parse_html = if let Some(detail_url) = source.extract_detail_url(&html, &designation) {
        let detail_url_string = detail_url.to_string();
        println!("[AutoScrape] 需要二次请求详情页: {}", detail_url_string);
        let detail_site = ResourceSite {
            id: site.id.clone(),
            name: site.name.clone(),
            enabled: true,
            avg_score: None,
            scrape_count: None,
        };
        match fetcher
            .fetch(
                app,
                &detail_url_string,
                &detail_site,
                crate::resource_scrape::fetcher::FetchOptions {
                    webview_enabled: fetch_settings.webview_enabled,
                    webview_fallback_enabled: fetch_settings.webview_fallback_enabled,
                    show_webview: fetch_settings.dev_show_webview,
                    max_webview_windows: fetch_settings.max_webview_windows,
                },
            )
            .await
        {
            Ok(dh) => {
                println!("[AutoScrape] 详情页返回 {} 字符", dh.len());
                dh
            }
            Err(e) => {
                println!("[AutoScrape] 详情页请求失败: {}，回退到搜索页", e);
                html
            }
        }
    } else {
        html
    };

    // 解析元数据
    let search_result = source
        .parse(&parse_html, &designation)
        .ok_or_else(|| format!("解析元数据失败: 番号 {}", designation))?;

    println!("[AutoScrape] 解析成功: {}", search_result.title);

    // 将 SearchResult 转换为 ScrapeMetadata
    let metadata = crate::resource_scrape::commands::search_result_to_metadata(&search_result);

    // 3. 下载封面图片
    let local_cover_path = if !metadata.poster_url.is_empty() {
        match crate::download::image::download_cover(video_path, &metadata.poster_url, None).await {
            Ok(path) => {
                println!("[AutoScrape] 封面下载成功: {}", path);
                path
            }
            Err(e) => {
                println!("[AutoScrape] 封面下载失败: {}", e);
                String::new()
            }
        }
    } else {
        String::new()
    };

    // 4. 下载预览图到 extrafanart
    if !metadata.thumbs.is_empty() {
        let preview_items: Vec<(usize, String)> = metadata
            .thumbs
            .iter()
            .enumerate()
            .map(|(index, url)| (index + 1, url.clone()))
            .collect();

        if let Err(e) = crate::media::assets::sync_extrafanart_from_urls(
            video_path,
            preview_items,
        )
        .await
        {
            println!("[AutoScrape] extrafanart 下载失败: {}", e);
        }
    }

    // 5. 保存 NFO 文件
    if let Err(e) = save_nfo_for_video(video_path, &metadata) {
        println!("[AutoScrape] NFO 保存失败: {}", e);
    } else {
        println!("[AutoScrape] NFO 保存成功");
    }

    // 6. 写入数据库
    let db = Database::new(app).map_err(|e| e.to_string())?;

    // 生成或查询video_id
    let video_id = get_or_create_video_id(&db, video_path)?;
    
    let writer = DatabaseWriter::new(&db);
    writer
        .write_all(
            video_id,
            metadata.clone(),
            local_cover_path,
        )
        .await?;

    println!("[AutoScrape] 数据库更新成功");
    Ok(())
}

/// 获取或创建video_id
fn get_or_create_video_id(db: &crate::db::Database, video_path: &str) -> Result<String, String> {
    use std::path::Path;
    use chrono::Utc;
    
    let conn = db.get_connection().map_err(|e| e.to_string())?;
    
    // 先尝试从数据库查询已存在的记录
    let existing_video: Result<(String, Option<String>), _> = conn.query_row(
        "SELECT id, fast_hash FROM videos WHERE video_path = ?",
        rusqlite::params![video_path],
        |row| Ok((row.get(0)?, row.get(1)?)),
    );
    
    if let Ok((id, fast_hash)) = existing_video {
        let missing_fast_hash = fast_hash
            .as_deref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true);

        if missing_fast_hash {
            let fast_hash = calculate_fast_hash(Path::new(video_path))?;
            conn.execute(
                "UPDATE videos SET fast_hash = ?, updated_at = ? WHERE id = ?",
                rusqlite::params![fast_hash, Utc::now().to_rfc3339(), id],
            )
            .map_err(|e| format!("更新视频 fast_hash 失败: {}", e))?;
        }

        return Ok(id);
    }
    
    // 如果不存在，创建新记录
    let path = Path::new(video_path);
    let filename = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");
    let parent_str = path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    
    let file_size = path.metadata().map(|m| m.len()).unwrap_or(0);
    let fast_hash = calculate_fast_hash(path)?;
    let now = Utc::now().to_rfc3339();
    let video_id = uuid::Uuid::new_v4().to_string();
    
    // 插入基本视频记录
    conn.execute(
        "INSERT INTO videos (
            id, video_path, dir_path, title, original_title, 
            file_size, fast_hash, scan_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            video_id,
            video_path,
            parent_str,
            filename,
            filename,
            file_size as i64,
            fast_hash,
            1,  // scan_status = 1 (未刮削)
            now,
            now,
        ],
    ).map_err(|e| format!("插入视频记录失败: {}", e))?;
    
    Ok(video_id)
}

/// 从视频文件路径中提取番号
fn extract_designation_from_path(video_path: &str) -> Result<String, String> {
    use std::path::Path;
    use crate::utils::designation_recognizer::DesignationRecognizer;

    let path = Path::new(video_path);
    let filename = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "无法获取文件名".to_string())?;

    let recognizer = DesignationRecognizer::new();
    recognizer
        .recognize_with_regex(filename)
        .ok_or_else(|| format!("无法从文件名提取番号: {}", filename))
}

fn adler32(data: &[u8], start: u32) -> u32 {
    let mut a = start & 0xFFFF;
    let mut b = (start >> 16) & 0xFFFF;
    for &byte in data {
        a = (a + byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

fn calculate_fast_hash(path: &std::path::Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("打开文件失败 '{}': {}", path.display(), e))?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();

    if len == 0 {
        return Ok("0".to_string());
    }

    let mut hash = 1u32;
    hash = adler32(&len.to_le_bytes(), hash);

    let mut buffer = [0u8; 4096];
    let bytes_read = file.read(&mut buffer).map_err(|e| e.to_string())?;
    hash = adler32(&buffer[..bytes_read], hash);

    if len > 4096 {
        let offset = if len < 8192 { 4096 } else { len - 4096 };
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let bytes_read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        hash = adler32(&buffer[..bytes_read], hash);
    }

    Ok(format!("{:08x}", hash))
}

/// 更新下载任务状态为已完成
async fn update_download_status_completed(app: &tauri::AppHandle, task_id: &str) {
    use tauri::Emitter;
    
    let db = match crate::db::Database::new(app) {
        Ok(db) => db,
        Err(e) => {
            println!("[Download] Database::new failed: {}", e);
            return;
        }
    };

    if let Ok(conn) = db.get_connection() {
        let _ = conn.execute(
            "UPDATE downloads SET status = 6, updated_at = datetime('now') WHERE id = ?",
            rusqlite::params![task_id],
        );

        // 获取下载任务的字节数信息
        let (downloaded, total): (i64, i64) = conn
            .query_row(
                "SELECT downloaded_bytes, total_bytes FROM downloads WHERE id = ?",
                rusqlite::params![task_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or((0, 0));

        // 发送进度事件，通知前端状态变更为"已完成"
        let completed_progress = DownloadProgress {
            task_id: task_id.to_string(),
            progress: 100.0,
            speed: 0,
            downloaded: downloaded as u64,
            total: total as u64,
            status: 6, // 已完成
        };

        let _ = app.emit("download-progress", completed_progress);
    }
}

#[cfg(windows)]
fn configure_download_process(cmd: &mut tokio::process::Command) {
    use std::os::windows::process::CommandExt;

    cmd.as_std_mut().creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_download_process(_: &mut tokio::process::Command) {}

async fn terminate_child_process(child: &mut tokio::process::Child) -> Result<(), String> {
    #[cfg(windows)]
    {
        if let Some(pid) = child.id() {
            let mut cmd = tokio::process::Command::new("taskkill");
            cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
            configure_download_process(&mut cmd);

            match cmd.status().await {
                Ok(status) if status.success() => {
                    let _ = child.wait().await;
                    return Ok(());
                }
                Ok(_) | Err(_) => {
                    // 回退到直接结束主进程
                }
            }
        }
    }

    child.kill().await.map_err(|e| e.to_string())?;
    let _ = child.wait().await;
    Ok(())
}


pub(crate) async fn execute_download(
    app: tauri::AppHandle,
    task: DownloadTask,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, BufReader};
    use tokio::process::Command;

    let tool_name = "N_m3u8DL-RE";
    let executable = resolve_executable_path(&app, "bin/N_m3u8DL-RE")?;

    // 更新状态为准备中
    let db = crate::db::Database::new(&app).map_err(|e| e.to_string())?;
    if let Ok(conn) = db.get_connection() {
        let _ = conn.execute(
            "UPDATE downloads SET status = 1, downloader_type = ?, updated_at = datetime('now') WHERE id = ?",
            rusqlite::params![tool_name, task.id],
        );
    }
    app.emit("download-task-started", &task.id).ok();

    let mut cmd = Command::new(&executable);

    let resolved_save_dir = crate::download::resolve_task_save_dir(
        &task.save_path,
        task.filename.as_deref(),
    );
    std::fs::create_dir_all(&resolved_save_dir)
        .map_err(|e| format!("创建下载目录失败: {}", e))?;

    // 默认认为是 N_m3u8DL-RE 的参数构造
    cmd.arg(&task.url);
    cmd.arg("--save-dir").arg(&resolved_save_dir);

    if let Some(filename) = &task.filename {
        cmd.arg("--save-name").arg(filename);
    }

    let tmp_dir = resolved_save_dir.join(".tmp");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;
    cmd.arg("--tmp-dir").arg(tmp_dir);
    cmd.arg("--auto-select");
    cmd.arg("--download-retry-count").arg("3");
    cmd.arg("--binary-merge");

    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    configure_download_process(&mut cmd);

    let child = cmd.spawn().map_err(|e| {
        format!("启动下载器失败: {}", e)
    })?;

    // 将进程句柄存储到 DownloadManager 中，以便可以停止
    let child_arc = Arc::new(Mutex::new(Some(child)));
    if let Some(manager) = app.try_state::<DownloadManager>() {
        let mut processes = manager.active_processes.lock().await;
        processes.insert(task.id.clone(), child_arc.clone());
    }

    // 更新状态为下载中
    if let Ok(conn) = db.get_connection() {
        let _ = conn.execute(
            "UPDATE downloads SET status = 2, updated_at = datetime('now') WHERE id = ?",
            [&task.id],
        );
    }

    // 从 Arc<Mutex<Option<Child>>> 中取出 stdout 和 stderr
    let (stdout, stderr) = {
        let mut child_guard = child_arc.lock().await;
        if let Some(child) = child_guard.as_mut() {
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            (stdout, stderr)
        } else {
            return Err("Child process not available".to_string());
        }
    };

    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut pending = String::new();
            let mut buffer = [0u8; 4096];

            loop {
                let bytes_read = match reader.read(&mut buffer).await {
                    Ok(bytes_read) => bytes_read,
                    Err(_) => break,
                };

                if bytes_read == 0 {
                    break;
                }

                pending.push_str(&String::from_utf8_lossy(&buffer[..bytes_read]));
                let _ = collect_output_segments(&mut pending);
            }
        });
    }

    // 保存最后的下载信息
    let mut last_total = 0u64;
    let mut last_downloaded = 0u64;
    let mut is_merging = false;

    // 进度更新节流：每500ms更新一次
    let mut last_progress_update = std::time::Instant::now();
    let progress_update_interval = std::time::Duration::from_millis(500);

    if let Some(stdout) = stdout {
        let mut reader = BufReader::new(stdout);
        let mut pending = String::new();
        let mut buffer = [0u8; 4096];

        loop {
            let bytes_read = reader.read(&mut buffer).await.map_err(|e| {
                format!("读取 stdout 失败: {}", e)
            })?;

            if bytes_read == 0 {
                break;
            }

            pending.push_str(&String::from_utf8_lossy(&buffer[..bytes_read]));

            for raw_line in collect_output_segments(&mut pending) {
                let line = strip_ansi_escape_codes(&raw_line);
                if line.is_empty() {
                    continue;
                }

                // 检测是否进入合并阶段
                if is_nm3u8dl_merging(&line) {
                    if !is_merging {
                        is_merging = true;

                        if let Ok(conn) = db.get_connection() {
                            let _ = conn.execute(
                                "UPDATE downloads SET status = 3, updated_at = datetime('now') WHERE id = ?",
                                [&task.id],
                            );
                        }

                        let payload = DownloadProgress {
                            task_id: task.id.clone(),
                            progress: 99.0,
                            speed: 0,
                            downloaded: last_downloaded,
                            total: last_total,
                            status: 3,
                        };
                        app.emit("download-progress", &payload).ok();
                        last_progress_update = std::time::Instant::now();
                    }
                }

                if let Some((progress, downloaded, total, speed)) = parse_nm3u8dl_progress(&line) {
                    last_total = total;
                    last_downloaded = downloaded;

                    let now = std::time::Instant::now();
                    if now.duration_since(last_progress_update) >= progress_update_interval {
                        let payload = DownloadProgress {
                            task_id: task.id.clone(),
                            progress,
                            speed,
                            downloaded,
                            total,
                            status: 2,
                        };
                        app.emit("download-progress", &payload).ok();

                        if let Ok(conn) = db.get_connection() {
                            let _ = conn.execute(
                                "UPDATE downloads SET progress = ?, downloaded_bytes = ?, total_bytes = ?, updated_at = datetime('now') WHERE id = ?",
                                rusqlite::params![progress, downloaded as i64, total as i64, task.id],
                            );
                        }

                        last_progress_update = now;
                    }
                }
            }
        }

        let remaining = strip_ansi_escape_codes(pending.trim());
        if !remaining.is_empty() {
            if let Some((progress, downloaded, total, speed)) = parse_nm3u8dl_progress(&remaining) {
                last_total = total;
                last_downloaded = downloaded;
                let payload = DownloadProgress {
                    task_id: task.id.clone(),
                    progress,
                    speed,
                    downloaded,
                    total,
                    status: 2,
                };
                app.emit("download-progress", &payload).ok();
            }
        }
    }

    // 等待进程结束
    let status = {
        let mut child_guard = child_arc.lock().await;
        if let Some(child) = child_guard.take() {
            child.wait_with_output().await.map_err(|e| e.to_string())?
        } else {
            return Err("Child process not available".to_string());
        }
    };

    // 清理进程句柄
    if let Some(manager) = app.try_state::<DownloadManager>() {
        let mut processes = manager.active_processes.lock().await;
        processes.remove(&task.id);
    }

    if status.status.success() {
        let final_bytes = if last_downloaded > 0 {
            last_downloaded
        } else {
            last_total
        };

        if let Ok(conn) = db.get_connection() {
            let _ = conn.execute(
                "UPDATE downloads SET status = 6, progress = 100, downloaded_bytes = ?, total_bytes = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
                rusqlite::params![final_bytes as i64, final_bytes as i64, task.id],
            );
        }
        let final_progress = DownloadProgress {
            task_id: task.id.clone(),
            progress: 100.0,
            speed: 0,
            downloaded: final_bytes,
            total: final_bytes,
            status: 6,
        };
        app.emit("download-progress", &final_progress).ok();
        crate::analytics::record_download_completed(&app);

        // 触发自动刮削
        trigger_auto_scrape(app.clone(), &task).await;

        Ok(())
    } else {
        let stderr_output = strip_ansi_escape_codes(String::from_utf8_lossy(&status.stderr).trim());
        let stdout_output = strip_ansi_escape_codes(String::from_utf8_lossy(&status.stdout).trim());
        let error_message = if !stderr_output.is_empty() {
            format!("下载器退出失败: {}", stderr_output)
        } else if !stdout_output.is_empty() {
            format!("下载器退出失败: {}", stdout_output)
        } else {
            format!("下载器退出失败，exit_code={:?}", status.status.code())
        };

        if let Ok(conn) = db.get_connection() {
            let _ = conn.execute(
                "UPDATE downloads SET status = 7, error_message = ?, updated_at = datetime('now') WHERE id = ?",
                rusqlite::params![error_message, task.id],
            );
        }
        let fail_progress = DownloadProgress {
            task_id: task.id.clone(),
            progress: 0.0,
            speed: 0,
            downloaded: 0,
            total: 0,
            status: 7,
        };
        app.emit("download-progress", &fail_progress).ok();
        Err(error_message)
    }
}

fn platform_executable_relative_paths(path: &str) -> Vec<String> {
    let normalized = path.replace('\\', "/");
    let path_obj = Path::new(&normalized);
    let parent = path_obj.parent().unwrap_or_else(|| Path::new(""));
    let stem = path_obj
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(path);

    let mut candidates = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let extension = path_obj.extension().and_then(|value| value.to_str());

        if extension == Some("exe") {
            candidates.push(normalized.clone());
        } else {
            candidates.push(parent.join(format!("{}.exe", stem)).to_string_lossy().to_string());
            candidates.push(parent.join(stem).to_string_lossy().to_string());
        }
    }

    #[cfg(target_os = "macos")]
    {
        candidates.push(parent.join(format!("{}-macos", stem)).to_string_lossy().to_string());
        candidates.push(parent.join(format!("{}-darwin", stem)).to_string_lossy().to_string());
        candidates.push(parent.join(stem).to_string_lossy().to_string());
    }

    #[cfg(target_os = "linux")]
    {
        candidates.push(parent.join(format!("{}-linux", stem)).to_string_lossy().to_string());
        candidates.push(parent.join(stem).to_string_lossy().to_string());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        candidates.push(normalized.clone());
    }

    candidates.dedup();
    candidates
}

fn platform_command_names(path: &str) -> Vec<String> {
    let path_obj = Path::new(path);
    let stem = path_obj
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(path);
    let file_name = path_obj
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(stem);

    let mut names = Vec::new();

    #[cfg(target_os = "windows")]
    {
        names.push(format!("{}.exe", stem));
        names.push(stem.to_string());
    }

    #[cfg(target_os = "macos")]
    {
        names.push(format!("{}-macos", stem));
        names.push(format!("{}-darwin", stem));
        names.push(stem.to_string());
    }

    #[cfg(target_os = "linux")]
    {
        names.push(format!("{}-linux", stem));
        names.push(stem.to_string());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        names.push(file_name.to_string());
        names.push(stem.to_string());
    }

    names.push(file_name.to_string());
    names.dedup();
    names
}

fn resolve_relative_from_roots(relative_path: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    for root in roots {
        let candidate = root.join(relative_path);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

#[cfg(unix)]
fn ensure_executable_permission(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = std::fs::metadata(path)
        .map_err(|e| format!("读取可执行文件元数据失败 '{}': {}", path.display(), e))?;
    let mut permissions = metadata.permissions();
    let mode = permissions.mode();

    if mode & 0o111 == 0 {
        permissions.set_mode(mode | 0o755);
        std::fs::set_permissions(path, permissions)
            .map_err(|e| format!("设置可执行权限失败 '{}': {}", path.display(), e))?;
    }

    Ok(())
}

#[cfg(not(unix))]
fn ensure_executable_permission(_: &Path) -> Result<(), String> {
    Ok(())
}

/// 解析外部可执行文件路径
pub fn resolve_executable_path(app: &tauri::AppHandle, path: &str) -> Result<String, String> {
    let relative_candidates = platform_executable_relative_paths(path);

    for relative_path in &relative_candidates {
        if let Ok(resolved) = app
            .path()
            .resolve(relative_path, tauri::path::BaseDirectory::Resource)
        {
            if resolved.exists() {
                ensure_executable_permission(&resolved)?;
                return Ok(resolved.to_string_lossy().to_string());
            }
        }
    }

    let mut roots = Vec::new();
    if let Ok(process_path) = std::env::current_exe() {
        if let Some(parent) = process_path.parent() {
            roots.push(parent.to_path_buf());
            roots.push(parent.join("bin"));
        }
    }

    if let Ok(current_dir) = std::env::current_dir() {
        roots.push(current_dir.clone());
        roots.push(current_dir.join("src-tauri"));
    }

    for relative_path in &relative_candidates {
        if let Some(resolved) = resolve_relative_from_roots(relative_path, &roots) {
            ensure_executable_permission(&resolved)?;
            return Ok(resolved.to_string_lossy().to_string());
        }
    }

    for command_name in platform_command_names(path) {
        let command_path = Path::new(&command_name);
        if command_path.is_absolute() || command_name.contains('/') || command_name.contains('\\') {
            if command_path.exists() {
                ensure_executable_permission(command_path)?;
                return Ok(command_path.to_string_lossy().to_string());
            }
            continue;
        }

        if let Some(found) = std::env::var_os("PATH")
            .and_then(|paths| {
                std::env::split_paths(&paths)
                    .map(|dir| dir.join(&command_name))
                    .find(|candidate| candidate.exists())
            })
        {
            return Ok(found.to_string_lossy().to_string());
        }
    }

    Err(format!(
        "未找到下载器 '{}'. 请在 src-tauri/bin 中放入当前平台可执行文件，或将其加入系统 PATH",
        path
    ))
}

/// 解析 N_m3u8DL-RE 进度输出
pub fn parse_nm3u8dl_progress(line: &str) -> Option<(f64, u64, u64, u64)> {
    static PROGRESS_REGEX: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static DONE_REGEX: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let progress_re = PROGRESS_REGEX.get_or_init(|| {
        Regex::new(r"(\d+)/(\d+)\s+([\d.]+)%\s+([\d.]+)(MB|GB|KB|B)/([\d.]+)(MB|GB|KB|B)\s+([\d.]+)(MBps|GBps|KBps|Bps)").unwrap()
    });
    let done_re = DONE_REGEX.get_or_init(|| {
        Regex::new(r"(\d+)/(\d+)\s+([\d.]+)%\s+([\d.]+)(MB|GB|KB|B)\s+-").unwrap()
    });

    // 先尝试匹配 Done 格式
    if let Some(caps) = done_re.captures(line) {
        let percentage: f64 = caps[3].parse().ok()?;
        let final_size: f64 = caps[4].parse().ok()?;
        let size_unit = &caps[5];
        let final_bytes = convert_to_bytes(final_size, size_unit);
        return Some((percentage, final_bytes, final_bytes, 0));
    }

    // 再尝试匹配正常进度格式
    if let Some(caps) = progress_re.captures(line) {
        let percentage: f64 = caps[3].parse().ok()?;
        let downloaded: f64 = caps[4].parse().ok()?;
        let downloaded_unit = &caps[5];
        let total: f64 = caps[6].parse().ok()?;
        let total_unit = &caps[7];
        let speed: f64 = caps[8].parse().ok()?;
        let speed_unit = &caps[9];

        let downloaded_bytes = convert_to_bytes(downloaded, downloaded_unit);
        let total_bytes = convert_to_bytes(total, total_unit);
        let speed_bytes = convert_to_bytes(speed, speed_unit.trim_end_matches("ps"));

        Some((percentage, downloaded_bytes, total_bytes, speed_bytes))
    } else {
        None
    }
}

/// 检测 N_m3u8DL-RE 是否进入合并/混流阶段
pub fn is_nm3u8dl_merging(line: &str) -> bool {
    line.contains("调用ffmpeg合并中")
        || line.contains("Muxing")
        || line.contains("ffmpeg合并")
        || line.contains("Merging")
        || line.contains("二进制合并中")
}

fn convert_to_bytes(value: f64, unit: &str) -> u64 {
    let multiplier = match unit.to_uppercase().as_str() {
        "B" => 1,
        "KB" => 1024,
        "MB" => 1024 * 1024,
        "GB" => 1024 * 1024 * 1024,
        _ => 1,
    };
    (value * multiplier as f64) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_nm3u8dl_progress() {
        let line = "Vid 1920x1080 | 4096 Kbps ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 80/81 98.77% 57.08MB/57.80MB 32.00KBps 00:00:04";
        let result = parse_nm3u8dl_progress(line);
        assert!(result.is_some());
        let (percent, downloaded, total, speed) = result.unwrap();
        assert!((percent - 98.77).abs() < 0.01);
        assert_eq!(downloaded, (57.08 * 1024.0 * 1024.0) as u64);
        assert_eq!(total, (57.80 * 1024.0 * 1024.0) as u64);
        assert_eq!(speed, (32.00 * 1024.0) as u64);
    }

    #[test]
    fn test_is_nm3u8dl_merging() {
        assert!(is_nm3u8dl_merging(
            "17:09:58.504 INFO : 调用ffmpeg合并中..."
        ));
        assert!(is_nm3u8dl_merging("正在使用ffmpeg合并视频文件"));
        assert!(is_nm3u8dl_merging("Muxing video and audio streams..."));
        assert!(is_nm3u8dl_merging("Merging segments into final file"));
        assert!(is_nm3u8dl_merging("19:23:01.234 INFO : 二进制合并中..."));
        assert!(!is_nm3u8dl_merging(
            "Vid Kbps ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 80/81 98.77%"
        ));
        assert!(!is_nm3u8dl_merging("Download completed successfully"));
    }

    #[test]
    fn test_parse_nm3u8dl_done() {
        let line = "Vid Kbps ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 81/81 100.00% 57.58MB - 00:00:00";
        let result = parse_nm3u8dl_progress(line);
        assert!(result.is_some());
        let (percent, downloaded, total, speed) = result.unwrap();
        assert!((percent - 100.0).abs() < 0.01);
        assert_eq!(downloaded, (57.58 * 1024.0 * 1024.0) as u64);
        assert_eq!(total, (57.58 * 1024.0 * 1024.0) as u64);
        assert_eq!(speed, 0);
    }
}
