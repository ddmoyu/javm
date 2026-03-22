use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, WebviewWindow};

use super::cf_detection;

static WEBVIEW_EVENT_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CfStatePayload {
    pub status: &'static str,
    pub active: bool,
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
    event_name: &str,
    default_visible: bool,
    frontend_event_name: Option<&str>,
) -> tauri::EventId {
    let window = window.clone();
    let app_handle = app.clone();
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

        if challenge_detected {
            let _ = window.show();
            let _ = window.set_focus();
        } else if !default_visible {
            let _ = window.hide();
        }

        if let Some(frontend_event_name) = &frontend_event_name {
            match (previous_state, challenge_detected) {
                (Some(true), false) => {
                    emit_cf_state(&app_handle, frontend_event_name, "passed");
                }
                (previous, true) if previous != Some(true) => {
                    emit_cf_state(&app_handle, frontend_event_name, "active");
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

pub fn emit_cf_state(app: &AppHandle, frontend_event_name: &str, status: &'static str) {
    let payload = CfStatePayload {
        status,
        active: status == "active",
    };
    let _ = app.emit(frontend_event_name, payload);
}
