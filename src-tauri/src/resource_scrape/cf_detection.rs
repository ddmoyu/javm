use serde_json::json;

/// 硬标记：仅在真实 CF 验证页出现的元素/脚本/属性，任一命中即判定。
/// 注意：不要把 CF 品牌文案（如 "performance and security by cloudflare"）放在这里，
/// 它们出现在所有经 CF 代理的正常页面上，会导致极高误判。
const HARD_MARKERS: &[&str] = &[
    "challenge-form",
    "cf-browser-verification",
    "cf-chl-widget",
    "_cf_chl_opt",
    "challenge-success-text",
    "包含 cloudflare 安全质询的小组件",
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
];

const AUX_MARKERS: &[&str] = &[
    "cloudflare",
    "ray id:",
];

const WIDGET_MARKERS: &[&str] = &[
    "cf-turnstile",
    "cf-turnstile-response",
    "challenges.cloudflare.com",
    "cdn-cgi/challenge-platform",
    "turnstile",
];

/// 可见文字长度上限：超过此值的页面视为正常内容页，
/// 不再使用弱信号（标题 + 软/辅助标记）判定为 CF 验证。
/// 真正的 CF 验证页可见文字极少，通常不超过几百字符。
const MAX_VISIBLE_TEXT_FOR_WEAK_RULES: usize = 1500;

pub fn is_cloudflare_challenge_html(html: &str) -> bool {
    let lower_html = html.to_lowercase();

    // 规则 1：硬标记 — 任一命中即判定（仅含验证页特有标识）
    if HARD_MARKERS
        .iter()
        .any(|marker| lower_html.contains(&marker.to_lowercase()))
    {
        return true;
    }

    // 规则 2：弱信号需要页面内容稀薄才生效，避免对正常内容页误判。
    // 真正的 CF 验证页几乎没有可见文字，而正常页面往往有大量内容。
    let visible_len = estimate_visible_text_length(&lower_html);
    if visible_len > MAX_VISIBLE_TEXT_FOR_WEAK_RULES {
        return false;
    }

    let title = extract_title(&lower_html);
    let title_matched = TITLE_MARKERS
        .iter()
        .any(|marker| title.contains(&marker.to_lowercase()));

    let soft_hits = SOFT_MARKERS
        .iter()
        .filter(|marker| lower_html.contains(&marker.to_lowercase()))
        .count();

    let aux_hits = AUX_MARKERS
        .iter()
        .filter(|marker| lower_html.contains(&marker.to_lowercase()))
        .count();

    let widget_hits = WIDGET_MARKERS
        .iter()
        .filter(|marker| lower_html.contains(&marker.to_lowercase()))
        .count();

    (title_matched && (soft_hits >= 1 || aux_hits >= 1))
        || (soft_hits >= 2 && aux_hits >= 1)
        || (widget_hits >= 1 && soft_hits >= 1)
}

pub fn build_cloudflare_detection_function() -> String {
    let hard_markers = json!(HARD_MARKERS).to_string();
    let title_markers = json!(TITLE_MARKERS).to_string();
    let soft_markers = json!(SOFT_MARKERS).to_string();
    let aux_markers = json!(AUX_MARKERS).to_string();

    format!(
        r#"
            function __javmDetectCloudflareChallenge() {{
                // 1. DOM 检测：仅将明确的挑战页结构视为硬命中。
                var hardDomMatched = document.querySelector('.challenge-form') !== null
                    || document.querySelector('.cf-browser-verification') !== null;
                if (hardDomMatched) return true;

                var widgetDetected = document.querySelector('.cf-turnstile') !== null
                    || document.querySelector('[id*="turnstile"]') !== null
                    || document.querySelector('input[name="cf-turnstile-response"]') !== null
                    || document.querySelector('iframe[title*="Cloudflare"]') !== null
                    || document.querySelector('iframe[title*="cloudflare"]') !== null
                    || document.querySelector('iframe[src*="challenges.cloudflare.com"]') !== null;

                var html = document.documentElement ? document.documentElement.outerHTML : '';
                var lowerHtml = html.toLowerCase();
                var titleText = (document.title || '').trim().toLowerCase();
                var bodyText = document.body && document.body.innerText
                    ? document.body.innerText.trim()
                    : '';

                // 2. 硬标记检测 — 任一命中即判定
                var hardMarkers = {hard_markers};
                for (var i = 0; i < hardMarkers.length; i++) {{
                    if (lowerHtml.indexOf(String(hardMarkers[i]).toLowerCase()) !== -1) {{
                        return true;
                    }}
                }}

                // 3. 页面内容丰富时（可见文字 > 1500 字符），跳过弱信号检测。
                //    真正的 CF 验证页可见文字极少；内容丰富的页面即使包含
                //    CF 品牌文案或 Ray ID 也不应被判定为验证页。
                if (bodyText.length > {max_visible_text}) return false;

                var lowerBodyText = bodyText.toLowerCase();

                // 4. 标题 + 软/辅助标记组合
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
                    if (lowerHtml.indexOf(marker) !== -1 || lowerBodyText.indexOf(marker) !== -1) {{
                        softHits += 1;
                    }}
                }}

                var auxMarkers = {aux_markers};
                var auxHits = 0;
                for (var m = 0; m < auxMarkers.length; m++) {{
                    var auxMarker = String(auxMarkers[m]).toLowerCase();
                    if (lowerHtml.indexOf(auxMarker) !== -1 || lowerBodyText.indexOf(auxMarker) !== -1) {{
                        auxHits += 1;
                    }}
                }}

                return (titleMatched && (softHits >= 1 || auxHits >= 1))
                    || (softHits >= 2 && auxHits >= 1)
                    || (widgetDetected && softHits >= 1);
            }}
        "#,
        hard_markers = hard_markers,
        title_markers = title_markers,
        soft_markers = soft_markers,
        aux_markers = aux_markers,
        max_visible_text = MAX_VISIBLE_TEXT_FOR_WEAK_RULES,
    )
}

/// 估算 HTML body 中可见文字的长度（去除标签、脚本、样式后的非空白字符数）。
/// 用于区分 CF 验证页（内容极少）和正常内容页（内容丰富）。
fn estimate_visible_text_length(html_lower: &str) -> usize {
    let Some(body_pos) = html_lower.find("<body") else {
        return 0;
    };
    let Some(gt_offset) = html_lower[body_pos..].find('>') else {
        return 0;
    };
    let content_start = body_pos + gt_offset + 1;
    let content_end = html_lower[content_start..]
        .find("</body>")
        .map(|off| content_start + off)
        .unwrap_or(html_lower.len());

    let body = &html_lower[content_start..content_end];

    // 移除 <script>...</script> 和 <style>...</style> 块
    let mut cleaned = body.to_string();
    for tag in &["script", "style"] {
        let open = format!("<{}", tag);
        let close = format!("</{}>", tag);
        loop {
            let Some(start) = cleaned.find(&open) else {
                break;
            };
            let Some(end_offset) = cleaned[start..].find(&close) else {
                break;
            };
            let end = start + end_offset + close.len();
            cleaned.replace_range(start..end, "");
        }
    }

    // 去除 HTML 标签，统计非空白字符
    let mut count = 0;
    let mut in_tag = false;
    for ch in cleaned.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag && !ch.is_whitespace() => count += 1,
            _ => {}
        }
    }
    count
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

    #[test]
    fn does_not_flag_page_with_only_cloudflare_branding_and_ray_id() {
        let html = r#"
        <html>
            <head><title>JAVSB - SSIS-392</title></head>
            <body>
                <div>Powered by Cloudflare</div>
                <footer>Ray ID: <code>9e061a97ac61fd31</code></footer>
                <article>SSIS-392 正常页面内容</article>
            </body>
        </html>
        "#;

        assert!(!is_cloudflare_challenge_html(html));
    }

    /// 此前最大的误判来源：正常页面页脚含 "Performance and security by Cloudflare"
    /// 被硬标记直接命中。现已移除此品牌文案，不应再误判。
    #[test]
    fn does_not_flag_normal_page_with_cf_footer_branding() {
        let html = r#"
        <html>
            <head><title>SSIS-392 详情 - JavDB</title></head>
            <body>
                <div id="content">
                    <h1>SSIS-392</h1>
                    <div class="info">演员信息、标签、评分等大量正常内容...</div>
                    <div class="comments">用户评论区域</div>
                </div>
                <footer>
                    <span>Performance and security by Cloudflare</span>
                    <span>Ray ID: 9e061a97ac61fd31</span>
                    <a rel="noopener noreferrer" href="https://www.cloudflare.com">Cloudflare</a>
                </footer>
            </body>
        </html>
        "#;

        assert!(!is_cloudflare_challenge_html(html));
    }

    /// 内容丰富的页面即使标题含"请稍候"也不应被判定为 CF 验证页。
    #[test]
    fn does_not_flag_content_rich_page_with_cf_title_marker() {
        // 生成一个可见文字远超阈值的页面
        let long_content = "这是正常页面内容。".repeat(300);
        let html = format!(
            r#"
            <html>
                <head><title>请稍候 - 加载中</title></head>
                <body>
                    <div>{}</div>
                    <footer>Cloudflare Ray ID: abc123</footer>
                </body>
            </html>
            "#,
            long_content
        );

        assert!(!is_cloudflare_challenge_html(&html));
    }

    /// 真正的 CF 验证页（内容稀薄 + 标题标记 + 辅助标记）应当被检出。
    #[test]
    fn detects_minimal_challenge_page_with_title_and_aux() {
        let html = r#"
        <html>
            <head><title>Just a moment...</title></head>
            <body>
                <p>Checking your browser before accessing the site.</p>
                <p>This process is automatic. Powered by Cloudflare.</p>
            </body>
        </html>
        "#;

        assert!(is_cloudflare_challenge_html(html));
    }

    #[test]
    fn does_not_flag_normal_page_with_turnstile_widget_only() {
        let long_content = "正常详情页内容".repeat(200);
        let html = format!(
            r#"
            <html>
                <head><title>FSDSS-496 - 正常详情页</title></head>
                <body>
                    <article>{}</article>
                    <form id="comment-form">
                        <div class="cf-turnstile"></div>
                        <input type="hidden" name="cf-turnstile-response" />
                    </form>
                </body>
            </html>
            "#,
            long_content
        );

        assert!(!is_cloudflare_challenge_html(&html));
    }

    #[test]
    fn does_not_flag_sparse_page_with_widget_without_challenge_copy() {
        let html = r#"
        <html>
            <head><title>Redirecting...</title></head>
            <body>
                <iframe title="Cloudflare" src="https://challenges.cloudflare.com/widget"></iframe>
            </body>
        </html>
        "#;

        assert!(!is_cloudflare_challenge_html(html));
    }

    #[test]
    fn does_not_flag_page_with_challenge_platform_script_only() {
        let html = r#"
        <html>
            <head>
                <script defer src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>
            </head>
            <body>
                <h1>ProjectJav - High Speed Jav Torrent</h1>
                <p>正常搜索结果页面</p>
            </body>
        </html>
        "#;

        assert!(!is_cloudflare_challenge_html(html));
    }

    #[test]
    fn estimate_visible_text_strips_scripts_and_tags() {
        let html = r#"
        <html>
            <head><title>Test</title></head>
            <body>
                <script>var x = 'should be ignored';</script>
                <style>.foo { color: red; }</style>
                <p>Hello World</p>
            </body>
        </html>
        "#;
        let len = estimate_visible_text_length(&html.to_lowercase());
        // "HelloWorld" = 10 chars (no whitespace counted)
        assert_eq!(len, 10);
    }
}