use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Listener, WebviewWindow};

static WEBVIEW_EVENT_COUNTER: AtomicU64 = AtomicU64::new(1);

pub fn next_event_name(prefix: &str) -> String {
    let id = WEBVIEW_EVENT_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}", prefix, id)
}

pub fn build_cf_probe_script(event_name: &str) -> String {
    format!(
        r#"
            (function() {{
                try {{
                    var cfForm = document.querySelector('.challenge-form') !== null;
                    var cfTurnstile = document.querySelector('.cf-turnstile') !== null
                        || document.querySelector('[id*="turnstile"]') !== null;
                    var cfMoment = document.title === 'Just a moment...'
                        || (document.body
                            && document.body.innerText
                            && document.body.innerText.trim().length < 200
                            && document.body.innerHTML.indexOf('Just a moment') !== -1);
                    var detected = !!(cfForm || cfTurnstile || cfMoment);
                    if (window.__TAURI__ && window.__TAURI__.event) {{
                        window.__TAURI__.event.emit({:?}, detected);
                    }}
                }} catch (e) {{}}
            }})();
        "#,
        event_name
    )
}

pub fn build_html_extract_script(cf_event_name: &str, html_event_name: &str) -> String {
    format!(
        r#"
            (function() {{
                try {{
                    if (document.readyState !== 'complete') return;
                    if (!document.body || document.body.innerHTML.length < 100) return;

                    var cfForm = document.querySelector('.challenge-form') !== null;
                    var cfTurnstile = document.querySelector('.cf-turnstile') !== null
                        || document.querySelector('[id*="turnstile"]') !== null;
                    var cfMoment = document.title === 'Just a moment...'
                        || (document.body.innerText.trim().length < 200
                            && document.body.innerHTML.indexOf('Just a moment') !== -1);
                    var detected = !!(cfForm || cfTurnstile || cfMoment);

                    if (window.__TAURI__ && window.__TAURI__.event) {{
                        window.__TAURI__.event.emit({:?}, detected);
                        if (!detected) {{
                            window.__TAURI__.event.emit(
                                {:?},
                                document.documentElement.outerHTML
                            );
                        }}
                    }}
                }} catch (e) {{}}
            }})();
        "#,
        cf_event_name, html_event_name
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

        let should_emit = {
            let mut guard = match last_state.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            if guard.as_ref() == Some(&challenge_detected) {
                false
            } else {
                *guard = Some(challenge_detected);
                true
            }
        };

        if challenge_detected {
            let _ = window.show();
            let _ = window.set_focus();
        } else if !default_visible {
            let _ = window.hide();
        }

        if should_emit {
            if let Some(frontend_event_name) = &frontend_event_name {
                let _ = app_handle.emit(frontend_event_name, challenge_detected);
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

pub fn emit_cf_state(app: &AppHandle, frontend_event_name: &str, active: bool) {
    let _ = app.emit(frontend_event_name, active);
}
