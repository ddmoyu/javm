//! 任务队列管理器
//!
//! 从 scraper/queue_manager.rs 迁移，移除所有 JS 脚本插件依赖。
//! 改用 Fetcher + Source Parser 获取元数据（替代 WebView JS 注入）。
//!
//! 核心变更：
//! - 移除 `ScriptManagerState` 依赖
//! - 移除 `open_scraper_window` 方法
//! - 移除 `pending_interaction` 和 `ScrapeResponse` 相关逻辑
//! - `process_task` 改用 Fetcher + Source Parser 获取元数据

use crate::db::{Database, ScrapeStatus};
use crate::resource_scrape::client;
use crate::resource_scrape::database_writer::DatabaseWriter;
use crate::resource_scrape::detector::ScrapedVideoDetector;
use crate::resource_scrape::fetcher::Fetcher;
use crate::resource_scrape::sources::{self, ResourceSite, Source};
use crate::resource_scrape::types::ScrapeMetadata;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

/// 任务队列管理器
///
/// 负责刮削任务的顺序执行、状态转换、暂停/停止操作。
/// 使用 Fetcher + Source Parser 获取元数据，不依赖 JS 脚本。
#[derive(Clone)]
pub struct TaskQueueManager {
    app: AppHandle,
    db: Database,
    current_task_id: Arc<Mutex<Option<String>>>,
    is_running: Arc<Mutex<bool>>,
    is_stopped: Arc<Mutex<bool>>,
}

impl TaskQueueManager {
    /// 创建新的任务队列管理器
    pub fn new(app: AppHandle) -> Self {
        let db = Database::new(&app);
        Self {
            app,
            db,
            current_task_id: Arc::new(Mutex::new(None)),
            is_running: Arc::new(Mutex::new(false)),
            is_stopped: Arc::new(Mutex::new(false)),
        }
    }

    pub async fn is_running(&self) -> bool {
        let is_running = self.is_running.lock().await;
        *is_running
    }

    pub async fn set_running(&self, running: bool) {
        let mut is_running = self.is_running.lock().await;
        *is_running = running;
    }

    /// 记录错误日志（仅输出到控制台）
    async fn log_error(&self, task_id: &str, error_type: &str, error_message: &str) {
        eprintln!(
            "[任务错误] Task ID: {}, 类型: {}, 信息: {}",
            task_id, error_type, error_message
        );
    }

    /// 启动队列处理
    ///
    /// 按顺序处理任务，直到队列为空、被暂停或被停止。
    pub async fn start(&self) -> Result<(), String> {
        println!("=== TaskQueueManager::start() 被调用 ===");

        // 确认当前未在运行
        {
            let is_running = self.is_running.lock().await;
            if *is_running {
                println!("=== 严重: start() 被调用但已在运行中！中止。 ===");
                return Err("Queue is already running".to_string());
            }
        }

        self.set_running(true).await;

        // 启动时重置停止标志
        {
            let mut is_stopped = self.is_stopped.lock().await;
            *is_stopped = false;
        }

        loop {
            // 处理下一个任务前检查是否已停止
            {
                let is_stopped = self.is_stopped.lock().await;
                if *is_stopped {
                    println!("=== 队列被用户停止 ===");
                    self.emit_queue_status("stopped").await;
                    self.set_running(false).await;
                    return Ok(());
                }
            }

            let next_task = self.get_next_waiting_task_from_db()?;

            let Some(task_id) = next_task else {
                println!("=== 没有等待中的任务 ===");
                break;
            };

            println!("=== 开始处理任务: {} ===", task_id);

            {
                let mut current = self.current_task_id.lock().await;
                *current = Some(task_id.clone());
            }

            if let Err(e) = self.process_task(&task_id).await {
                eprintln!("处理任务 {} 出错: {}", task_id, e);

                if e.contains("stopped") {
                    // 将已停止的任务重置为等待状态
                    let _ = self
                        .db
                        .update_scrape_task_status(&task_id, ScrapeStatus::Waiting, Some(0))
                        .await;

                    {
                        let mut current = self.current_task_id.lock().await;
                        *current = None;
                    }

                    self.emit_queue_status("stopped").await;
                    self.set_running(false).await;
                    return Ok(());
                } else {
                    // 更新任务状态为失败
                    let _ = self
                        .db
                        .update_scrape_task_status(&task_id, ScrapeStatus::Failed, None)
                        .await;

                    // 发送失败事件到前端
                    if let Err(emit_err) = self.app.emit(
                        "scrape-task-failed",
                        serde_json::json!({
                            "task_id": task_id,
                            "error": e
                        }),
                    ) {
                        eprintln!("发送任务失败事件出错: {}", emit_err);
                    }

                    self.log_error(&task_id, "Task failed", &e).await;
                }
            }

            {
                let mut current = self.current_task_id.lock().await;
                *current = None;
            }

            // 任务完成后检查是否已停止
            {
                let is_stopped = self.is_stopped.lock().await;
                if *is_stopped {
                    self.emit_queue_status("stopped").await;
                    self.set_running(false).await;
                    return Ok(());
                }
            }
        }

        println!("=== 队列处理完成 ===");
        self.emit_queue_status("completed").await;
        self.set_running(false).await;
        Ok(())
    }

    /// 从数据库获取下一个等待中的任务（按创建时间倒序）
    fn get_next_waiting_task_from_db(&self) -> Result<Option<String>, String> {
        let conn = self.db.get_connection().map_err(|e| e.to_string())?;

        let task_id: Option<String> =
            Database::get_waiting_scrape_task_id(&conn).map_err(|e| e.to_string())?;

        Ok(task_id)
    }

    /// 停止队列
    pub async fn stop(&self) {
        println!("=== 收到停止请求 ===");
        let mut is_stopped = self.is_stopped.lock().await;
        *is_stopped = true;
    }

    /// 获取当前正在处理的任务 ID
    pub async fn current_task(&self) -> Option<String> {
        let current = self.current_task_id.lock().await;
        current.clone()
    }

    /// 处理单个任务
    ///
    /// 使用 Fetcher + Source Parser 获取元数据（替代旧的 JS 脚本注入）。
    /// 流程：
    /// 1. 获取任务详情，检查视频是否已刮削
    /// 2. 从文件名提取番号
    /// 3. 使用默认网站的 Source 解析器构建 URL
    /// 4. 使用 Fetcher 获取 HTML
    /// 5. 使用 Source.parse() 解析元数据
    /// 6. 下载封面、生成 NFO、更新数据库
    async fn process_task(&self, task_id: &str) -> Result<(), String> {
        println!("=== [任务 {}] process_task() 开始 ===", task_id);

        // 检查是否已停止
        if self.check_stop(task_id, 0).await? {
            return Err("Queue stopped".to_string());
        }

        // 获取任务详情
        let task = self
            .db
            .get_scrape_task(task_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("任务未找到: {}", task_id))?;

        println!("=== [任务 {}] 找到任务，路径: {} ===", task_id, task.path);

        // 检查视频是否已刮削
        let detector = ScrapedVideoDetector::new(&self.db);
        let should_skip = detector
            .is_video_scraped(&task.path)
            .map_err(|e| format!("检查视频刮削状态失败: {}", e))?;

        if should_skip {
            println!(
                "=== [任务 {}] 跳过 - 视频已刮削: {} ===",
                task_id, task.path
            );
            // 从数据库删除该任务
            let conn = self.db.get_connection().map_err(|e| e.to_string())?;
            Database::delete_scrape_task_by_id(&conn, task_id)
                .map_err(|e| format!("删除已刮削任务失败: {}", e))?;
            return Ok(());
        }

        // 更新状态为运行中
        self.db
            .update_scrape_task_status(task_id, ScrapeStatus::Running, Some(0))
            .await
            .map_err(|e| e.to_string())?;
        self.emit_progress(task_id, 0).await;

        // 步骤 1: 从文件名提取番号（进度 1）
        let designation = self.extract_designation(&task.path)?;
        println!("=== [任务 {}] 提取到番号: {} ===", task_id, designation);
        self.db
            .update_scrape_task_progress(task_id, 1)
            .map_err(|e| e.to_string())?;
        self.emit_progress(task_id, 1).await;

        if self.check_stop(task_id, 1).await? {
            return Err("Task stopped".to_string());
        }

        // 步骤 2: 使用 Fetcher + Source Parser 获取元数据（进度 2）
        // 默认使用 javbus 作为刮削网站（后续可从 settings 读取）
        let default_site_id = "javbus";
        let (source, site) = get_source_and_site(default_site_id)
            .ok_or_else(|| format!("未找到默认刮削网站: {}", default_site_id))?;

        let url = source.build_url(&designation);
        println!(
            "=== [任务 {}] 使用 {} 获取: {} ===",
            task_id,
            source.name(),
            url
        );

        // 创建 Fetcher 获取 HTML
        let http_client = client::create_client()?;
        let fetcher = Fetcher::new(http_client.clone());

        let webview_enabled = crate::settings::get_settings(self.app.clone())
            .await
            .map(|settings| settings.scrape.webview_enabled)
            .unwrap_or(false);
        let html = fetcher
            .fetch(&self.app, &url, &site, webview_enabled)
            .await
            .map_err(|e| format!("获取页面失败: {}", e))?;

        println!("=== [任务 {}] 获取到 {} 字符 HTML ===", task_id, html.len());

        // 检查是否需要二次请求详情页
        let parse_html = if let Some(detail_url) = source.extract_detail_url(&html, &designation) {
            println!(
                "=== [任务 {}] 需要二次请求详情页: {} ===",
                task_id, detail_url
            );
            let detail_site = ResourceSite {
                id: site.id.clone(),
                name: site.name.clone(),
                fetch_mode: site.fetch_mode.clone(),
                enabled: true,
            };
            match fetcher
                .fetch(&self.app, &detail_url, &detail_site, webview_enabled)
                .await
            {
                Ok(dh) => {
                    println!("=== [任务 {}] 详情页返回 {} 字符 ===", task_id, dh.len());
                    dh
                }
                Err(e) => {
                    println!(
                        "=== [任务 {}] 详情页请求失败: {}，回退到搜索页 ===",
                        task_id, e
                    );
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

        println!(
            "=== [任务 {}] 解析成功: {} ===",
            task_id, search_result.title
        );

        // 将 SearchResult 转换为 ScrapeMetadata
        let mut metadata = super::commands::search_result_to_metadata(&search_result);
        match crate::utils::ai_translator::translate_scrape_metadata(&self.app, &metadata).await {
            Ok(translated) => {
                metadata = translated;
                println!("=== [任务 {}] 已应用 AI 翻译（若命中日语/英语） ===", task_id);
            }
            Err(e) => {
                println!("=== [任务 {}] AI 翻译跳过: {} ===", task_id, e);
            }
        }
        let video_id = self.find_video_id_by_path(&task.path)?;
        let prepared_video = super::commands::prepare_video_for_scrape_save(&self.db, &video_id)?;
        let video_path = prepared_video.video_path.clone();

        self.db
            .update_scrape_task_progress(task_id, 2)
            .map_err(|e| e.to_string())?;
        self.emit_progress(task_id, 2).await;

        if self.check_stop(task_id, 2).await? {
            return Err("Task stopped".to_string());
        }

        // 步骤 3: 下载封面图片（进度 3）
        let local_cover_path = if !metadata.poster_url.is_empty() {
            match crate::download::image::download_cover(&video_path, &metadata.poster_url, None)
                .await
            {
                Ok(path) => {
                    println!("=== [任务 {}] 封面下载成功: {} ===", task_id, path);
                    path
                }
                Err(e) => {
                    eprintln!("下载封面失败: {}", e);
                    prepared_video.poster.clone().unwrap_or_default()
                }
            }
        } else {
            prepared_video.poster.clone().unwrap_or_default()
        };

        self.db
            .update_scrape_task_progress(task_id, 3)
            .map_err(|e| e.to_string())?;
        self.emit_progress(task_id, 3).await;

        if self.check_stop(task_id, 3).await? {
            return Err("Task stopped".to_string());
        }

        // 步骤 4: 下载预览图并生成 NFO（进度 4）
        if !metadata.thumbs.is_empty() {
            let preview_items: Vec<(usize, String)> = metadata
            .thumbs
                .iter()
                .enumerate()
                .map(|(index, url)| (index + 1, url.clone()))
                .collect();

            if let Err(e) = crate::utils::media_assets::sync_extrafanart_from_urls(
                &video_path,
                preview_items,
            )
            .await
            {
                eprintln!("下载 extrafanart 预览图失败: {}", e);
            }
        }

        if let Err(e) = self.save_nfo(&video_path, &metadata) {
            eprintln!("保存 NFO 失败: {}", e);
        }

        self.db
            .update_scrape_task_progress(task_id, 4)
            .map_err(|e| e.to_string())?;
        self.emit_progress(task_id, 4).await;

        if self.check_stop(task_id, 4).await? {
            return Err("Task stopped".to_string());
        }

        // 步骤 5: 更新数据库（进度 5）
        let writer = DatabaseWriter::new(&self.db);
        match writer
            .write_all(
                video_id.clone(),
                metadata,
                local_cover_path,
            )
            .await
        {
            Ok(_) => {
                println!("=== [任务 {}] 数据库更新成功 ===", task_id);
            }
            Err(e) => {
                eprintln!("=== [任务 {}] 数据库更新失败: {} ===", task_id, e);
            }
        }

        // 标记为已完成
        self.db
            .update_scrape_task_status(task_id, ScrapeStatus::Completed, Some(5))
            .await
            .map_err(|e| e.to_string())?;
        self.emit_progress(task_id, 5).await;

        println!("=== [任务 {}] process_task() 成功完成 ===", task_id);
        Ok(())
    }

    /// 发送进度事件到前端
    async fn emit_progress(&self, task_id: &str, progress: i32) {
        #[derive(serde::Serialize, Clone)]
        struct ProgressPayload {
            task_id: String,
            progress: i32,
        }

        let payload = ProgressPayload {
            task_id: task_id.to_string(),
            progress,
        };

        let _ = self.app.emit("scrape-task-progress", payload);
    }

    /// 发送队列状态事件到前端
    async fn emit_queue_status(&self, status: &str) {
        #[derive(serde::Serialize, Clone)]
        struct QueueStatusPayload {
            status: String,
        }

        let payload = QueueStatusPayload {
            status: status.to_string(),
        };

        if let Err(e) = self.app.emit("task-queue-status", payload) {
            eprintln!("发送队列状态事件失败: {}", e);
        }
    }

    /// 从视频文件名中提取番号（使用 DesignationRecognizer 统一逻辑）
    fn extract_designation(&self, video_path: &str) -> Result<String, String> {
        use std::path::Path;

        let path = Path::new(video_path);
        let filename = path.file_stem().ok_or("无效的文件名")?.to_string_lossy();

        let recognizer = crate::utils::designation_recognizer::DesignationRecognizer::new();
        recognizer.recognize_with_regex(&filename).ok_or_else(|| {
            format!(
                "无法从文件名中提取番号: {}。文件名应包含类似 ABC-123 格式的番号",
                filename
            )
        })
    }

    /// 检查队列是否应停止
    async fn check_stop(&self, task_id: &str, current_progress: i32) -> Result<bool, String> {
        let is_stopped = self.is_stopped.lock().await;
        if *is_stopped {
            println!(
                "=== [任务 {}] 队列在进度 {} 处停止 ===",
                task_id, current_progress
            );
            return Ok(true);
        }
        Ok(false)
    }

    /// 保存 NFO 文件（复用 media_assets 中的统一逻辑）
    fn save_nfo(&self, video_path: &str, metadata: &ScrapeMetadata) -> Result<(), String> {
        crate::utils::media_assets::save_nfo_for_video(video_path, metadata)
    }

    /// 通过视频路径查找视频 ID
    fn find_video_id_by_path(&self, video_path: &str) -> Result<String, String> {
        let mut conn = self.db.get_connection().map_err(|e| e.to_string())?;
        let transaction = conn.transaction().map_err(|e| e.to_string())?;
        // 查询视频 ID
        Database::get_video_id_by_path(&transaction, video_path)
            .map_err(|e| format!("未找到路径 {} 对应的视频: {}", video_path, e))
    }
}

/// 根据网站 ID 获取对应的 Source 解析器和 ResourceSite 配置
fn get_source_and_site(site_id: &str) -> Option<(Box<dyn Source>, ResourceSite)> {
    let all = sources::all_sources();
    let sites = sources::default_sites();

    // 找到匹配 ID 的 Source 和 ResourceSite
    let site = sites.into_iter().find(|s| s.id == site_id)?;
    let source = all.into_iter().find(|s| s.name() == site_id)?;

    Some((source, site))
}
