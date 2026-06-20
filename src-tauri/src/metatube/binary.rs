//! MetaTube sidecar 二进制定位
//!
//! 二进制随 GitHub Actions 构建按平台打包进 `src-tauri/bin/`（`bundle.resources: ["bin/*"]`），
//! 运行时按多候选路径解析。**务必用 `is_file()`**：FFmpeg sidecar 曾因 `exists()` 在 arm64
//! 误选同名目录而失败（见 commit 584b3c1）。

use std::path::{Path, PathBuf};

/// sidecar 可执行文件名（统一固定名，GHA 下载后重命名为此）
#[cfg(windows)]
pub const BINARY_NAME: &str = "metatube-server.exe";
#[cfg(not(windows))]
pub const BINARY_NAME: &str = "metatube-server";

/// 解析 metatube-server 可执行文件路径。
///
/// 候选顺序：**`managed_dir`（应用数据 `bin/`，可写、供运行时下载落地）** → exe 同级目录 →
/// exe 同级 `bin/` → 开发期 `target/{debug,release}/bin` → `src-tauri/bin`。
/// 全部用 `is_file()` 校验，避免误选同名目录。找不到返回 `None`（上层据此判定 sidecar 不可用 → 回退）。
pub fn resolve_binary_path(managed_dir: Option<&Path>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // 运行时下载落地目录优先（应用数据目录，跨 debug/release 均可写）
    if let Some(dir) = managed_dir {
        candidates.push(dir.join(BINARY_NAME));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(BINARY_NAME));
            candidates.push(dir.join("bin").join(BINARY_NAME));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        for profile in ["debug", "release"] {
            candidates.push(
                cwd.join("src-tauri")
                    .join("target")
                    .join(profile)
                    .join("bin")
                    .join(BINARY_NAME),
            );
        }
        candidates.push(cwd.join("src-tauri").join("bin").join(BINARY_NAME));
    }

    // 用 is_file() 避免误选同名目录；并要求非空，过滤零字节/截断的损坏二进制
    //（中断写入留下的空文件会被忽略，从而 binary_present=false → UI 可重新下载）。
    candidates.into_iter().find(|candidate| is_valid_binary(candidate))
}

fn is_valid_binary(path: &Path) -> bool {
    path.is_file()
        && std::fs::metadata(path)
            .map(|m| m.len() > 0)
            .unwrap_or(false)
}
