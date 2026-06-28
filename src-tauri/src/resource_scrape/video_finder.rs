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
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
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

/// 默认下载源站点定义。`{code}`/`{CODE}` 替换番号。
/// `fail_selector`（+ 可选 `fail_text`）= 该源的「失败检测规则」：页面 querySelector 命中该选择器
/// （且元素 textContent 含 fail_text，若非空）即判该源失败、立即让槽，不等超时。空串=无规则，
/// 仅走通用 404 兜底。规则是数据，按各站 404 页逐个补；没把握就留空，不要臆造（误填会误杀正片页）。
/// 列表为代码内置（模板/规则随版本修正）；启用状态与下载成功次数由 `settings.download.sources` 叠加覆盖。
pub struct DownloadSiteDef {
    pub id: &'static str,
    pub name: &'static str,
    pub url_template: &'static str,
    pub fail_selector: &'static str,
    pub fail_text: &'static str,
}

pub const DEFAULT_DOWNLOAD_SITES: &[DownloadSiteDef] = &[
    DownloadSiteDef { id: "missav", name: "MissAV", url_template: "https://missav.ws/{code}", fail_selector: "", fail_text: "" },
    DownloadSiteDef { id: "thisav", name: "ThisAV", url_template: "https://thisav2.com/cn/{code}", fail_selector: "h1", fail_text: "找不到页面" },
    DownloadSiteDef { id: "njav", name: "NJAV", url_template: "https://www.njav.com/zh/xvideos/{code}", fail_selector: ".message", fail_text: "404 Not Found" },
    DownloadSiteDef { id: "jable", name: "Jable.tv", url_template: "https://jable.tv/videos/{code}/", fail_selector: "", fail_text: "" },
    DownloadSiteDef { id: "jptt", name: "JPTT.tv", url_template: "https://jptt.tv/video/{code}", fail_selector: "h1", fail_text: "404 Not Found" },
    DownloadSiteDef { id: "javsb", name: "Jav.sb", url_template: "https://jav.sb/jav/{code}-1-1.html", fail_selector: ".badge", fail_text: "404" },
    DownloadSiteDef { id: "123av", name: "123AV", url_template: "https://123av.com/zh/v/{code}", fail_selector: ".errpage__code", fail_text: "404" },
    DownloadSiteDef { id: "myjav", name: "MyJav.tv", url_template: "https://cn.myjav.tv/video/{code}", fail_selector: "h1", fail_text: "404" },
    DownloadSiteDef { id: "javgg", name: "JavGG", url_template: "https://javgg.net/jav/{code}/", fail_selector: ".no-result", fail_text: "404" },
    DownloadSiteDef { id: "javct", name: "JavCT", url_template: "https://javct.net/v/{code}", fail_selector: ".page-404__title", fail_text: "404" },
    DownloadSiteDef { id: "javmost", name: "JavMost", url_template: "https://www.javmost.ws/{CODE}/", fail_selector: "h1", fail_text: "404" },
    DownloadSiteDef { id: "javeng", name: "JavEng", url_template: "https://javeng.tv/jav-eng-sub/{code}/", fail_selector: ".error404", fail_text: "" },
    DownloadSiteDef { id: "javfull", name: "JavFull", url_template: "https://javfull.net/{code}/", fail_selector: "#notfound", fail_text: "" },
];

/// 根据网站 ID 和番号构建访问 URL
///
/// URL 模板中 `{code}` 替换为小写番号，`{CODE}` 替换为大写番号
pub fn build_site_url(site_id: &str, code: &str) -> Result<String, String> {
    let site = DEFAULT_DOWNLOAD_SITES
        .iter()
        .find(|s| s.id == site_id)
        .ok_or_else(|| format!("未知的视频网站: {}", site_id))?;
    Ok(site
        .url_template
        .replace("{CODE}", &code.to_uppercase())
        .replace("{code}", &code.to_lowercase()))
}

/// 取某源的失败检测规则（CSS 选择器 + 可选文本包含）。无规则或未知源返回空串对。
pub fn site_fail_rule(site_id: &str) -> (&'static str, &'static str) {
    DEFAULT_DOWNLOAD_SITES
        .iter()
        .find(|s| s.id == site_id)
        .map(|s| (s.fail_selector, s.fail_text))
        .unwrap_or(("", ""))
}

/// WebView 窗口标识前缀
pub(crate) const VIDEO_FINDER_LABEL_PREFIX: &str = "video_finder_";

/// 根据 site_id 生成对应的 WebView 窗口标识
pub(crate) fn video_finder_label(site_id: &str) -> String {
    format!("{}{}", VIDEO_FINDER_LABEL_PREFIX, site_id)
}

/// 视频链接查找最大运行时长（秒）
const FINDER_MAX_RUNTIME_SECS: u64 = 20 * 60;

/// 前端视频链接查找 CF 状态事件
const VIDEO_FINDER_CF_STATE_EVENT: &str = "video-finder-cf-state";

/// 注入到 WebView 的 JS 脚本
/// 拦截 XMLHttpRequest、fetch、HLS.js 等，捕获视频链接并通过 Tauri 事件发送
pub(crate) const INTERCEPT_JS: &str = r#"
(function() {
    var __SITE__ = '__VIDEO_FINDER_SITE__';
    // 每源失败检测规则（由后端 site_fail_rule 注入为 JS 字符串字面量；空串=无规则）
    var __FAIL_SEL__ = __VIDEO_FINDER_FAIL_SEL__;
    var __FAIL_TEXT__ = __VIDEO_FINDER_FAIL_TEXT__;
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
                window.__TAURI__.event.emit('video-finder-link', { site: __SITE__, url: url });
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
    // document-start 注入时 documentElement 可能为 null，包 try 并回退到 document，
    // 避免抛异常中断整个 IIFE（否则 fullScan/reportNotFound 永远建立不起来）
    try { observer.observe(document.documentElement || document, { childList: true, subtree: true }); } catch (e) {}

    // ========== 404 / 未找到检测 ==========
    // 页面明确是"找不到/404"时通知前端尽早结束，避免一直转圈等待。
    // 只看标题与 h1，避免误杀正常视频页（正片页标题为番号/片名，不含这些词）。
    var __notFoundReported = false;
    var NOT_FOUND_RE = /(^|[\s\-|·])(404|not\s*found|page\s*not\s*found|页面不存在|页面未找到|找不到页面|内容不存在|內容不存在|视频不存在|影片不存在|ページが見つかりません|お探しのページ)/i;
    function reportNotFound() {
        if (__notFoundReported) return;
        if (document.readyState !== 'complete') return;
        // 每源失败规则优先：命中配置的选择器（且文本含 fail_text，若非空）即判失败，立即让槽
        if (__FAIL_SEL__) {
            try {
                var __failEl = document.querySelector(__FAIL_SEL__);
                if (__failEl && (!__FAIL_TEXT__ || (__failEl.textContent || '').indexOf(__FAIL_TEXT__) !== -1)) {
                    __notFoundReported = true;
                    if (window.__TAURI__ && window.__TAURI__.event) {
                        window.__TAURI__.event.emit('video-finder-page-state', { site: __SITE__, state: 'not-found' });
                    }
                    return;
                }
            } catch(e) {}
        }
        var title = document.title || '';
        var h1 = document.querySelector('h1');
        var h1text = h1 ? (h1.textContent || '') : '';
        if (NOT_FOUND_RE.test(title) || NOT_FOUND_RE.test(h1text)) {
            __notFoundReported = true;
            try {
                if (window.__TAURI__ && window.__TAURI__.event) {
                    window.__TAURI__.event.emit('video-finder-page-state', { site: __SITE__, state: 'not-found' });
                }
            } catch(e) {}
        }
    }

    // ========== 定期扫描 ==========
    function fullScan() {
        // 顺带检测当前页面是否为 404 / 找不到
        reportNotFound();
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
pub fn open_video_finder_webview(
    app: &AppHandle,
    code: &str,
    site_id: &str,
    // 遇到 CF 验证时是否弹出窗口（对应设置中的"HTTP 失败回退 WebView"开关）
    show_on_cf: bool,
) -> Result<(), String> {
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

    let label = video_finder_label(&site_id_string);
    // 注入失败规则：序列化成 JS 字符串字面量（含转义），避免选择器/文本里的引号破坏脚本。
    let (fail_sel, fail_text) = site_fail_rule(site_id);
    let intercept = INTERCEPT_JS
        .replace("__VIDEO_FINDER_SITE__", &site_id_string)
        .replace(
            "__VIDEO_FINDER_FAIL_SEL__",
            &serde_json::to_string(fail_sel).unwrap_or_else(|_| "\"\"".to_string()),
        )
        .replace(
            "__VIDEO_FINDER_FAIL_TEXT__",
            &serde_json::to_string(fail_text).unwrap_or_else(|_| "\"\"".to_string()),
        );

    // 如果已有同 site 窗口，关闭后重建（确保干净状态）
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.close();
        // 等待窗口关闭
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    // 默认可见但用真实视口尺寸并移到屏幕外：既保证 WebView2 正常渲染/执行 JS、
    // 让自适应站点加载高清资源，又不打扰用户；仅在遇到 CF 验证时自动放大并居中。
    let is_visible = true;
    let data_directory = webview_support::persistent_data_directory(app)?;

    let anti_detection_js = webview_support::build_anti_detection_script();
    let builder =
        WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed_url.clone()))
            .title(format!("查找视频链接 - {}", code.to_uppercase()))
            .inner_size(
                webview_support::SCRAPER_VIEWPORT_WIDTH,
                webview_support::SCRAPER_VIEWPORT_HEIGHT,
            )
            .position(
                webview_support::SCRAPER_OFFSCREEN_POS,
                webview_support::SCRAPER_OFFSCREEN_POS,
            )
            .visible(is_visible)
            .user_agent(webview_support::WEBVIEW_USER_AGENT)
            .initialization_script(&anti_detection_js)
            // 提前注入拦截脚本，确保在页面 JS 执行前就绪，不漏掉初始网络请求
            .initialization_script(&intercept)
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
        show_on_cf,
        // CF 通过后移到屏幕外但保持渲染，确保继续抓取高清视频流
        true,
    );
    let cf_probe_js = webview_support::build_cf_probe_script(&cf_event_name);

    // CF 探测脚本 + 拦截脚本合并为一次 eval，确保先检测 CF 再决定是否注入拦截器。
    // intercept 已替换 __VIDEO_FINDER_SITE__ 占位符，CF 页面上不会修改浏览器 API。
    let combined_js = format!("{}\n{}", cf_probe_js, intercept);

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
                // CF 验证通过后：恢复真实视口尺寸并移到屏幕外保持渲染，再导航回目标页恢复抓流。
                // 与 listen_cf_visibility 调用同一幂等辅助函数，避免两个监听器竞态。
                webview_support::show_window_offscreen(&window_for_listener);
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
            if app_clone.get_webview_window(&label).is_none() {
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

        // 注入循环结束（用户手动关闭窗口 / 达到最大运行时长 / 找到后被关闭）通知前端，
        // 让前端立即结算该源并推进下一个，不必干等前端超时。已 found 的源前端按 DONE 去重忽略。
        let _ = app_clone.emit(
            "video-finder-page-state",
            serde_json::json!({ "site": &site_id_owned, "state": "closed" }),
        );

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

/// 关闭指定 site 的视频查找 WebView 窗口
pub fn close_video_finder_webview(app: &AppHandle, site_id: &str) -> Result<(), String> {
    log::info!("[video_finder] event=close_requested site={}", site_id);
    webview_support::emit_cf_state(app, VIDEO_FINDER_CF_STATE_EVENT, "idle", Some(site_id.to_string()), 0);
    if let Some(window) = app.get_webview_window(&video_finder_label(site_id)) {
        window.close().map_err(|e| format!("关闭窗口失败: {}", e))?;
    }
    Ok(())
}

/// 关闭所有视频查找 WebView 窗口，并按 site 逐个发 idle 状态
pub fn close_all_video_finders(app: &AppHandle) {
    let windows = app.webview_windows();
    for (label, w) in &windows {
        if let Some(site_id) = label.strip_prefix(VIDEO_FINDER_LABEL_PREFIX) {
            webview_support::emit_cf_state(app, VIDEO_FINDER_CF_STATE_EVENT, "idle", Some(site_id.to_string()), 0);
            let _ = w.close();
        }
    }
}

