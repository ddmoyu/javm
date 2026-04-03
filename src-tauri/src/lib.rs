// Tauri 命令入口 - https://tauri.app/develop/calling-rust/
#[macro_use]
mod logging;

pub mod error;
pub mod db;
mod deep_link;
mod metadata;
mod settings;
mod analytics;
// 功能模块
pub mod video;
pub mod media;
pub mod download;
pub mod nfo;
pub mod resource_scrape;
pub mod scanner;
pub mod utils;

use tauri::{AppHandle, Manager};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
use tokio::sync::Mutex;

async fn cleanup_before_exit(app: &AppHandle) {
    if let Some(manager) = app.try_state::<download::manager::DownloadManager>() {
        manager.shutdown().await;
    }

    if let Ok(db) = db::Database::new(app) {
        if let Ok(conn) = db.get_connection() {
            let _ = conn.execute(
                "UPDATE downloads
                 SET status = 9,
                     error_message = CASE
                        WHEN error_message IS NULL OR trim(error_message) = '' THEN '应用关闭时任务已停止'
                        ELSE error_message
                     END,
                     updated_at = datetime('now')
                 WHERE status IN (1, 2, 3, 4, 8)",
                [],
            );
        }
    }
}

// ==================== 系统级薄封装命令 ====================

#[tauri::command]
fn parse_deep_link(url: String) -> Result<deep_link::ParsedDeepLink, String> {
    deep_link::parse_url(&url)
}

#[tauri::command]
fn get_runtime_system_info() -> serde_json::Value {
    serde_json::json!({
        "os": std::env::consts::OS,
        "cpuArch": std::env::consts::ARCH,
    })
}

#[tauri::command]
async fn open_in_explorer(path: String) -> Result<(), String> {
    utils::system_commands::open_in_explorer(path).await
}

#[tauri::command]
async fn open_with_player(app: AppHandle, path: String) -> Result<(), String> {
    utils::system_commands::open_with_player(path).await?;
    analytics::record_play_video(&app);
    Ok(())
}

#[tauri::command]
fn get_local_file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path)
        .map(|metadata| metadata.len())
        .map_err(|e| format!("读取文件大小失败: {}", e))
}

#[tauri::command]
async fn open_video_player_window(
    app: AppHandle,
    video_url: String,
    title: String,
    is_hls: bool,
) -> Result<(), String> {
    utils::system_commands::open_video_player_window(app.clone(), video_url, title, is_hls).await?;
    analytics::record_play_video(&app);
    Ok(())
}

#[tauri::command]
async fn proxy_hls_request(
    url: String,
    referer: Option<String>,
) -> Result<(String, String), String> {
    utils::system_commands::proxy_hls_request(url, referer).await
}

// ==================== 应用入口 ====================

pub fn run() {
    logging::init_panic_hook();

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            log::info!("[app_lifecycle] event=single_instance_activated argv={:?}", argv);
        }));

        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("javm".to_string()),
                    }),
                ])
                .level(log::LevelFilter::Info)
                .rotation_strategy(RotationStrategy::KeepAll)
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .max_file_size(5_000_000)
                .build(),
        )
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_localhost::Builder::new(1421).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();

                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    cleanup_before_exit(&app).await;
                    app.exit(0);
                });
            }
        })
        .setup(|app| {
            let initial_settings = tauri::async_runtime::block_on(crate::settings::get_settings(app.handle().clone())).ok();

            // 初始化全局代理缓存
            if let Ok(config_dir) = app.path().app_config_dir() {
                utils::proxy::init(&config_dir);
            }

            let db = db::Database::new(app.handle())
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            db.check_and_reset_if_needed();
            db.init().map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            app.manage(db);

            // 注册深度链接处理器
            #[cfg(desktop)]
            {
                #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
                {
                    use tauri_plugin_deep_link::DeepLinkExt;
                    app.deep_link().register_all()?;
                }
            }

            // --- 恢复主窗口位置与尺寸 ---
            if let Some(main_window) = app.handle().get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = main_window.set_icon(icon.clone());
                }

                match initial_settings.clone() {
                    Some(settings) => {
                        let vp_settings = settings.main_window;
                        let _ = main_window.set_min_size(Some(tauri::LogicalSize::new(1080.0, 720.0)));

                        if let (Some(w), Some(h)) = (vp_settings.width, vp_settings.height) {
                            let width = w.max(1080.0);
                            let height = h.max(720.0);
                            let _ = main_window.set_size(tauri::LogicalSize::new(width, height));
                        }

                        if let (Some(x), Some(y)) = (vp_settings.x, vp_settings.y) {
                            if utils::system_commands::is_position_visible_on_monitors(&main_window, x, y) {
                                let _ = main_window
                                    .set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
                            } else {
                                let _ = main_window.center();
                            }
                        }
                    }
                    None => {
                        log::warn!("[app_startup] event=load_settings_failed_using_default_window_size");
                    }
                }
            }

            // 初始化截图取消令牌管理
            app.manage(media::commands::CaptureState {
                cancel_token: Mutex::new(None),
            });

            // 初始化下载管理器
            let download_concurrent = initial_settings
                .as_ref()
                .map(|settings| settings.download.concurrent.max(1) as usize)
                .unwrap_or(3);
            app.manage(download::manager::DownloadManager::new(download_concurrent));

            // 初始化资源刮削状态
            app.manage(resource_scrape::commands::RsTaskQueueState::new());
            app.manage(resource_scrape::fetcher::WebviewPoolState::default());
            app.manage(resource_scrape::commands::SearchCancelState::new());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 系统（lib.rs 内联）
            parse_deep_link,
            get_runtime_system_info,
            open_in_explorer,
            open_with_player,
            get_local_file_size,
            open_video_player_window,
            proxy_hls_request,
            // 视频 + 目录
            video::commands::get_videos,
            video::commands::get_duplicate_videos,
            video::commands::delete_video_db,
            video::commands::delete_video_file,
            video::commands::move_video_file,
            video::commands::update_video,
            video::commands::find_ad_videos,
            video::commands::delete_videos,
            video::commands::download_remote_image,
            video::commands::get_directories,
            video::commands::add_directory,
            video::commands::delete_directory,
            // 媒体/截图
            media::commands::capture_video_frames,
            media::commands::cancel_capture,
            media::commands::delete_cover,
            media::commands::save_captured_cover,
            media::commands::save_captured_thumbs,
            media::commands::resolve_video_preview_images,
            media::commands::delete_thumb,
            media::commands::clear_thumbs,
            // 扫描
            scanner::commands::scan_directory,
            // 设置
            settings::commands::get_settings,
            settings::commands::save_settings,
            settings::commands::get_log_directory,
            settings::commands::export_logs,
            settings::commands::test_ai_api,
            settings::commands::recognize_designation_with_ai,
            // 更新
            utils::updater::check_app_update,
            utils::updater::install_app_update,
            // 分析
            analytics::analytics_init,
            analytics::analytics_add_active_seconds,
            analytics::analytics_sync_now,
            analytics::analytics_debug_supabase_config,
            // 下载
            download::commands::get_download_tasks,
            download::commands::add_download_task,
            download::commands::pause_download_task,
            download::commands::resume_download_task,
            download::commands::cancel_download_task,
            download::commands::stop_download_task,
            download::commands::retry_download_task,
            download::commands::delete_download_task,
            download::commands::rename_download_task,
            download::commands::change_download_save_path,
            download::commands::sync_completed_download_to_library,
            download::commands::get_default_download_path,
            download::commands::batch_pause_tasks,
            download::commands::batch_resume_tasks,
            download::commands::batch_stop_tasks,
            download::commands::batch_retry_tasks,
            download::commands::batch_delete_tasks,
            // 资源刮削
            resource_scrape::commands::rs_search_resource,
            resource_scrape::commands::rs_cancel_search,
            resource_scrape::commands::rs_proxy_image,
            resource_scrape::commands::get_resource_sites,
            resource_scrape::commands::rs_scrape_save,
            resource_scrape::commands::rs_get_scrape_tasks,
            resource_scrape::commands::rs_create_filtered_scrape_tasks,
            resource_scrape::commands::rs_start_task_queue,
            resource_scrape::commands::rs_stop_task_queue,
            resource_scrape::commands::rs_stop_scrape_task,
            resource_scrape::commands::rs_reset_scrape_task,
            resource_scrape::commands::rs_delete_scrape_task,
            resource_scrape::commands::rs_delete_completed_scrape_tasks,
            resource_scrape::commands::rs_delete_failed_scrape_tasks,
            resource_scrape::commands::rs_delete_all_scrape_tasks,
            resource_scrape::commands::rs_check_video_completely_scraped,
            resource_scrape::commands::rs_find_video_links,
            resource_scrape::commands::rs_close_video_finder,
            resource_scrape::commands::rs_get_video_sites,
            resource_scrape::commands::rs_check_video_exists_by_code,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
