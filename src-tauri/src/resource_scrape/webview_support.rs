use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Manager, WebviewWindow};

use super::cf_detection;

static WEBVIEW_EVENT_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CfStatePayload {
    pub status: &'static str,
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_id: Option<String>,
    pub active_count: usize,
}

pub fn next_event_name(prefix: &str) -> String {
    let id = WEBVIEW_EVENT_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}", prefix, id)
}

pub fn build_cf_probe_script(event_name: &str) -> String {
    let detector = cf_detection::build_cloudflare_detection_function();
    format!(
        r#"
            (function() {{
                try {{
                    {detector}
                    var detected = __javmDetectCloudflareChallenge();
                    window.__CF_CHALLENGE_ACTIVE__ = detected;
                    if (window.__TAURI__ && window.__TAURI__.event) {{
                        window.__TAURI__.event.emit({:?}, detected);
                    }}
                }} catch (e) {{}}
            }})();
        "#,
        event_name,
        detector = detector,
    )
}

pub fn build_html_extract_script(cf_event_name: &str, html_event_name: &str) -> String {
    let detector = cf_detection::build_cloudflare_detection_function();
    format!(
        r#"
            (function() {{
                try {{
                    if (document.readyState !== 'complete') return;
                    if (!document.body || document.body.innerHTML.length < 100) return;

                    {detector}
                    var html = document.documentElement ? document.documentElement.outerHTML : '';
                    var detected = __javmDetectCloudflareChallenge();

                    if (window.__TAURI__ && window.__TAURI__.event) {{
                        window.__TAURI__.event.emit({:?}, detected);
                        if (!detected) {{
                            window.__TAURI__.event.emit(
                                {:?},
                                html
                            );
                        }}
                    }}
                }} catch (e) {{}}
            }})();
        "#,
        cf_event_name, html_event_name,
        detector = detector,
    )
}

pub fn listen_cf_visibility(
    app: &AppHandle,
    window: &WebviewWindow,
    site: &super::sources::ResourceSite,
    event_name: &str,
    frontend_event_name: Option<&str>,
    // 遇到 CF 时是否弹出窗口让用户验证；关闭时即使检测到 CF 也保持隐藏
    show_on_cf: bool,
) -> tauri::EventId {
    let window = (*window).clone();
    let app_handle = app.clone();
    let site_id = site.id.clone();
    let frontend_event_name = frontend_event_name.map(str::to_string);
    let last_state = Arc::new(Mutex::new(None::<bool>));
    app.listen(event_name.to_string(), move |event| {
        let Ok(challenge_detected) = serde_json::from_str::<bool>(event.payload()) else {
            return;
        };

        let previous_state = {
            let mut guard = match last_state.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            let previous = *guard;
            if previous != Some(challenge_detected) {
                *guard = Some(challenge_detected);
            }
            previous
        };

        if let Some(frontend_event_name) = &frontend_event_name {
            let snapshot = app_handle
                .state::<super::fetcher::WebviewPoolState>()
                .update_cf_state(window.label(), challenge_detected);
            match (previous_state, challenge_detected) {
                (Some(true), false) => {
                    // CF 验证通过后自动隐藏 WebView 窗口
                    sync_window_visibility(&window, false);
                    emit_cf_state(
                        &app_handle,
                        frontend_event_name,
                        "passed",
                        snapshot.site_id.or_else(|| Some(site_id.clone())),
                        snapshot.active_count,
                    );
                }
                (previous, true) if previous != Some(true) => {
                    // CF 验证触发时显示 WebView 窗口（用户关闭"弹窗验证"开关时保持隐藏）
                    if show_on_cf {
                        sync_window_visibility(&window, true);
                    }
                    emit_cf_state(
                        &app_handle,
                        frontend_event_name,
                        "active",
                        snapshot.site_id.or_else(|| Some(site_id.clone())),
                        snapshot.active_count,
                    );
                }
                _ => {}
            }
        }
    })
}

pub fn sync_window_visibility(window: &WebviewWindow, visible: bool) {
    if visible {
        let _ = window.show();
    } else {
        let _ = window.hide();
    }
}

pub fn emit_cf_state(
    app: &AppHandle,
    frontend_event_name: &str,
    status: &'static str,
    site_id: Option<String>,
    active_count: usize,
) {
    let payload = CfStatePayload {
        status,
        active: active_count > 0,
        site_id,
        active_count,
    };
    let _ = app.emit(frontend_event_name, payload);
}

/// WebView 使用的 User-Agent，版本号需与 HTTP 客户端保持一致
pub const WEBVIEW_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

/// WebView2 额外启动参数，禁用自动化检测相关特征
#[cfg(target_os = "windows")]
pub const WEBVIEW_BROWSER_ARGS: &str =
    "--disable-blink-features=AutomationControlled --disable-features=msWebView2BrowserHitTransparent,CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-background-timer-throttling";

/// 构建反自动化检测的初始化脚本，在页面 JS 执行前注入
pub fn build_anti_detection_script() -> String {
    r#"
        (function() {
            'use strict';

            var navProto = Object.getPrototypeOf(navigator);

            function defineGetter(target, key, getter) {
                try {
                    Object.defineProperty(target, key, {
                        get: getter,
                        configurable: true,
                    });
                } catch (e) {}
            }

            function patchGetter(target, key, getter) {
                if (!target) return;
                defineGetter(target, key, getter);
            }

            function makeNativeLike(fn, name) {
                try {
                    Object.defineProperty(fn, 'name', { value: name, configurable: true });
                } catch (e) {}
                try {
                    Object.defineProperty(fn, 'toString', {
                        value: function() { return 'function ' + name + '() { [native code] }'; },
                        configurable: true,
                    });
                } catch (e) {}
                return fn;
            }

            function createMimeType(type, suffixes, description, enabledPlugin) {
                return {
                    type: type,
                    suffixes: suffixes,
                    description: description,
                    enabledPlugin: enabledPlugin,
                };
            }

            function attachIndexedAccess(collection, items, keyField) {
                for (var i = 0; i < items.length; i++) {
                    collection[i] = items[i];
                    if (keyField && items[i] && items[i][keyField]) {
                        collection[items[i][keyField]] = items[i];
                    }
                }
                collection.length = items.length;
                return collection;
            }

            // ── 1. 隐藏 navigator.webdriver ──
            patchGetter(navProto, 'webdriver', function() { return undefined; });
            patchGetter(navigator, 'webdriver', function() { return undefined; });

            // ── 2. 伪造 navigator.userAgentData（Client Hints，CF 重点检测） ──
            if (!navigator.userAgentData || /WebView/i.test(JSON.stringify(navigator.userAgentData.brands || []))) {
                var fakeUAData = {
                    brands: [
                        { brand: 'Chromium', version: '134' },
                        { brand: 'Google Chrome', version: '134' },
                        { brand: 'Not:A-Brand', version: '24' }
                    ],
                    mobile: false,
                    platform: 'Windows',
                    getHighEntropyValues: function(hints) {
                        return Promise.resolve({
                            brands: this.brands,
                            mobile: false,
                            platform: 'Windows',
                            platformVersion: '15.0.0',
                            architecture: 'x86',
                            bitness: '64',
                            model: '',
                            uaFullVersion: '134.0.6998.89',
                            fullVersionList: this.brands
                        });
                    }
                };
                Object.defineProperty(navigator, 'userAgentData', {
                    get: function() { return fakeUAData; },
                    configurable: true,
                });
            }

            // ── 3. 伪造 navigator.plugins（需要模拟 PluginArray 接口） ──
            if (navigator.plugins.length === 0) {
                var fakePlugins = [
                    { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                    { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                    { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }
                ];
                var fakeMimeTypes = [
                    createMimeType('application/pdf', 'pdf', 'Portable Document Format', fakePlugins[0]),
                    createMimeType('text/pdf', 'pdf', 'Portable Document Format', fakePlugins[1])
                ];

                for (var pluginIndex = 0; pluginIndex < fakePlugins.length; pluginIndex++) {
                    fakePlugins[pluginIndex].length = fakeMimeTypes.length;
                    for (var mimeIndex = 0; mimeIndex < fakeMimeTypes.length; mimeIndex++) {
                        fakePlugins[pluginIndex][mimeIndex] = fakeMimeTypes[mimeIndex];
                    }
                }

                var pluginArray = attachIndexedAccess([], fakePlugins, 'name');
                pluginArray.item = makeNativeLike(function(i) { return this[i] || null; }, 'item');
                pluginArray.namedItem = makeNativeLike(function(n) {
                    return this[n] || null;
                }, 'namedItem');
                pluginArray.refresh = makeNativeLike(function() {}, 'refresh');

                var mimeTypeArray = attachIndexedAccess([], fakeMimeTypes, 'type');
                mimeTypeArray.item = makeNativeLike(function(i) { return this[i] || null; }, 'item');
                mimeTypeArray.namedItem = makeNativeLike(function(n) {
                    return this[n] || null;
                }, 'namedItem');

                patchGetter(navProto, 'plugins', function() { return pluginArray; });
                Object.defineProperty(navigator, 'plugins', {
                    get: function() { return pluginArray; },
                    configurable: true,
                });
                patchGetter(navProto, 'mimeTypes', function() { return mimeTypeArray; });
                Object.defineProperty(navigator, 'mimeTypes', {
                    get: function() { return mimeTypeArray; },
                    configurable: true,
                });
            }

            // ── 4. 修正常见 Navigator 指纹 ──
            patchGetter(navProto, 'platform', function() { return 'Win32'; });
            patchGetter(navigator, 'platform', function() { return 'Win32'; });
            patchGetter(navProto, 'vendor', function() { return 'Google Inc.'; });
            patchGetter(navigator, 'vendor', function() { return 'Google Inc.'; });
            patchGetter(navProto, 'hardwareConcurrency', function() { return 8; });
            patchGetter(navigator, 'hardwareConcurrency', function() { return 8; });
            patchGetter(navProto, 'deviceMemory', function() { return 8; });
            patchGetter(navigator, 'deviceMemory', function() { return 8; });
            patchGetter(navProto, 'maxTouchPoints', function() { return 0; });
            patchGetter(navigator, 'maxTouchPoints', function() { return 0; });

            // ── 5. 确保 navigator.languages 正常 ──
            if (!navigator.languages || navigator.languages.length === 0) {
                patchGetter(navProto, 'languages', function() { return ['zh-CN', 'zh', 'en-US', 'en']; });
                Object.defineProperty(navigator, 'languages', {
                    get: function() { return ['zh-CN', 'zh', 'en-US', 'en']; },
                    configurable: true,
                });
            }

            // ── 6. 伪造 Notification 权限（WebView 通常缺失） ──
            if (typeof Notification === 'undefined') {
                window.Notification = function() {};
                window.Notification.permission = 'default';
                window.Notification.requestPermission = function() { return Promise.resolve('default'); };
            }

            // ── 7. 伪造 window.chrome 与子对象 ──
            if (!window.chrome) window.chrome = {};
            if (!window.chrome.runtime) {
                window.chrome.runtime = {
                    connect: makeNativeLike(function() {
                        return {
                            onMessage: { addListener: function() {} },
                            onDisconnect: { addListener: function() {} },
                            postMessage: function() {},
                            disconnect: function() {}
                        };
                    }, 'connect'),
                    sendMessage: makeNativeLike(function() {}, 'sendMessage'),
                    id: undefined
                };
            }
            if (!window.chrome.app) {
                window.chrome.app = {
                    isInstalled: false,
                    InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
                    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
                    getDetails: makeNativeLike(function() { return null; }, 'getDetails'),
                    getIsInstalled: makeNativeLike(function() { return false; }, 'getIsInstalled')
                };
            }
            if (!window.chrome.csi) {
                window.chrome.csi = makeNativeLike(function() {
                    return {
                        onloadT: Date.now(),
                        startE: Date.now() - 100,
                        pageT: Math.max(1, Math.round(performance.now())),
                        tran: 15
                    };
                }, 'csi');
            }
            if (!window.chrome.loadTimes) {
                window.chrome.loadTimes = makeNativeLike(function() {
                    return {
                        commitLoadTime: Date.now() / 1000,
                        connectionInfo: 'http/1.1',
                        finishDocumentLoadTime: Date.now() / 1000,
                        finishLoadTime: Date.now() / 1000,
                        firstPaintAfterLoadTime: 0,
                        firstPaintTime: Date.now() / 1000,
                        navigationType: 'Other',
                        npnNegotiatedProtocol: 'http/1.1',
                        requestTime: Date.now() / 1000,
                        startLoadTime: Date.now() / 1000,
                        wasAlternateProtocolAvailable: false,
                        wasFetchedViaSpdy: false,
                        wasNpnNegotiated: false
                    };
                }, 'loadTimes');
            }

            // ── 8. 移除 Chromium DevTools 协议残留属性 ──
            var cdcKeys = Object.getOwnPropertyNames(window).filter(function(k) {
                return /^cdc_/i.test(k) || /^\$cdc_/i.test(k);
            });
            cdcKeys.forEach(function(k) { try { delete window[k]; } catch(e) {} });

            // ── 9. 视口/屏幕尺寸：统一上报 ≥1920×1080 ──
            // 目的有二：①隐藏窗口可能 0×0 被 CF 检测；②很多视频站按 window.innerWidth/
            // screen.width 决定提供的最高清晰度，小屏/小窗口会被限制到 720p。这里把窗口与
            // 屏幕尺寸都"垫高"到至少 1080p（只升不降），让站点提供 1080p 变体。
            (function() {
                var TW = 1920, TH = 1080;
                function bump(obj, prop, target) {
                    try {
                        var cur = obj[prop] || 0;
                        if (cur < target) {
                            Object.defineProperty(obj, prop, { get: function() { return target; }, configurable: true });
                        }
                    } catch (e) {}
                }
                bump(window, 'innerWidth', TW);
                bump(window, 'innerHeight', TH);
                bump(window, 'outerWidth', TW);
                bump(window, 'outerHeight', TH);
                if (window.screen) {
                    bump(window.screen, 'width', TW);
                    bump(window.screen, 'height', TH);
                    bump(window.screen, 'availWidth', TW);
                    bump(window.screen, 'availHeight', TH);
                }
            })();

            // ── 10. 修正 permissions API 行为（更接近真实浏览器） ──
            if (navigator.permissions) {
                var origQuery = navigator.permissions.query.bind(navigator.permissions);
                navigator.permissions.query = makeNativeLike(function(desc) {
                    if (desc && desc.name === 'notifications') {
                        return Promise.resolve({ state: 'prompt', onchange: null });
                    }
                    if (desc && (desc.name === 'camera' || desc.name === 'microphone')) {
                        return Promise.resolve({ state: 'denied', onchange: null });
                    }
                    return origQuery(desc);
                }, 'query');
            }

            // ── 11. 规避权限与自动化 API 的缺省暴露 ──
            if (!window.navigator.connection) {
                Object.defineProperty(navigator, 'connection', {
                    get: function() {
                        return {
                            downlink: 10,
                            effectiveType: '4g',
                            onchange: null,
                            rtt: 50,
                            saveData: false,
                        };
                    },
                    configurable: true,
                });
            }
            if (!window.navigator.pdfViewerEnabled) {
                Object.defineProperty(navigator, 'pdfViewerEnabled', {
                    get: function() { return true; },
                    configurable: true,
                });
            }
        })();
    "#.to_string()
}

#[cfg(test)]
mod tests {
    use super::{build_anti_detection_script, WEBVIEW_BROWSER_ARGS};

    #[test]
    fn anti_detection_script_covers_high_signal_fingerprints() {
        let script = build_anti_detection_script();

        for expected in [
            "navigator.userAgentData",
            "'mimeTypes'",
            "'hardwareConcurrency'",
            "'deviceMemory'",
            "'platform'",
            "'vendor'",
            "window.chrome.loadTimes",
            "window.chrome.csi",
            "'pdfViewerEnabled'",
        ] {
            assert!(script.contains(expected), "脚本缺少关键伪装: {expected}");
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn browser_args_disable_additional_webview2_signals() {
        assert!(WEBVIEW_BROWSER_ARGS.contains("AutomationControlled"));
        assert!(WEBVIEW_BROWSER_ARGS.contains("CalculateNativeWinOcclusion"));
        assert!(WEBVIEW_BROWSER_ARGS.contains("disable-renderer-backgrounding"));
        assert!(WEBVIEW_BROWSER_ARGS.contains("disable-background-timer-throttling"));
    }
}

pub fn persistent_data_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("解析 WebView 数据目录失败: {}", e))?;

    let dir = app_data_dir.join("webview").join("external-profile");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("创建 WebView 数据目录失败: {}", e))?;

    Ok(dir)
}
