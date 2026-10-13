# 跨平台支持核对

核对日期：2026-10-13。依据当前 `dev` 源码、构建脚本及实际 GitHub Release；属于静态核对，没有在 macOS、Linux 或 ARM64 设备上编译运行。工作区已有的窗口位置改动仅阅读，未作修改。

## 当前可交付范围

当前公开的 `v1.0.5-alpha.3` 已完成 Windows x64 便携包发布。此次修改为后续 Alpha 增加 Windows x64 Setup 构建、验证和下载表格，尚未触发远端发布。

React、Mantine、SQLite、FFmpeg、MediaInfo、curl、MetaTube 和 Neutralino 架构可以复用，但 JAVM 的平台适配尚未完成。不能仅添加 Actions 系统矩阵就宣称支持 macOS 或 Linux。

| 目标                        | 当前状态                                                          | 拟交付形式                                              |
| --------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| Windows x64                 | 已有便携包发布；本次接入安装器，安全占位安装验证通过，真实包待 CI | Setup EXE + Portable ZIP                                |
| macOS Apple Silicon / Intel | 扩展通信、系统适配、组件构建与运行验证均未完成                    | 完成适配后再提供 APP / DMG                              |
| Linux x64                   | 原生构建被显式阻止，系统适配和运行验证未完成                      | 先验证目标发行版，再选择 AppImage / DEB；RPM 后续按需求 |
| Windows 原生 ARM64          | 现有配方与附件均为 x64，没有 ARM64 完整组件链及运行证据           | 需独立构建、验证和标记；x64 仿真不等于原生 ARM64 支持   |
| Android                     | 不在当前桌面重构范围，没有移动端外壳与原生适配                    | 不能把参考图中的 APK 入口直接加入下载表格               |

## 缺口与源码证据

| 优先级 | 缺口                               | 当前证据                                                                                                                                            | 所需工作                                                                                                                  |
| ------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| P0     | 数据库扩展无法在非 Windows 运行    | `native/database/src/main.cpp` 使用 WinHTTP WebSocket，非 Windows 分支直接报错退出；`neutralino.config.json` 只有 `commandWindows`                  | 实现跨平台 WebSocket 客户端及宿主退出监护，保持 Neutralino 官方 Extension 协议；补 `commandLinux` / `commandDarwin`       |
| P0     | 媒体服务不能在非 Windows 构建      | `native/media/CMakeLists.txt` 显式 `FATAL_ERROR`；`common.cpp`、`probe.cpp`、`nfo.cpp`、`nfo_encoding.cpp`、`legacy_import.cpp` 直接调用 Win32      | 适配进程组及取消回收、动态库加载、Unicode / NFO 编码、原子替换、文件身份与锁、符号链接与大小写语义                        |
| P0     | 网络构建仍绑定 Windows             | `native/http/CMakeLists.txt` 固定 Schannel 并关闭 OpenSSL；`http_service.cpp` 直接包含 `windows.h` 并用 Win32 校验 UTF-8                            | 按平台选择可用 TLS 后端和证书库，移除该编码校验的 Win32 依赖，验证代理、HTTPS 和取消行为                                  |
| P0     | 子进程与工具发现依赖 Windows       | `frontend/src/platform/neutralino/process.ts` 使用 PowerShell / `taskkill`；`downloadHost.ts`、`metatubeHost.ts` 等固定 `.exe`                      | 建立平台进程适配，安全传参、停止完整进程树，查找各平台工具，处理执行权限                                                  |
| P0     | 业务启动被 Windows 条件限制        | `downloads.ts`、`metadataServices.ts`、`scraping.ts`、`streamResolution.ts` 检查 `NL_OS === "Windows"`                                              | 完成底层实现后按能力启用服务；不可只移除判断，否则会触发尚未移植的实现                                                    |
| P0     | 持久化路径与密钥保护仅适配 Windows | `catalogSeed.ts`、`discoveryCatalog.ts`、`imageSources.ts`、`portraits.ts` 读取 `LOCALAPPDATA`；`metadataHttp.ts` 用 DPAPI                          | 使用官方系统数据路径；为 macOS / Linux 选定系统密钥存储并验证；不能以明文保存替代 DPAPI                                   |
| P1     | 桌面集成需要分别实现               | `systemIntegration.ts` / `systemProtocol.ts` 使用注册表和 `JAVM.exe`；`PlaybackSettingsService.ts` 要求 Windows EXE 绝对路径                        | 实现 macOS URL Scheme / Linux desktop entry、外部播放器启动与选择；验证托盘、窗口恢复、多显示器、DPI 和明确退出           |
| P1     | 隐藏 WebView 与播放器依赖平台引擎  | `hiddenWebview.ts` 通过 PowerShell、WebView2 配置和 CDP 启动隐藏宿主                                                                                | 为各平台确定有界隐藏解析方案；在 WKWebView / WebKitGTK 验证视频编码、HLS、Range、全屏与自动播放权限，不套用 WebView2 参数 |
| P0     | 组件与应用构建链只有 Windows x64   | `scripts/third-party/components.mjs` 仅列 `windows-x64`；安装器、校验器和打包器固定 Windows；MetaTube 固定 `GOOS=windows`；FFmpeg 构建脚本调用 MSVC | 原生构建入口、平台与架构矩阵、组件指纹、SDK / 运行库路径、Mach-O / ELF 校验及缓存均需适配                                 |
| P1     | 安装分发与更新识别尚不通用         | 现有更新检查只识别 `windows-x64-offline-*.zip`，与目前 Release 的无时间戳 ZIP 名称已有差异；发布构建只验证 Windows                                  | 统一资产命名和平台识别；完成 macOS bundle / DMG / 签名公证及 Linux 包依赖；单独验证安装、覆盖安装和卸载                   |

## 建议实施顺序

1. 保持 Windows x64 为已支持目标，先闭合本次 Setup + Portable 发布。
2. 抽出扩展通信、进程管理、文件路径、动态库与凭据存储的系统差异；移除非 Windows 编译硬阻断。
3. 选择一个新平台先完成组件 Release、原生扩展与最小桌面启动，再接入完整业务。若没有设备优先级，可先用 Linux x64 CI 验证原生可移植性，再做 macOS ARM64 / x64；这只是实施建议，并非新增平台开发授权。
4. 用安全合成样例验证扫描、数据库、下载、播放、封面、后台任务取消、关闭到托盘及退出清理。覆盖慢 I/O、大数据、中文和空格路径；不可仅凭编译成功验收。
5. 完成各平台安装、覆盖安装、卸载保留数据、系统运行时前提及目标设备验证后，再把该平台加入 Release 下载表格。

Windows 代码签名、macOS 签名与公证、Linux 各发行版 WebKitGTK / 系统依赖仍需独立验收；本次不据此承诺已支持的平台或版本。

官方配置依据：[Neutralino 系统数据目录与扩展配置](https://neutralino.js.org/docs/configuration/neutralino.config.json/)。本表的平台完成状态以仓库源码为依据，框架自身的能力不代表 JAVM 已完成适配。
