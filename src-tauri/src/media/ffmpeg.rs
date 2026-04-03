use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use regex::Regex;
use tauri::Emitter;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

/// 缓存已解析的 ffmpeg 可执行文件路径
static FFMPEG_PATH: OnceLock<OsString> = OnceLock::new();

/// 解析 ffmpeg 可执行文件的完整路径
///
/// 搜索顺序：
/// 1. 系统 PATH（优先使用系统环境中的 ffmpeg）
/// 2. 当前进程所在目录 / bin 子目录
/// 3. 开发模式路径（src-tauri/target/debug|release/bin、src-tauri/bin）
fn resolve_ffmpeg_path() -> OsString {
    #[cfg(windows)]
    let binary_name = "ffmpeg.exe";
    #[cfg(not(windows))]
    let binary_name = "ffmpeg";

    // 优先从系统 PATH 查找
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(binary_name);
            if candidate.exists() {
                return candidate.as_os_str().to_os_string();
            }
        }
    }

    // 系统 PATH 没有，回退到本地 bin 目录
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(binary_name));
            candidates.push(dir.join("bin").join(binary_name));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("target").join("debug").join("bin").join(binary_name));
        candidates.push(cwd.join("src-tauri").join("target").join("release").join("bin").join(binary_name));
        candidates.push(cwd.join("src-tauri").join("bin").join(binary_name));
    }

    for candidate in &candidates {
        if candidate.exists() {
            return candidate.as_os_str().to_os_string();
        }
    }

    // 最终兜底：返回裸名
    OsString::from("ffmpeg")
}

/// 获取 ffmpeg 可执行文件路径（带缓存）
fn ffmpeg_path() -> &'static OsString {
    FFMPEG_PATH.get_or_init(resolve_ffmpeg_path)
}

/// 在 Windows 上隐藏子进程的控制台窗口，避免终端闪烁
#[cfg(windows)]
fn hide_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console_window(_cmd: &mut Command) {}

/// 执行 FFmpeg 命令截取单帧
///
/// # 参数
/// * `video_path` - 视频文件路径
/// * `timestamp` - 截取时间点（秒）
/// * `output_path` - 输出图片路径
///
/// # 返回
/// * `Ok(String)` - 保存的封面图片路径
/// * `Err(String)` - 保存失败的错误信息
pub fn extract_frame(
    video_path: &str,
    timestamp: f64,
    output_path: &str,
) -> Result<String, String> {
    let mut cmd = Command::new(ffmpeg_path());
    cmd.args(&[
        "-v",
        "error",
        "-ss",
        &format!("{:.3}", timestamp),
        "-i",
        video_path,
        "-vframes",
        "1",
        "-q:v",
        "2",
        "-y",
        output_path,
    ]);
    hide_console_window(&mut cmd);

    let output = cmd
        .output()
        .map_err(|e| format!("执行 ffmpeg 失败: {}", e))?;

    if output.status.success() && Path::new(output_path).exists() {
        Ok(output_path.to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("ffmpeg 截图失败: {}", stderr))
    }
}

// ============================================================
// FFmpeg 命令执行与视频帧截取 (从 media_assets 迁移)
// ============================================================

/// 执行带超时的命令并捕获详细输出
pub fn run_ffmpeg_command(
    cmd: &mut Command,
    timeout: std::time::Duration,
) -> Result<std::process::Output, String> {
    let start = std::time::Instant::now();
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    hide_console_window(cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 ffmpeg 失败: {}. 请确保已安装 ffmpeg", e))?;

    let poll_interval = std::time::Duration::from_millis(100);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                if let Some(mut out) = child.stdout.take() {
                    std::io::Read::read_to_end(&mut out, &mut stdout).ok();
                }
                if let Some(mut err) = child.stderr.take() {
                    std::io::Read::read_to_end(&mut err, &mut stderr).ok();
                }
                return Ok(std::process::Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("操作超时 (限制: {}s)", timeout.as_secs()));
                }
                std::thread::sleep(poll_interval);
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("等待进程异常: {}", e));
            }
        }
    }
}

/// 诊断特定时间点的视频流健康状况（仅在失败时调用）
///
/// 尝试在目标时间点附近用 ffmpeg 读取 1 帧到 null 输出，
/// 通过 stderr 判断该位置是否可读。
pub fn diagnose_video_at_time(video_path: &str, time: f64) {
    let mut cmd = Command::new(ffmpeg_path());
    hide_console_window(&mut cmd);
    cmd.args(&[
        "-v", "warning",
        "-ss", &format!("{:.3}", time),
        "-i", video_path,
        "-vframes", "1",
        "-f", "null",
        "-y", "-",
    ]);

    match cmd.stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
    {
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            if !stderr.trim().is_empty() {
                log::warn!(
                    "[ffmpeg] event=diagnose_warning video_path={} time={:.2} stderr={}",
                    video_path,
                    time,
                    stderr.trim()
                );
            } else if !out.status.success() {
                log::error!(
                    "[ffmpeg] event=diagnose_unreadable_segment video_path={} time={:.2}",
                    video_path,
                    time
                );
            }
        }
        Err(e) => log::error!(
            "[ffmpeg] event=diagnose_failed video_path={} time={:.2} error={}",
            video_path,
            time,
            e
        ),
    }
}

/// 截取结果：成功、失败、或超时
pub enum CaptureResult {
    /// 截图成功
    Success,
    /// 截图失败（非超时原因）
    Failed(#[allow(dead_code)] String),
    /// 截图超时（Fast 和 Slow 都超时，说明该时间点不可达）
    TimedOut,
}

/// 尝试截取单帧，包含 Fast → Slow 两级重试策略
pub fn try_capture_single_frame(
    video_path: &str,
    time: f64,
    output_path: &str,
    frame_idx: usize,
) -> CaptureResult {
    let time_str = format!("{:.3}", time);

    // 策略 1: 快速定位 (Input Seeking)
    let mut cmd = Command::new(ffmpeg_path());
    cmd.args(&[
        "-v",
        "warning",
        "-hide_banner",
        "-ss",
        &time_str,
        "-i",
        video_path,
        "-vframes",
        "1",
        "-q:v",
        "2",
        "-y",
        output_path,
    ]);

    match run_ffmpeg_command(&mut cmd, std::time::Duration::from_secs(10)) {
        Ok(output) => {
            let file_ok = Path::new(output_path).exists()
                && fs::metadata(output_path).map(|m| m.len()).unwrap_or(0) > 0;
            if output.status.success() && file_ok {
                return CaptureResult::Success;
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            log::warn!(
                "[ffmpeg] event=fast_capture_failed video_path={} frame_idx={} time={} stderr={}",
                video_path,
                frame_idx,
                time_str,
                stderr.trim()
            );
        }
        Err(e) => {
            log::warn!(
                "[ffmpeg] event=fast_capture_timeout video_path={} frame_idx={} time={} error={}",
                video_path,
                frame_idx,
                time_str,
                e
            );
        }
    }

    // ==========================================
    // 策略 2: 慢速解码 (Output Seeking)
    // -ss 在 -i 之后，从头解码到目标位置
    // 超时 15 秒 — 不设太长，避免损坏视频卡死
    // ==========================================
    let mut cmd = Command::new(ffmpeg_path());
    cmd.args(&[
        "-v",
        "warning",
        "-hide_banner",
        "-i",
        video_path,
        "-ss",
        &time_str,
        "-vframes",
        "1",
        "-q:v",
        "2",
        "-y",
        output_path,
    ]);

    match run_ffmpeg_command(&mut cmd, std::time::Duration::from_secs(15)) {
        Ok(output) => {
            let file_ok = Path::new(output_path).exists()
                && fs::metadata(output_path).map(|m| m.len()).unwrap_or(0) > 0;
            if output.status.success() && file_ok {
                return CaptureResult::Success;
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            log::error!(
                "[ffmpeg] event=slow_capture_failed video_path={} frame_idx={} time={} stderr={}",
                video_path,
                frame_idx,
                time_str,
                stderr.trim()
            );
            diagnose_video_at_time(video_path, time);
            CaptureResult::Failed(format!("截图失败: {}", stderr.trim()))
        }
        Err(e) => {
            log::error!(
                "[ffmpeg] event=slow_capture_timeout video_path={} frame_idx={} time={} error={}",
                video_path,
                frame_idx,
                time_str,
                e
            );
            CaptureResult::TimedOut
        }
    }
}

/// 流式截图：每成功一帧就通过 Tauri 事件推送给前端
///
/// 事件名: `capture-frame-ready`，payload 为帧文件路径字符串
/// 截图全部完成或被取消后，emit `capture-done` 事件
pub async fn capture_random_frames_streaming(
    app: &tauri::AppHandle,
    video_path: &str,
    count: usize,
    cancel_token: CancellationToken,
) -> Result<Vec<String>, String> {
    let video_path_obj = Path::new(video_path);
    if !video_path_obj.exists() {
        return Err("视频文件不存在".to_string());
    }

    let duration = get_video_duration(video_path)?;
    if duration <= 0.0 {
        return Err("无法获取视频时长".to_string());
    }

    let temp_dir = std::env::temp_dir().join(format!("jav_captures_{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;

    let mut frame_paths = Vec::new();

    // 允许在较短的视频中截得足够的帧
    // 假设截图间隔至少 0.1 秒
    let max_possible = (duration / 0.1).max(1.0) as usize;
    let actual_count = count.min(max_possible);

    let mut max_seekable: f64 = duration;
    let mut hit_seek_limit = false;

    // 为了让截图范围覆盖 0~100% (不预留两端 safety padding)，
    // 我们将 duration 均分为 actual_count 份，每份随机取一个点。
    // 但是第一帧强制设置在 0.0s。
    let segment_size = duration / actual_count as f64;

    for i in 0..actual_count {
        if cancel_token.is_cancelled() {
            break;
        }

        let offset = if i == 0 {
            0.0 // 第一帧固定为 0.0 (实际上是从视频的最开始截)
        } else {
            // 在当前段内随机，留出一点余量防止越过下一段或视频结尾
            let base = segment_size * i as f64;
            let random_offset = rand::random::<f64>() * segment_size * 0.95;
            base + random_offset
        };

        if hit_seek_limit && offset > max_seekable {
            continue;
        }

        let output_path = temp_dir.join(format!("frame_{}.jpg", i + 1));
        let output_path_str = output_path.to_string_lossy().to_string();
        let video_path_owned = video_path.to_string();
        let frame_idx = i + 1;
        let seek_time = offset;

        let result = tokio::task::spawn_blocking(move || {
            try_capture_single_frame(&video_path_owned, seek_time, &output_path_str, frame_idx)
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?;

        match result {
            CaptureResult::Success => {
                let path_str = output_path.to_string_lossy().to_string();
                let _ = app.emit("capture-frame-ready", &path_str);
                frame_paths.push(path_str);
            }
            CaptureResult::TimedOut => {
                if !hit_seek_limit {
                    max_seekable = offset * 0.8;
                    hit_seek_limit = true;
                }
            }
            CaptureResult::Failed(_) => {}
        }
    }

    // seek 上限导致截图太少时，在可 seek 范围内补充
    if frame_paths.len() < actual_count && hit_seek_limit && max_seekable > 1.0 {
        let need = actual_count - frame_paths.len();
        for i in 0..need {
            if cancel_token.is_cancelled() {
                break;
            }
            let segment = max_seekable / (need + 1) as f64;
            let offset = segment * (i + 1) as f64;
            if offset < 1.0 {
                continue;
            }

            let output_path = temp_dir.join(format!("frame_extra_{}.jpg", i));
            let output_path_str = output_path.to_string_lossy().to_string();
            let video_path_owned = video_path.to_string();

            let result = tokio::task::spawn_blocking(move || {
                try_capture_single_frame(&video_path_owned, offset, &output_path_str, 0)
            })
            .await
            .map_err(|e| format!("Task join error: {}", e))?;

            if let CaptureResult::Success = result {
                let path_str = output_path.to_string_lossy().to_string();
                let _ = app.emit("capture-frame-ready", &path_str);
                frame_paths.push(path_str);
            }
        }
    }

    // 兜底
    if frame_paths.is_empty() {
        let fallback_path = temp_dir.join("frame_fallback.jpg");
        let fallback_path_str = fallback_path.to_string_lossy().to_string();
        let video_path_owned = video_path.to_string();

        let res = tokio::task::spawn_blocking(move || {
            try_capture_single_frame(&video_path_owned, 1.0, &fallback_path_str, 0)
        })
        .await;

        if let Ok(CaptureResult::Success) = res {
            let path_str = fallback_path.to_string_lossy().to_string();
            let _ = app.emit("capture-frame-ready", &path_str);
            frame_paths.push(path_str);
        } else {
            let _ = app.emit("capture-done", serde_json::json!({ "count": 0 }));
            return Err("无法截取任何视频帧，文件可能严重损坏".to_string());
        }
    }

    let _ = app.emit(
        "capture-done",
        serde_json::json!({ "count": frame_paths.len() }),
    );
    Ok(frame_paths)
}

/// 获取视频时长（秒），带 10 秒超时
///
/// 使用 `ffmpeg -i` 解析 stderr 中的 `Duration: HH:MM:SS.ss` 行，
/// 无需依赖 ffprobe。
pub fn get_video_duration(video_path: &str) -> Result<f64, String> {
    let mut cmd = Command::new(ffmpeg_path());
    cmd.args(&["-i", video_path, "-hide_banner"]);
    hide_console_window(&mut cmd);

    // ffmpeg -i 无输出文件会返回非零退出码，这是正常行为
    // Duration 信息在 stderr 中
    let output = run_ffmpeg_command(&mut cmd, std::time::Duration::from_secs(10))
        .unwrap_or_else(|_| {
            // 兜底：直接执行不带超时包装
            let mut cmd2 = Command::new(ffmpeg_path());
            cmd2.args(&["-i", video_path, "-hide_banner"]);
            hide_console_window(&mut cmd2);
            cmd2.stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .unwrap_or_else(|_| std::process::Output {
                    status: std::process::ExitStatus::default(),
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                })
        });

    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_duration_from_ffmpeg_output(&stderr)
}

/// 获取视频分辨率（宽, 高），带 10 秒超时
///
/// 使用 `ffmpeg -i` 解析视频流信息中的 `1920x1080` 片段，
/// 作为 `nom-exif` 失败时的兜底方案。
pub fn get_video_resolution(video_path: &str) -> Result<(u32, u32), String> {
    let mut cmd = Command::new(ffmpeg_path());
    cmd.args(&["-i", video_path, "-hide_banner"]);
    hide_console_window(&mut cmd);

    let output = run_ffmpeg_command(&mut cmd, std::time::Duration::from_secs(10))
        .unwrap_or_else(|_| {
            let mut cmd2 = Command::new(ffmpeg_path());
            cmd2.args(&["-i", video_path, "-hide_banner"]);
            hide_console_window(&mut cmd2);
            cmd2.stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .unwrap_or_else(|_| std::process::Output {
                    status: std::process::ExitStatus::default(),
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                })
        });

    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_resolution_from_ffmpeg_output(&stderr)
}

/// 从 ffmpeg 输出中解析 `Duration: HH:MM:SS.ss` 格式的时长
fn parse_duration_from_ffmpeg_output(output: &str) -> Result<f64, String> {
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Duration:") {
            // "03:20:06.01, start: 0.000000, bitrate: 747 kb/s"
            let duration_part = rest.split(',').next().unwrap_or("").trim();
            if duration_part == "N/A" {
                return Err("视频时长不可用 (N/A)".to_string());
            }
            return parse_hms_duration(duration_part);
        }
    }
    Err(format!("未在 ffmpeg 输出中找到 Duration 行"))
}

/// 从 ffmpeg 输出中解析视频流分辨率
fn parse_resolution_from_ffmpeg_output(output: &str) -> Result<(u32, u32), String> {
    let resolution_re = Regex::new(r"(?P<width>\d{2,5})x(?P<height>\d{2,5})")
        .map_err(|e| format!("创建分辨率正则失败: {}", e))?;

    for line in output.lines() {
        let trimmed = line.trim();
        if !trimmed.contains("Video:") {
            continue;
        }

        for cap in resolution_re.captures_iter(trimmed) {
            let width = cap
                .name("width")
                .and_then(|m| m.as_str().parse::<u32>().ok())
                .unwrap_or(0);
            let height = cap
                .name("height")
                .and_then(|m| m.as_str().parse::<u32>().ok())
                .unwrap_or(0);

            if width >= 100 && height >= 100 {
                return Ok((width, height));
            }
        }
    }

    Err("未在 ffmpeg 输出中找到视频分辨率".to_string())
}

/// 解析 HH:MM:SS.ss 格式为秒数
fn parse_hms_duration(s: &str) -> Result<f64, String> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 3 {
        return Err(format!("时长格式异常: {}", s));
    }
    let hours: f64 = parts[0].trim().parse().map_err(|e| format!("解析小时失败: {}", e))?;
    let minutes: f64 = parts[1].trim().parse().map_err(|e| format!("解析分钟失败: {}", e))?;
    let seconds: f64 = parts[2].trim().parse().map_err(|e| format!("解析秒数失败: {}", e))?;
    Ok(hours * 3600.0 + minutes * 60.0 + seconds)
}

#[cfg(test)]
mod tests {
    use super::{parse_duration_from_ffmpeg_output, parse_resolution_from_ffmpeg_output};

    #[test]
    fn should_parse_duration_from_ffmpeg_output() {
        let output = "Duration: 01:23:45.67, start: 0.000000, bitrate: 747 kb/s";
        let duration = parse_duration_from_ffmpeg_output(output).unwrap();
        assert!((duration - 5025.67).abs() < 0.001);
    }

    #[test]
    fn should_parse_resolution_from_ffmpeg_output() {
        let output = "  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080, 2147 kb/s, 30 fps, 30 tbr, 15360 tbn (default)";
        let resolution = parse_resolution_from_ffmpeg_output(output).unwrap();
        assert_eq!(resolution, (1920, 1080));
    }
}
