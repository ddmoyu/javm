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
use crate::resource_scrape::fingerprint_client;
use crate::resource_scrape::database_writer::DatabaseWriter;
use crate::resource_scrape::detector::ScrapedVideoDetector;
use crate::resource_scrape::fetcher::Fetcher;
use crate::resource_scrape::sources::{self, ResourceSite};
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
    /// 当前在途（正在处理）的任务 ID 集合，支持任务级并发
    in_flight: Arc<Mutex<std::collections::HashSet<String>>>,
    is_running: Arc<Mutex<bool>>,
    is_stopped: Arc<Mutex<bool>>,
}

impl TaskQueueManager {
    /// 创建新的任务队列管理器
    pub fn new(app: AppHandle) -> Result<Self, String> {
        let db = Database::new(&app).map_err(|e| e.to_string())?;
        Ok(Self {
            app,
            db,
            in_flight: Arc::new(Mutex::new(std::collections::HashSet::new())),
            is_running: Arc::new(Mutex::new(false)),
            is_stopped: Arc::new(Mutex::new(false)),
        })
    }

    pub async fn is_running(&self) -> bool {
        let is_running = self.is_running.lock().await;
        *is_running
    }

    pub async fn set_running(&self, running: bool) {
        let mut is_running = self.is_running.lock().await;
        *is_running = running;
    }

    /// 记录统一错误日志
    async fn log_error(&self, task_id: &str, error_type: &str, error_message: &str) {
        log::error!(
            "[scrape_queue] event=task_error task_id={} error_type={} error={}",
            task_id,
            error_type,
            error_message
        );
    }

    /// 启动队列处理
    ///
    /// 任务级有界并发：同时最多处理 `scrape.concurrent` 个任务，
    /// 直到队列为空或被停止。任务的网络抓取/翻译/下载等 I/O 延迟得以重叠。
    /// 每个任务前先原子认领（置为运行中），避免并发循环重复取到同一任务；
    /// 视频表与任务表的 path 均为唯一，故并发任务必然作用于不同视频，无写冲突。
    pub async fn start(&self) -> Result<(), String> {
        log::info!("[scrape_queue] event=start_requested");

        // 确认当前未在运行
        {
            let is_running = self.is_running.lock().await;
            if *is_running {
                log::warn!("[scrape_queue] event=start_rejected reason=already_running");
                return Err("Queue is already running".to_string());
            }
        }

        self.set_running(true).await;

        // 启动时重置停止标志
        {
            let mut is_stopped = self.is_stopped.lock().await;
            *is_stopped = false;
        }

        // 并发度取自设置（1~10），为 1 时等价于串行
        let concurrent = {
            let settings = crate::settings::get_settings(self.app.clone())
                .await
                .unwrap_or_default();
            (settings.scrape.concurrent.max(1) as usize).clamp(1, 10)
        };
        log::info!("[scrape_queue] event=concurrency_configured concurrent={}", concurrent);

        let semaphore = Arc::new(tokio::sync::Semaphore::new(concurrent));
        let mut set: tokio::task::JoinSet<()> = tokio::task::JoinSet::new();

        loop {
            if *self.is_stopped.lock().await {
                break;
            }

            // 先抢占一个并发槽位，避免提前把过多任务标记为运行中
            let Ok(permit) = semaphore.clone().acquire_owned().await else {
                break;
            };

            // 等待槽位期间可能已被停止，再次确认
            if *self.is_stopped.lock().await {
                drop(permit);
                break;
            }

            let Some(task_id) = self.claim_next_task().await? else {
                drop(permit);
                break;
            };

            log::info!("[scrape_queue] event=task_started task_id={}", task_id);
            self.in_flight.lock().await.insert(task_id.clone());

            let this = self.clone();
            set.spawn(async move {
                let _permit = permit;
                this.run_one_task(task_id).await;
            });
        }

        // 等待所有在途任务结束
        while set.join_next().await.is_some() {}

        if *self.is_stopped.lock().await {
            log::info!("[scrape_queue] event=queue_stopped_by_user");
            self.emit_queue_status("stopped").await;
        } else {
            log::info!("[scrape_queue] event=queue_completed");
            self.emit_queue_status("completed").await;
        }
        self.set_running(false).await;
        Ok(())
    }

    /// 原子认领下一个等待任务：取出后立即置为运行中，
    /// 避免并发循环在下一轮 `get_next_waiting_task_from_db` 时重复取到它。
    async fn claim_next_task(&self) -> Result<Option<String>, String> {
        let Some(task_id) = self.get_next_waiting_task_from_db()? else {
            log::info!("[scrape_queue] event=no_waiting_task");
            return Ok(None);
        };
        self.db
            .update_scrape_task_status(&task_id, ScrapeStatus::Running, Some(0))
            .await
            .map_err(|e| e.to_string())?;
        Ok(Some(task_id))
    }

    /// 执行单个任务并处理其结果（供并发驱动）。
    async fn run_one_task(&self, task_id: String) {
        if let Err(e) = self.process_task(&task_id).await {
            log::error!("[scrape_queue] event=task_failed task_id={} error={}", task_id, e);

            if e.contains("stopped") {
                // 被停止的任务重置为等待状态，便于下次重跑
                let _ = self
                    .db
                    .update_scrape_task_status(&task_id, ScrapeStatus::Waiting, Some(0))
                    .await;
            } else {
                let _ = self
                    .db
                    .update_scrape_task_status(&task_id, ScrapeStatus::Failed, None)
                    .await;

                if let Err(emit_err) = self.app.emit(
                    "scrape-task-failed",
                    serde_json::json!({
                        "task_id": task_id,
                        "error": e
                    }),
                ) {
                    log::error!(
                        "[scrape_queue] event=emit_task_failed_event_failed task_id={} error={}",
                        task_id,
                        emit_err
                    );
                }

                self.log_error(&task_id, "Task failed", &e).await;
            }
        }

        self.in_flight.lock().await.remove(&task_id);
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
        log::info!("[scrape_queue] event=stop_requested");
        let mut is_stopped = self.is_stopped.lock().await;
        *is_stopped = true;
    }

    /// 判断指定任务当前是否在途（正在处理）
    pub async fn is_task_running(&self, task_id: &str) -> bool {
        self.in_flight.lock().await.contains(task_id)
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
        log::info!("[scrape_queue] event=process_task_begin task_id={}", task_id);

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

        log::info!("[scrape_queue] event=task_loaded task_id={} path={}", task_id, task.path);

        // 检查视频是否已刮削
        let detector = ScrapedVideoDetector::new(&self.db);
        let should_skip = detector
            .is_video_scraped(&task.path)
            .map_err(|e| format!("检查视频刮削状态失败: {}", e))?;

        if should_skip {
            log::info!(
                "[scrape_queue] event=task_skipped_already_scraped task_id={} path={}",
                task_id,
                task.path
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
        log::info!(
            "[scrape_queue] event=designation_extracted task_id={} path={} designation={}",
            task_id,
            task.path,
            designation
        );
        self.db
            .update_scrape_task_progress(task_id, 1)
            .map_err(|e| e.to_string())?;
        self.emit_progress(task_id, 1).await;

        if self.check_stop(task_id, 1).await? {
            return Err("Task stopped".to_string());
        }

        // 步骤 2: 使用设置中的默认刮削网站获取元数据
        let settings = crate::settings::get_settings(self.app.clone()).await.unwrap_or_default();
        let active_site = crate::settings::resolve_active_scrape_site(&settings.scrape)
            .ok_or_else(|| "未启用任何刮削网站，请先在设置中开启至少一个网站".to_string())?;
        let source = sources::all_sources()
            .into_iter()
            .find(|item| item.name() == active_site.id)
            .ok_or_else(|| format!("未找到默认刮削网站解析器: {}", active_site.id))?;
        let site = active_site;

        let url = source.build_url(&designation);
        log::info!(
            "[scrape_queue] event=fetch_started task_id={} source={} designation={} url={}",
            task_id,
            source.name(),
            designation,
            url
        );

        // 创建 Fetcher 获取 HTML
        let http_client = fingerprint_client::shared_client()?;
        let fetcher = Fetcher::new(http_client);

        let fetch_settings = crate::settings::resolve_scrape_fetch_settings(&settings.scrape);
        let fetch_options = crate::resource_scrape::fetcher::FetchOptions {
            webview_enabled: fetch_settings.webview_enabled,
            webview_fallback_enabled: fetch_settings.webview_fallback_enabled,
            show_webview: fetch_settings.dev_show_webview,
            max_webview_windows: fetch_settings.max_webview_windows,
        };
        let html = fetcher
            .fetch(&self.app, &url, &site, fetch_options)
            .await
            .map_err(|e| format!("获取页面失败: {}", e))?;

        log::info!(
            "[scrape_queue] event=fetch_succeeded task_id={} source={} html_length={}",
            task_id,
            source.name(),
            html.len()
        );

        // 检查是否需要二次请求详情页
        let parse_html = if let Some(detail_url) = source.extract_detail_url(&html, &designation) {
            log::info!(
                "[scrape_queue] event=detail_fetch_started task_id={} detail_url={}",
                task_id,
                detail_url
            );
            let detail_site = ResourceSite {
                id: site.id.clone(),
                name: site.name.clone(),
                enabled: true,
                avg_score: None,
                scrape_count: None,
            };
            match fetcher
                .fetch(&self.app, &detail_url, &detail_site, fetch_options)
                .await
            {
                Ok(dh) => {
                    log::info!(
                        "[scrape_queue] event=detail_fetch_succeeded task_id={} html_length={}",
                        task_id,
                        dh.len()
                    );
                    dh
                }
                Err(e) => {
                    log::warn!(
                        "[scrape_queue] event=detail_fetch_failed task_id={} fallback=search_page error={}",
                        task_id,
                        e
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

        log::info!(
            "[scrape_queue] event=parse_succeeded task_id={} title={}",
            task_id,
            search_result.title
        );

        // 将 SearchResult 转换为 ScrapeMetadata
        let mut metadata = super::commands::search_result_to_metadata(&search_result);
        match crate::utils::ai_translator::translate_scrape_metadata(&self.app, &metadata).await {
            Ok(translated) => {
                metadata = translated;
                log::info!("[scrape_queue] event=translation_applied task_id={}", task_id);
            }
            Err(e) => {
                log::warn!("[scrape_queue] event=translation_skipped task_id={} error={}", task_id, e);
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
                    log::info!(
                        "[scrape_queue] event=cover_download_succeeded task_id={} path={}",
                        task_id,
                        path
                    );
                    path
                }
                Err(e) => {
                    log::error!("[scrape_queue] event=cover_download_failed task_id={} error={}", task_id, e);
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

            if let Err(e) = crate::media::assets::sync_extrafanart_from_urls(
                &video_path,
                preview_items,
            )
            .await
            {
                log::error!(
                    "[scrape_queue] event=extrafanart_sync_failed task_id={} path={} error={}",
                    task_id,
                    video_path,
                    e
                );
            }
        }

        if let Err(e) = self.save_nfo(&video_path, &metadata) {
            log::error!("[scrape_queue] event=save_nfo_failed task_id={} path={} error={}", task_id, video_path, e);
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
                log::info!("[scrape_queue] event=db_write_succeeded task_id={} video_id={}", task_id, video_id);
            }
            Err(e) => {
                log::error!("[scrape_queue] event=db_write_failed task_id={} video_id={} error={}", task_id, video_id, e);
                // 核心数据写库失败不能再标记为已完成，应让任务失败
                return Err(format!("写入数据库失败: {}", e));
            }
        }

        // 标记为已完成
        self.db
            .update_scrape_task_status(task_id, ScrapeStatus::Completed, Some(5))
            .await
            .map_err(|e| e.to_string())?;
        self.emit_progress(task_id, 5).await;

        log::info!("[scrape_queue] event=process_task_completed task_id={}", task_id);
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
            log::error!(
                "[scrape_queue] event=emit_queue_status_failed status={} error={}",
                status,
                e
            );
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
            log::info!(
                "[scrape_queue] event=task_stop_detected task_id={} progress={}",
                task_id,
                current_progress
            );
            return Ok(true);
        }
        Ok(false)
    }

    /// 保存 NFO 文件（复用 media_assets 中的统一逻辑）
    fn save_nfo(&self, video_path: &str, metadata: &ScrapeMetadata) -> Result<(), String> {
        crate::media::assets::save_nfo_for_video(video_path, metadata)
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

