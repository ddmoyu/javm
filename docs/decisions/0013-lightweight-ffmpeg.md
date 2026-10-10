# 精简 FFmpeg

2026-10-09，按用户要求参考旧版依赖，离线运行包停止使用 Gyan essentials 通用构建。

当前 `javm-lite-2` 已按用户要求移除 ffprobe，验证与交付见 [移除 ffprobe](../verification/2026-10-09-remove-ffprobe.md)。

## 来源和边界

旧项目发布工作流使用 [ddmoyu/ffmepg 的定制 FFmpeg 8.0.1](https://github.com/ddmoyu/ffmepg/releases/tag/javm-ffmpeg-n8.0.1-20260315-153157)。其 Windows x64 `ffmpeg.exe` 为 9,268,224 字节，实际只启用 `image2` 输出和 `file` 协议，没有 MP4 muxer、管道进度或 ffprobe，直接替换会使当前下载合并失效。

当前使用同版本的 [FFmpeg 官方原始源代码](https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz)，参考旧包中锁定的视频解码器列表与裁剪方式，增加下载所需的 MP4 无损封装、AAC ADTS 转换与 `pipe` 进度输出。当前 `javm-lite-2` 按用户要求移除 ffprobe，音视频探测通过官方 Extension 复用已有 MediaInfo。不修改上游源码。

- 保留原生视频解码与 JPEG 编码、缩放等抽帧滤镜，所有可用的内置解封装器和解析器。
- 只保留 `file` / `pipe` 协议和 `image2` / `image2pipe` / `mov` / `mp4` 输出；其中 MOV 为 MP4 的构建依赖。
- 只保留 MJPEG 编码器；音视频下载使用 `-c copy`，不转码。
- 关闭自动探测外部库、网络、硬件加速、设备、ffplay 和音频重采样。不引入外部编码库、网络库或运行时 DLL。
- 与旧精简配置相同，依赖未启用外部库的解码器不会纳入实际构建；不能将参考列表中的每个名称等同于已启用能力。
- 视频播放仍由 WebView2 或用户配置的外部播放器承担，目录扫描仍用 MediaInfo。

## 构建与打包

`scripts/offline-dependencies.json` 锁定源代码、旧参考包和 MSYS GNU Make 的版本及 SHA-256。参考包和 Make 标记为 `buildOnly`，不进入运行包。镜像下载须通过同一哈希校验。

`pnpm offline:setup` 调用 `scripts/build-ffmpeg-lite.ps1` 和 `scripts/build-ffmpeg-lite.sh`。MSVC 通过 `vswhere -prerelease` 发现并由 `vcvars64.bat` 初始化；需要 Git Bash 与 PATH 中的 NASM。Git Bash 路径可用 `JAVM_GIT_BASH` 指定。GNU Make 使用 MSYS 版本，避免 Windows 原生 Make 的路径和 shell 引号不兼容。

构建目录由源代码、参考包、脚本和编译器等输入哈希确定；相同输入复用完成的产物，输入变化使用新目录。MSVC 默认静态 CRT，包内只带 `ffmpeg.exe`、`ffmpeg-lite.json` 构建凭据与许可证，不带编译器、静态库、头文件或通用构建作为回退。

`scripts/verify-ffmpeg-lite.mjs` 在打包及解压验收时校验来源、profile、二进制大小和哈希、版本、裁剪参数及实际协议／编码器／输出格式。每个 EXE 的 25 MiB 上限用于拒绝明显的通用构建；当前 `javm-lite-1` 的主要能力以实际列表检查为准。

## 验证素材与运行工具分开

合成测试素材需要 H.264/AAC 编码器与 HLS 输出，这些不属于程序运行需求。`JAVM_FIXTURE_FFMPEG` 可指向开发机完整版，仅生成本地测试素材；实际下载引擎使用 `JAVM_FFMPEG` 指向的精简版，媒体探测使用当前原生 Extension 与 MediaInfo，不能以生成器替代被测工具。

```powershell
$env:JAVM_FIXTURE_FFMPEG = '开发机完整版 ffmpeg.exe 的绝对路径'
$env:JAVM_FFMPEG = (Resolve-Path .\bin\tools\ffmpeg.exe).Path
$env:JAVM_CURL = (Resolve-Path .\bin\tools\curl.exe).Path
pnpm test:downloads
```

运行包在中文及空格路径、仅保留系统 PATH 的环境下验证，避免开发机的完整 FFmpeg、DLL 或编译工具掩盖缺失依赖。功能验证覆盖直接下载、HLS、独立音视频轨合并、输出探测、暂停续传和取消。

实际产物大小、校验值和测试结果见 [精简 FFmpeg 离线包验证](../verification/2026-10-09-lightweight-ffmpeg.md)。
