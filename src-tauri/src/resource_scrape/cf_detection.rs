use serde_json::json;

const HARD_MARKERS: &[&str] = &[
    "challenge-form",
    "cf-browser-verification",
    "cf-turnstile",
    "cf-turnstile-response",
    "cf-chl-widget",
    "_cf_chl_opt",
    "challenge-platform",
    "challenges.cloudflare.com",
    "cdn-cgi/challenge-platform",
    "challenge-success-text",
    "包含 cloudflare 安全质询的小组件",
    "performance and security by cloudflare",
    "由 <a rel=\"noopener noreferrer\" href=\"https://www.cloudflare.com",
    "由 cloudflare 提供的性能和安全服务",
];

const TITLE_MARKERS: &[&str] = &[
    "just a moment",
    "请稍候",
    "請稍候",
    "执行安全验证",
    "執行安全驗證",
    "安全验证",
    "安全驗證",
    "verify you are human",
    "checking your browser",
];

const SOFT_MARKERS: &[&str] = &[
    "verify you are human",
    "checking your browser before accessing",
    "enable javascript and cookies to continue",
    "security check to access",
    "this website is using a security service to protect itself from online attacks",
    "此网站使用安全服务来防范恶意自动程序",
    "此網站使用安全服務來防範惡意自動程式",
    "当网站验证您不是自动程序时，会显示此页面",
    "當網站驗證您不是自動程式時，會顯示此頁面",
    "cloudflare",
    "ray id:",
];

pub fn is_cloudflare_challenge_html(html: &str) -> bool {
    let lower_html = html.to_lowercase();

    if HARD_MARKERS.iter().any(|marker| lower_html.contains(&marker.to_lowercase())) {
        return true;
    }

    let title = extract_title(&lower_html);
    let title_matched = TITLE_MARKERS
        .iter()
        .any(|marker| title.contains(&marker.to_lowercase()));

    let soft_hits = SOFT_MARKERS
        .iter()
        .filter(|marker| lower_html.contains(&marker.to_lowercase()))
        .count();

    (title_matched && (soft_hits >= 1 || lower_html.contains("cloudflare"))) || soft_hits >= 2
}

pub fn build_cloudflare_detection_function() -> String {
    let hard_markers = json!(HARD_MARKERS).to_string();
    let title_markers = json!(TITLE_MARKERS).to_string();
    let soft_markers = json!(SOFT_MARKERS).to_string();

    format!(
        r#"
            function __javmDetectCloudflareChallenge() {{
                var html = document.documentElement ? document.documentElement.outerHTML : '';
                var lowerHtml = html.toLowerCase();
                var titleText = (document.title || '').trim().toLowerCase();
                var bodyText = document.body && document.body.innerText
                    ? document.body.innerText.trim().toLowerCase()
                    : '';

                var domMatched = document.querySelector('.challenge-form') !== null
                    || document.querySelector('.cf-turnstile') !== null
                    || document.querySelector('[id*="turnstile"]') !== null
                    || document.querySelector('input[name="cf-turnstile-response"]') !== null
                    || document.querySelector('iframe[title*="Cloudflare"]') !== null
                    || document.querySelector('iframe[title*="cloudflare"]') !== null;
                if (domMatched) return true;

                var hardMarkers = {hard_markers};
                for (var i = 0; i < hardMarkers.length; i++) {{
                    if (lowerHtml.indexOf(String(hardMarkers[i]).toLowerCase()) !== -1) {{
                        return true;
                    }}
                }}

                var titleMarkers = {title_markers};
                var titleMatched = false;
                for (var j = 0; j < titleMarkers.length; j++) {{
                    if (titleText.indexOf(String(titleMarkers[j]).toLowerCase()) !== -1) {{
                        titleMatched = true;
                        break;
                    }}
                }}

                var softMarkers = {soft_markers};
                var softHits = 0;
                for (var k = 0; k < softMarkers.length; k++) {{
                    var marker = String(softMarkers[k]).toLowerCase();
                    if (lowerHtml.indexOf(marker) !== -1 || bodyText.indexOf(marker) !== -1) {{
                        softHits += 1;
                    }}
                }}

                return (titleMatched && (softHits >= 1 || lowerHtml.indexOf('cloudflare') !== -1)) || softHits >= 2;
            }}
        "#,
        hard_markers = hard_markers,
        title_markers = title_markers,
        soft_markers = soft_markers,
    )
}

fn extract_title(html_lower: &str) -> String {
    let Some(start) = html_lower.find("<title") else {
        return String::new();
    };
    let Some(after_start) = html_lower[start..].find('>') else {
        return String::new();
    };
    let content_start = start + after_start + 1;
    let Some(end_offset) = html_lower[content_start..].find("</title>") else {
        return String::new();
    };
    html_lower[content_start..content_start + end_offset]
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_localized_cloudflare_challenge_page() {
        let html = r#"
        <html>
            <head><title>请稍候…</title></head>
            <body>
                <h2>执行安全验证</h2>
                <p>此网站使用安全服务来防范恶意自动程序。</p>
                <input type="hidden" name="cf-turnstile-response" />
                <script>window._cf_chl_opt = {{ cZone: 'www.javlibrary.com' }};</script>
                <div>Ray ID: <code>9e061a97ac61fd31</code></div>
            </body>
        </html>
        "#;

        assert!(is_cloudflare_challenge_html(html));
    }

    #[test]
    fn does_not_flag_normal_detail_page() {
        let html = r#"
        <html>
            <head><title>SSIS-392 JAVLibrary</title></head>
            <body>
                <div id="video_title">SSIS-392 正常详情页</div>
                <div id="video_id">SSIS-392</div>
            </body>
        </html>
        "#;

        assert!(!is_cloudflare_challenge_html(html));
    }
}