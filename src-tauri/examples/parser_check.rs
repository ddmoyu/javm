//! 临时解析器体检 harness（用完即删，不属于正式构建）。
//!
//! 用法：cargo run --example parser_check [番号]
//!
//! 对每个数据源用真实 wreq 请求（Chrome TLS 指纹）抓取 HTML，
//! 跑 Source::parse，报告各字段解析覆盖率；同时把抓到的 HTML
//! 落盘到 src-tauri/examples/out/，便于对照真实 DOM 更新选择器。

use std::fs;
use std::path::Path;
use std::time::Duration;

use javm_lib::resource_scrape::fingerprint_client;
use javm_lib::resource_scrape::sources::{all_sources};
use javm_lib::resource_scrape::types::SearchResult;
use wreq_util::Emulation;

/// 汇总一个 SearchResult 的字段覆盖情况
fn coverage(r: &SearchResult) -> String {
    let fields: [(&str, bool); 10] = [
        ("title", !r.title.trim().is_empty()),
        ("actors", !r.actors.trim().is_empty()),
        ("cover", !r.cover_url.trim().is_empty()),
        ("premiered", !r.premiered.trim().is_empty()),
        ("studio", !r.studio.trim().is_empty()),
        ("director", !r.director.trim().is_empty()),
        ("duration", !r.duration.trim().is_empty()),
        ("tags", !r.tags.trim().is_empty()),
        ("plot", !r.plot.trim().is_empty()),
        ("thumbs", !r.thumbs.is_empty()),
    ];
    let filled: Vec<&str> = fields.iter().filter(|(_, ok)| *ok).map(|(n, _)| *n).collect();
    let empty: Vec<&str> = fields.iter().filter(|(_, ok)| !*ok).map(|(n, _)| *n).collect();
    format!(
        "字段命中 {}/10  ✓[{}]  ✗[{}]  thumbs={}",
        filled.len(),
        filled.join(","),
        empty.join(","),
        r.thumbs.len()
    )
}

#[tokio::main]
async fn main() {
    let code = std::env::args().nth(1).unwrap_or_else(|| "IPX-291".to_string());
    let out_dir = Path::new("examples/out");
    let _ = fs::create_dir_all(out_dir);

    // 可通过 HARNESS_PROXY 环境变量指定代理（如 http://127.0.0.1:7897）
    let proxy = std::env::var("HARNESS_PROXY").ok().filter(|s| !s.is_empty());
    let mut builder = wreq::Client::builder()
        .emulation(Emulation::Chrome137)
        .timeout(Duration::from_secs(30));
    if let Some(p) = &proxy {
        println!("（使用代理: {p}）");
        builder = builder.proxy(wreq::Proxy::all(p.as_str()).expect("代理地址无效"));
    }
    let client = builder.build().expect("创建 wreq 客户端失败");

    println!("===== 解析器体检  番号={code} =====\n");

    for source in all_sources() {
        let name = source.name().to_string();
        let url = source.build_url(&code);
        println!("[{name}]\n  url: {url}");

        let html = match fingerprint_client::fetch_html(&client, &url).await {
            Ok(h) => h,
            Err(e) => {
                println!("  结果: ❌ 抓取失败 ({e})\n");
                continue;
            }
        };

        // 需要详情页二跳的源
        let parse_html = match source.extract_detail_url(&html, &code) {
            Some(detail_url) => {
                println!("  detail: {detail_url}");
                match fingerprint_client::fetch_html(&client, &detail_url).await {
                    Ok(h) => h,
                    Err(e) => {
                        println!("  详情页抓取失败 ({e})，改用列表页解析");
                        html.clone()
                    }
                }
            }
            None => html.clone(),
        };

        // 落盘抓到的 HTML（供对照更新选择器）
        let safe = name.replace([' ', '/', '\\'], "_");
        let _ = fs::write(out_dir.join(format!("{safe}.html")), &parse_html);

        match source.parse(&parse_html, &code) {
            Some(r) => println!("  结果: ✅ 解析成功  {}", coverage(&r)),
            None => println!("  结果: ⚠️  parse 返回 None（结构可能已变 / 该番号不存在）"),
        }
        println!("  html_len: {}\n", parse_html.len());

        tokio::time::sleep(Duration::from_millis(800)).await;
    }

    println!("抓取的 HTML 已保存到 src-tauri/examples/out/，可据此对照修正选择器。");
}
