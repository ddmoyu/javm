// 0.5.3 的原版更新插件；不含旧业务、WebView、媒体、真实数据库或网络来源。
use std::{fs, path::PathBuf, time::Duration};
use tauri_plugin_updater::UpdaterExt;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config: serde_json::Value = serde_json::from_slice(&fs::read(
        std::env::args_os().nth(1).expect("fixture configuration required"),
    )?)?;
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.package_info_mut().version = "0.5.3".parse()?;
    context.package_info_mut().name = "javm".into();
    context.config_mut().identifier = "com.ddmoyu.javm.updatefixture".into();
    context.config_mut().plugins.0.insert("updater".into(), serde_json::json!({
        "pubkey": config["publicKey"],
        "endpoints": [config["endpoint"]],
        "dangerousInsecureTransportProtocol": true,
        "windows": {"installMode": "passive"}
    }));
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)?;
    let updater = app.updater_builder()
        .executable_path(PathBuf::from(config["entry"].as_str().unwrap()))
        .installer_args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"])
        .no_proxy().timeout(Duration::from_secs(90)).build()?;
    tauri::async_runtime::block_on(async {
        let update = updater.check().await?.ok_or("no legacy update found")?;
        let bytes = update.download(|_, _| {}, || {}).await;
        if config["reject"].as_bool() == Some(true) {
            if bytes.is_ok() { return Err("tampered package was accepted".into()); }
            fs::write(config["proof"].as_str().unwrap(), "{\"rejected\":true}")?;
            return Ok(());
        }
        let bytes = bytes?;
        fs::write(config["proof"].as_str().unwrap(), serde_json::to_vec(&serde_json::json!({
            "oldVersion":"0.5.3", "updater":"2.10.1", "tauri":"2.11.2",
            "newVersion":update.version, "verifiedBytes":bytes.len()
        }))?)?;
        update.install(bytes)?;
        Ok::<(), Box<dyn std::error::Error>>(())
    })
}
