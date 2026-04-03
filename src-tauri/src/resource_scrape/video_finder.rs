//! 视频下载链接查找器
//!
//! 通过 WebView 访问视频网站页面，注入 JS 拦截网络请求，
//! 捕获 m3u8/mp4/ts 等视频流链接，通过 Tauri 事件推送给前端。
//!
//! 支持多个视频网站，每个网站有不同的 URL 构建策略。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri::Listener;

use super::sources::ResourceSite;
use super::webview_support;

/// 找到的视频链接
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct VideoLink {
    /// 视频链接 URL
    pub url: String,
    /// 链接类型：m3u8 / mp4 / ts / txt
    pub link_type: String,
    /// 是否为 HLS 播放列表
    pub is_hls: bool,
    /// 分辨率标签（如 720p、1080p）
    pub resolution: Option<String>,
}

/// 视频网站定义
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoSite {
    /// 唯一标识
    pub id: String,
    /// 显示名称
    pub name: String,
    /// URL 模板，{code} 会被替换为番号
    pub url_template: String,
}

/// 获取所有支持的视频网站列表
pub fn get_video_sites() -> Vec<VideoSite> {
    vec![
        VideoSite {
            id: "missav".to_string(),
            name: "MissAV".to_string(),
            url_template: "https://missav.ws/{code}".to_string(),
        },
        VideoSite {
            id: "thisav".to_string(),
            name: "ThisAV".to_string(),
            url_template: "https://thisav2.com/cn/{code}".to_string(),
        },
        VideoSite {
            id: "njav".to_string(),
            name: "NJAV".to_string(),
            url_template: "https://www.njav.com/zh/xvideos/{code}".to_string(),
        },
        VideoSite {
            id: "jable".to_string(),
            name: "Jable.tv".to_string(),
            url_template: "https://jable.tv/videos/{code}/".to_string(),
        },
        VideoSite {
            id: "jptt".to_string(),
            name: "JPTT.tv".to_string(),
            url_template: "https://jptt.tv/video/{code}".to_string(),
        },
        VideoSite {
            id: "javsb".to_string(),
            name: "Jav.sb".to_string(),
            url_template: "https://jav.sb/jav/{code}-1-1.html".to_string(),
        },
        VideoSite {
            id: "123av".to_string(),
            name: "123AV".to_string(),
            url_template: "https://123av.com/zh/v/{code}".to_string(),
        },
        VideoSite {
            id: "myjav".to_string(),
            name: "MyJav.tv".to_string(),
            url_template: "https://cn.myjav.tv/video/{code}".to_string(),
        },
        VideoSite {
            id: "javgg".to_string(),
            name: "JavGG".to_string(),
            url_template: "https://javgg.net/jav/{code}/".to_string(),
        },
        VideoSite {
            id: "javct".to_string(),
            name: "JavCT".to_string(),
            url_template: "https://javct.net/v/{code}".to_string(),
        },
        VideoSite {
            id: "javcl".to_string(),
            name: "JavCL".to_string(),
            url_template: "https://javcl.com/{code}".to_string(),
        },
        VideoSite {
            id: "javmost".to_string(),
            name: "JavMost".to_string(),
            url_template: "https://www.javmost.ws/{CODE}/".to_string(),
        },
        VideoSite {
            id: "javeng".to_string(),
            name: "JavEng".to_string(),
            url_template: "https://javeng.tv/jav-eng-sub/{code}/".to_string(),
        },
        VideoSite {
            id: "jpsub".to_string(),
            name: "JPSub".to_string(),
            url_template: "https://jpsub.net/{code}".to_string(),
        },
    ]
}

/// 根据网站 ID 和番号构建访问 URL
///
/// URL 模板中 `{code}` 替换为小写番号，`{CODE}` 替换为大写番号
pub fn build_site_url(site_id: &str, code: &str) -> Result<String, String> {
    let sites = get_video_sites();
    let site = sites
        .iter()
        .find(|s| s.id == site_id)
        .ok_or_else(|| format!("未知的视频网站: {}", site_id))?;
    let url = site
        .url_template
        .replace("{CODE}", &code.to_uppercase())
        .replace("{code}", &code.to_lowercase());
    Ok(url)
}

/// WebView 窗口标识
const VIDEO_FINDER_LABEL: &str = "video_finder_webview";

/// 视频链接查找最大运行时长（秒）
const FINDER_MAX_RUNTIME_SECS: u64 = 20 * 60;

/// 前端视频链接查找 CF 状态事件
const VIDEO_FINDER_CF_STATE_EVENT: &str = "video-finder-cf-state";

/// 注入到 WebView 的 JS 脚本
/// 拦截 XMLHttpRequest、fetch、HLS.js 等，捕获视频链接并通过 Tauri 事件发送
const INTERCEPT_JS: &str = r#"
(function() {
    if (window.__CF_CHALLENGE_ACTIVE__) return;
    if (window.__VIDEO_FINDER_INJECTED__) return;
    window.__VIDEO_FINDER_INJECTED__ = true;
    window.__VIDEO_FINDER_URLS__ = new Set();

    // 视频链接匹配正则（放宽后缀限制，包含txt）
    var VIDEO_RE = /\.(m3u8|mp4|ts|txt)(?:[#\?].*)?$/i;
    // 兼容像 /qc/v.m3u8 等路径
    var URL_SCAN_RE = /https?:\/\/[^\s"'`<>\\\)\]\}]+\.(?:m3u8|mp4|ts|txt)(?:[#\?][^\s"'`<>\\\)\]\}]*)?/gi;

    function looksLikeHlsText(text) {
        if (!text || typeof text !== 'string') return false;
        var trimmed = text.replace(/^\uFEFF/, '').trim();
        return trimmed.indexOf('#EXTM3U') === 0;
    }

    function reportUrl(url, force) {
        if (!url || typeof url !== 'string') return;
        // 清理 URL 末尾的特殊字符
        url = url.replace(/["'`\\;,\s]+$/, '');
        if (!force && !VIDEO_RE.test(url)) return;
        if (window.__VIDEO_FINDER_URLS__.has(url)) return;
        window.__VIDEO_FINDER_URLS__.add(url);
        try {
            if (window.__TAURI__ && window.__TAURI__.event) {
                window.__TAURI__.event.emit('video-finder-link', url);
            }
        } catch(e) {
            console.log('[VideoFinder] emit 失败:', e);
        }
    }

    // 扫描文本中的视频链接
    function scanText(text) {
        if (!text || typeof text !== 'string') return;
        var match;
        URL_SCAN_RE.lastIndex = 0;
        while ((match = URL_SCAN_RE.exec(text)) !== null) {
            reportUrl(match[0]);
        }
    }

    // ========== 拦截网络请求 ==========

    // 拦截 XMLHttpRequest
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (typeof url === 'string') {
            this.__videoFinderRequestUrl = url;
            reportUrl(url, false);
        }
        return origOpen.apply(this, arguments);
    };

    // 拦截 XMLHttpRequest 响应（可能包含 master playlist 指向子 m3u8）
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function() {
        var xhr = this;
        xhr.addEventListener('load', function() {
            try {
                var body = xhr.responseText || '';
                var responseUrl = xhr.responseURL || xhr.__videoFinderRequestUrl || '';
                if (looksLikeHlsText(body)) reportUrl(responseUrl, true);
                if (body) scanText(body);
            } catch(e) {}
        });
        return origSend.apply(this, arguments);
    };

    // 拦截 fetch
    var origFetch = window.fetch;
    window.fetch = function(input, init) {
        var url = (typeof input === 'string') ? input : (input && input.url ? input.url : '');
        if (url) reportUrl(url, false);
        // 也检查 fetch 响应内容
        var p = origFetch.apply(this, arguments);
        p.then(function(resp) {
            // clone 响应以便读取内容
            try {
                var responseUrl = resp.url || url;
                var ct = resp.headers.get('content-type') || '';
                if (ct.indexOf('mpegurl') !== -1 || ct.indexOf('text') !== -1 || ct.indexOf('json') !== -1 || ct.indexOf('octet-stream') !== -1 || !ct) {
                    resp.clone().text().then(function(body) {
                        if (looksLikeHlsText(body)) reportUrl(responseUrl, true);
                        scanText(body);
                    }).catch(function(){});
                }
            } catch(e) {}
        }).catch(function(){});
        return p;
    };

    // ========== 拦截 DOM 属性 ==========

    // 拦截 Element.setAttribute
    var origSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
        if ((name === 'src' || name === 'href' || name === 'data-src') && typeof value === 'string') {
            reportUrl(value);
        }
        return origSetAttribute.apply(this, arguments);
    };

    // 拦截 HTMLMediaElement.src setter（video/audio 元素）
    try {
        var srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
        if (srcDesc && srcDesc.set) {
            var origSrcSet = srcDesc.set;
            Object.defineProperty(HTMLMediaElement.prototype, 'src', {
                set: function(val) {
                    if (typeof val === 'string') reportUrl(val);
                    return origSrcSet.call(this, val);
                },
                get: srcDesc.get,
                configurable: true,
            });
        }
    } catch(e) {}

    // 拦截 HTMLSourceElement.src setter
    try {
        var srcDesc2 = Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, 'src');
        if (srcDesc2 && srcDesc2.set) {
            var origSrcSet2 = srcDesc2.set;
            Object.defineProperty(HTMLSourceElement.prototype, 'src', {
                set: function(val) {
                    if (typeof val === 'string') reportUrl(val);
                    return origSrcSet2.call(this, val);
                },
                get: srcDesc2.get,
                configurable: true,
            });
        }
    } catch(e) {}

    // ========== 拦截 hls.js ==========
    // hls.js 通过 loadSource(url) 加载视频
    try {
        if (window.Hls) {
            var origProto = window.Hls.prototype;
            var origLoadSource = origProto.loadSource;
            if (origLoadSource) {
                origProto.loadSource = function(url) {
                    if (typeof url === 'string') reportUrl(url);
                    return origLoadSource.apply(this, arguments);
                };
            }
        }
    } catch(e) {}

    // ========== DOM 变化监听 ==========
    var observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(m) {
            m.addedNodes.forEach(function(node) {
                if (node.nodeType !== 1) return;
                if (node.src) reportUrl(node.src);
                if (node.href) reportUrl(node.href);
                // 扫描 script 标签内容
                if (node.tagName === 'SCRIPT' && node.textContent) {
                    scanText(node.textContent);
                }
                var sources = node.querySelectorAll ? node.querySelectorAll('video, source, [src], [data-src], script') : [];
                sources.forEach(function(el) {
                    if (el.src) reportUrl(el.src);
                    if (el.dataset && el.dataset.src) reportUrl(el.dataset.src);
                    if (el.tagName === 'SCRIPT' && el.textContent) scanText(el.textContent);
                });
            });
        });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // ========== 定期扫描 ==========
    function fullScan() {
        // 扫描所有 script 标签
        document.querySelectorAll('script').forEach(function(s) {
            scanText(s.textContent || '');
        });
        // 扫描 video/source 元素
        document.querySelectorAll('video, source, [src], [data-src]').forEach(function(el) {
            if (el.src) reportUrl(el.src);
            if (el.dataset && el.dataset.src) reportUrl(el.dataset.src);
        });
        // 扫描页面完整 HTML（兜底）
        scanText(document.documentElement.innerHTML);
    }

    // 首次扫描延迟 1 秒
    setTimeout(fullScan, 1000);
    // 之后每 3 秒扫描一次（持续 60 秒）
    var scanCount = 0;
    var scanInterval = setInterval(function() {
        fullScan();
        scanCount++;
        if (scanCount >= 20) clearInterval(scanInterval);
    }, 3000);
})();
"#;

/// 打开 WebView 查找视频链接
///
/// 创建可见的 WebView 窗口访问指定视频网站，
/// 注入 JS 拦截网络请求，捕获视频链接通过事件推送给前端。
pub fn open_video_finder_webview(app: &AppHandle, code: &str, site_id: &str) -> Result<(), String> {
    let code_owned = code.to_string();
    let site_id_string = site_id.to_string();
    let url_str = build_site_url(site_id, code)?;
    log::info!(
        "[video_finder] event=open_requested code={} site={} url={}",
        code,
        site_id_string,
        url_str
    );

    let parsed_url: url::Url = url_str
        .parse()
        .map_err(|e: url::ParseError| format!("URL 解析失败: {}", e))?;

    // 如果已有窗口，关闭后重建（确保干净状态）
    if let Some(existing) = app.get_webview_window(VIDEO_FINDER_LABEL) {
        let _ = existing.close();
        // 等待窗口关闭
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    // 开发和 Release 都默认隐藏；仅在遇到 CF 时由共享逻辑自动显示。
    let is_visible = false;
    let data_directory = webview_support::persistent_data_directory(app)?;

    let anti_detection_js = webview_support::build_anti_detection_script();
    let builder =
        WebviewWindowBuilder::new(app, VIDEO_FINDER_LABEL, WebviewUrl::External(parsed_url.clone()))
            .title(format!("查找视频链接 - {}", code.to_uppercase()))
            .inner_size(1920.0, 1080.0)
            .center()
            .visible(is_visible)
            .user_agent(webview_support::WEBVIEW_USER_AGENT)
            .initialization_script(&anti_detection_js)
            .data_directory(data_directory);

    #[cfg(target_os = "windows")]
    let builder = builder.additional_browser_args(webview_support::WEBVIEW_BROWSER_ARGS);

    let window = builder
        .build()
        .map_err(|e| format!("创建 WebView 窗口失败: {}", e))?;

    let resource_site = ResourceSite {
        id: site_id_string.clone(),
        name: site_id_string.clone(),
        enabled: true,
        avg_score: None,
        scrape_count: None,
    };
    let site_id_owned = site_id_string.clone();

    webview_support::emit_cf_state(
        app,
        VIDEO_FINDER_CF_STATE_EVENT,
        "idle",
        Some(site_id_owned.clone()),
        0,
    );

    let cf_event_name = webview_support::next_event_name("video-finder-cf-status");
    let cf_listener_id = webview_support::listen_cf_visibility(
        app,
        &window,
        &resource_site,
        &cf_event_name,
        Some(VIDEO_FINDER_CF_STATE_EVENT),
    );
    let cf_probe_js = webview_support::build_cf_probe_script(&cf_event_name);

    // CF 探测脚本 + 拦截脚本合并为一次 eval，确保先检测 CF 再决定是否注入拦截器。
    // INTERCEPT_JS 会检查 window.__CF_CHALLENGE_ACTIVE__，CF 页面上不会修改浏览器 API。
    let combined_js = format!("{}\n{}", cf_probe_js, INTERCEPT_JS);

    // 跟踪 CF 状态，用于调整注入频率
    let cf_active = Arc::new(AtomicBool::new(false));
    let saw_cf_challenge = Arc::new(AtomicBool::new(false));
    let fast_inject_cycles = Arc::new(AtomicU32::new(40));
    let cf_active_for_listener = cf_active.clone();
    let saw_cf_for_listener = saw_cf_challenge.clone();
    let fast_inject_cycles_for_listener = fast_inject_cycles.clone();
    let window_for_listener = window.clone();
    let target_url_for_listener = parsed_url.clone();
    let cf_state_listener_id = app.listen(cf_event_name.clone(), move |event| {
        if let Ok(detected) = serde_json::from_str::<bool>(event.payload()) {
            let was_active = cf_active_for_listener.swap(detected, Ordering::Relaxed);

            if detected {
                saw_cf_for_listener.store(true, Ordering::Relaxed);
                return;
            }

            if was_active && saw_cf_for_listener.swap(false, Ordering::Relaxed) {
                let _ = window_for_listener.hide();
                if let Err(err) = window_for_listener.navigate(target_url_for_listener.clone()) {
                    log::error!(
                        "[video_finder] event=cf_reload_failed site={} error={}",
                        site_id_string,
                        err
                    );
                } else {
                    log::info!(
                        "[video_finder] event=cf_reload_succeeded site={} action=resume_capture",
                        site_id_string
                    );
                    fast_inject_cycles_for_listener.store(40, Ordering::Relaxed);
                }
            }
        }
    });

    // 页面加载后注入拦截脚本
    let window_clone = window.clone();
    let app_clone = app.clone();
    let code_for_task = code_owned.clone();
    tokio::spawn(async move {
        let started_at = Instant::now();
        let mut quick_inject_rounds: u64 = 0;

        loop {
            if started_at.elapsed().as_secs() >= FINDER_MAX_RUNTIME_SECS {
                log::warn!(
                    "[video_finder] event=max_runtime_reached site={} code={} runtime_secs={}",
                    site_id_owned,
                    code_for_task,
                    FINDER_MAX_RUNTIME_SECS
                );
                break;
            }

            // 检查窗口是否还存在
            if app_clone.get_webview_window(VIDEO_FINDER_LABEL).is_none() {
                log::info!(
                    "[video_finder] event=window_closed_stop_inject site={} code={}",
                    site_id_owned,
                    code_for_task
                );
                break;
            }

            if let Err(e) = window_clone.eval(&combined_js) {
                if quick_inject_rounds % 20 == 0 {
                    log::warn!(
                        "[video_finder] event=inject_failed site={} code={} attempt={} error={}",
                        site_id_owned,
                        code_for_task,
                        quick_inject_rounds,
                        e
                    );
                }
            }

            let is_cf = cf_active.load(Ordering::Relaxed);
            let boosted_cycles = fast_inject_cycles.load(Ordering::Relaxed);
            // CF 验证期间降低注入频率，避免 eval 调用干扰 Turnstile 验证
            let delay = if is_cf {
                2000
            } else if boosted_cycles > 0 {
                let _ = fast_inject_cycles.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                    (value > 0).then_some(value - 1)
                });
                250
            } else if quick_inject_rounds < 40 {
                250 // 前 10 秒每 250ms（更积极）
            } else {
                1000
            };
            quick_inject_rounds += 1;
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }

        app_clone.unlisten(cf_listener_id);
        app_clone.unlisten(cf_state_listener_id);
        webview_support::emit_cf_state(
            &app_clone,
            VIDEO_FINDER_CF_STATE_EVENT,
            "idle",
            Some(site_id_owned),
            0,
        );
    });

    Ok(())
}

/// 关闭视频查找 WebView 窗口
pub fn close_video_finder_webview(app: &AppHandle) -> Result<(), String> {
    log::info!("[video_finder] event=close_requested");
    webview_support::emit_cf_state(app, VIDEO_FINDER_CF_STATE_EVENT, "idle", None, 0);
    if let Some(window) = app.get_webview_window(VIDEO_FINDER_LABEL) {
        window.close().map_err(|e| format!("关闭窗口失败: {}", e))?;
    }
    Ok(())
}

