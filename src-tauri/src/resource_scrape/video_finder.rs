//! 视频下载链接查找器
//!
//! 通过 WebView 访问视频网站页面，注入 JS 拦截网络请求，
//! 捕获 m3u8/mp4/ts 等视频流链接，通过 Tauri 事件推送给前端。
//!
//! 支持多个视频网站，每个网站有不同的 URL 构建策略。

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri::Listener;

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

/// 查找超时（秒）
const FINDER_TIMEOUT_SECS: u64 = 45;

/// 前端视频链接查找 CF 状态事件
const VIDEO_FINDER_CF_STATE_EVENT: &str = "video-finder-cf-state";

/// 注入到 WebView 的 JS 脚本
/// 拦截 XMLHttpRequest、fetch、HLS.js 等，捕获视频链接并通过 Tauri 事件发送
const INTERCEPT_JS: &str = r#"
(function() {
    if (window.__VIDEO_FINDER_INJECTED__) return;
    window.__VIDEO_FINDER_INJECTED__ = true;
    window.__VIDEO_FINDER_URLS__ = new Set();

    // 视频链接匹配正则（放宽后缀限制，包含txt）
    var VIDEO_RE = /\.(m3u8|mp4|ts|txt)(?:[#\?].*)?$/i;
    // 兼容像 /qc/v.m3u8 等路径
    var URL_SCAN_RE = /https?:\/\/[^\s"'`<>\\\)\]\}]+\.(?:m3u8|mp4|ts|txt)(?:[#\?][^\s"'`<>\\\)\]\}]*)?/gi;

    function reportUrl(url) {
        if (!url || typeof url !== 'string') return;
        // 清理 URL 末尾的特殊字符
        url = url.replace(/["'`\\;,\s]+$/, '');
        if (!VIDEO_RE.test(url)) return;
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
        if (typeof url === 'string') reportUrl(url);
        return origOpen.apply(this, arguments);
    };

    // 拦截 XMLHttpRequest 响应（可能包含 master playlist 指向子 m3u8）
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function() {
        var xhr = this;
        xhr.addEventListener('load', function() {
            try {
                if (xhr.responseText) scanText(xhr.responseText);
            } catch(e) {}
        });
        return origSend.apply(this, arguments);
    };

    // 拦截 fetch
    var origFetch = window.fetch;
    window.fetch = function(input, init) {
        var url = (typeof input === 'string') ? input : (input && input.url ? input.url : '');
        if (url) reportUrl(url);
        // 也检查 fetch 响应内容
        var p = origFetch.apply(this, arguments);
        p.then(function(resp) {
            // clone 响应以便读取内容
            try {
                var ct = resp.headers.get('content-type') || '';
                if (ct.indexOf('mpegurl') !== -1 || ct.indexOf('text') !== -1 || ct.indexOf('json') !== -1) {
                    resp.clone().text().then(function(body) {
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
    let url_str = build_site_url(site_id, code)?;
    println!(
        "[video_finder] 打开 WebView: {} (网站: {})",
        url_str, site_id
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

    let window =
        WebviewWindowBuilder::new(app, VIDEO_FINDER_LABEL, WebviewUrl::External(parsed_url))
            .title(format!("查找视频链接 - {}", code.to_uppercase()))
            .inner_size(1920.0, 1080.0)
            .center()
            .visible(is_visible)
            .build()
            .map_err(|e| format!("创建 WebView 窗口失败: {}", e))?;

    webview_support::emit_cf_state(app, VIDEO_FINDER_CF_STATE_EVENT, false);

    let cf_event_name = webview_support::next_event_name("video-finder-cf-status");
    let cf_listener_id = webview_support::listen_cf_visibility(
        app,
        &window,
        &cf_event_name,
        is_visible,
        Some(VIDEO_FINDER_CF_STATE_EVENT),
    );
    let cf_probe_js = webview_support::build_cf_probe_script(&cf_event_name);

    // 页面加载后注入拦截脚本
    let window_clone = window.clone();
    let app_clone = app.clone();
    tokio::spawn(async move {
        // 立即开始注入（不等待），尽早拦截网络请求
        let inject_count = FINDER_TIMEOUT_SECS * 4; // 每 250ms 注入一次
        for i in 0..inject_count {
            // 检查窗口是否还存在
            if app_clone.get_webview_window(VIDEO_FINDER_LABEL).is_none() {
                println!("[video_finder] WebView 窗口已关闭，停止注入");
                break;
            }

            if let Err(e) = window_clone.eval(INTERCEPT_JS) {
                if i % 20 == 0 {
                    println!("[video_finder] 注入脚本失败 (第 {} 次): {}", i, e);
                }
            }

            if let Err(e) = window_clone.eval(&cf_probe_js) {
                if i % 20 == 0 {
                    println!("[video_finder] CF 探测失败 (第 {} 次): {}", i, e);
                }
            }

            // 前 10 秒每 250ms 注入一次（更积极），之后每 1 秒
            let delay = if i < 40 { 250 } else { 1000 };
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }

        app_clone.unlisten(cf_listener_id);
        webview_support::emit_cf_state(&app_clone, VIDEO_FINDER_CF_STATE_EVENT, false);
    });

    Ok(())
}

/// 关闭视频查找 WebView 窗口
pub fn close_video_finder_webview(app: &AppHandle) -> Result<(), String> {
    webview_support::emit_cf_state(app, VIDEO_FINDER_CF_STATE_EVENT, false);
    if let Some(window) = app.get_webview_window(VIDEO_FINDER_LABEL) {
        window.close().map_err(|e| format!("关闭窗口失败: {}", e))?;
    }
    Ok(())
}

/// HLS 验证结果
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HlsVerifyResult {
    /// 是否为有效的 HLS 播放列表
    pub is_hls: bool,
    /// 是否为 VOD（完整视频），false 表示直播流
    pub is_vod: bool,
    /// 分辨率（从 HLS 内容中提取）
    pub resolution: Option<String>,
}

/// 验证单个 URL 是否为 HLS 播放列表，并判断是否为 VOD
pub async fn verify_hls(url: &str, referer: Option<&str>) -> HlsVerifyResult {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("Mozilla/5.0")
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            return HlsVerifyResult {
                is_hls: false,
                is_vod: false,
                resolution: None,
            }
        }
    };

    let referer_val = referer.unwrap_or("https://missav.ws/");

    match client.get(url).header("Referer", referer_val).send().await {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(body) = resp.text().await {
                let trimmed = body.trim();
                if !trimmed.starts_with("#EXTM3U") {
                    return HlsVerifyResult {
                        is_hls: false,
                        is_vod: false,
                        resolution: None,
                    };
                }

                // 判断是否为 VOD
                // VOD 标志：#EXT-X-PLAYLIST-TYPE:VOD 或 #EXT-X-ENDLIST
                let is_vod = trimmed.contains("#EXT-X-PLAYLIST-TYPE:VOD")
                    || trimmed.contains("#EXT-X-ENDLIST");

                // 排除直播流标志
                let is_live = trimmed.contains("#EXT-X-PLAYLIST-TYPE:EVENT")
                    || (!trimmed.contains("#EXT-X-ENDLIST")
                        && !trimmed.contains("#EXT-X-PLAYLIST-TYPE:VOD"));

                // 提取分辨率
                let resolution = extract_resolution_from_hls(trimmed);

                HlsVerifyResult {
                    is_hls: true,
                    is_vod: is_vod && !is_live,
                    resolution,
                }
            } else {
                HlsVerifyResult {
                    is_hls: false,
                    is_vod: false,
                    resolution: None,
                }
            }
        }
        _ => HlsVerifyResult {
            is_hls: false,
            is_vod: false,
            resolution: None,
        },
    }
}

/// 从 HLS 播放列表内容中提取分辨率
fn extract_resolution_from_hls(content: &str) -> Option<String> {
    let re = Regex::new(r"RESOLUTION=(\d+)x(\d+)").unwrap();
    if let Some(cap) = re.captures(content) {
        let height: u32 = cap[2].parse().unwrap_or(0);
        return match height {
            2160 => Some("2160p".to_string()),
            1080 => Some("1080p".to_string()),
            720 => Some("720p".to_string()),
            480 => Some("480p".to_string()),
            360 => Some("360p".to_string()),
            h if h > 0 => Some(format!("{}p", h)),
            _ => None,
        };
    }
    None
}
