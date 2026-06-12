use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

use super::AppSettings;

// ⚠️ 安全提示：这不是真正的加密。下面是「固定密钥 XOR + Base64」，仅做混淆，
// 可被任何拿到 settings.json 或二进制文件的人轻易还原。API Key 的真正保护
// 应使用系统密钥库（如 keyring crate / Windows 凭据管理器）。此处仅为避免
// 明文直观可见，切勿据此认为 Key 是安全的。
const OBFUSCATION_KEY: &[u8] = b"javm_secure_key_2024";

fn xor_cipher(data: &[u8], key: &[u8]) -> Vec<u8> {
    data.iter()
        .enumerate()
        .map(|(i, &byte)| byte ^ key[i % key.len()])
        .collect()
}

/// 混淆 API Key（非加密，仅避免明文直观可见）
pub fn obfuscate_api_key(api_key: &str) -> String {
    let obfuscated = xor_cipher(api_key.as_bytes(), OBFUSCATION_KEY);
    BASE64.encode(obfuscated)
}

/// 还原被混淆的 API Key
pub fn deobfuscate_api_key(value: &str) -> Result<String, String> {
    let decoded = BASE64.decode(value).map_err(|e| e.to_string())?;
    let restored = xor_cipher(&decoded, OBFUSCATION_KEY);
    String::from_utf8(restored).map_err(|e| e.to_string())
}

/// 混淆设置中的所有 API Key（保留 `enc:` 前缀以兼容历史存储）
pub(super) fn obfuscate_settings(settings: &mut AppSettings) {
    for provider in &mut settings.ai.providers {
        if !provider.api_key.is_empty() && !provider.api_key.starts_with("enc:") {
            provider.api_key = format!("enc:{}", obfuscate_api_key(&provider.api_key));
        }
    }
}

/// 还原设置中所有被混淆的 API Key
pub(super) fn deobfuscate_settings(settings: &mut AppSettings) {
    for provider in &mut settings.ai.providers {
        if let Some(value) = provider.api_key.strip_prefix("enc:") {
            if let Ok(restored) = deobfuscate_api_key(value) {
                provider.api_key = restored;
            }
        }
    }
}
