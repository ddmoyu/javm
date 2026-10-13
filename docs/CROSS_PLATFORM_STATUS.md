# 跨平台支持核对

核对日期：2026-10-13。依据当前 `dev` 源码、构建脚本及实际 GitHub Release。跨平台核心已在 Windows 上编译，并使用模拟宿主和真实官方宿主验证；没有在 macOS、Linux 或 ARM64 设备上编译运行。

## 当前可交付范围

当前公开的 [v1.0.5-alpha.4](https://github.com/ddmoyu/javm/releases/tag/v1.0.5-alpha.4) 已完成 Windows x64 Setup、便携包和下载表格发布；[Actions](https://github.com/ddmoyu/javm/actions/runs/38341935243) 构建与安装验证成功，资产已回读。后续 macOS / Linux 适配见[实施计划](CROSS_PLATFORM_PLAN.md)，本地开发版本为 `1.0.5-alpha.9`；独立核心、工具监督与媒体探测模块已实现，完整应用移植仍在推进。

React、Mantine、SQLite、FFmpeg、MediaInfo、curl、MetaTube 和 Neutralino 架构可以复用，但 JAVM 的平台适配尚未完成。不能仅添加 Actions 系统矩阵就宣称支持 macOS 或 Linux。

| 目标                        | 当前状态                                                | 拟交付形式                                              |
| --------------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| Windows x64                 | Alpha 4 安装包和便携包均已发布，CI 及发布资产回读完成   | Setup EXE + Portable ZIP                                |
| macOS Apple Silicon / Intel | 已有独立核心构建与 curl 通信，目标系统及完整业务未验收  | 完成适配后再提供 APP / DMG                              |
| Linux x64                   | 已有独立核心构建，媒体构建仍受限，目标系统未验收        | 先验证目标发行版，再选择 AppImage / DEB；RPM 后续按需求 |
| Windows 原生 ARM64          | 现有配方与附件均为 x64，没有 ARM64 完整组件链及运行证据 | 需独立构建、验证和标记；x64 仿真不等于原生 ARM64 支持   |
| Android                     | 不在当前桌面重构范围，没有移动端外壳与原生适配          | 不能把参考图中的 APK 入口直接加入下载表格               |

## 缺口与源码证据

| 优先级 | 缺口                                 | 当前证据                                                                                                                             | 所需工作                                                                                                                  |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| P0     | 原生核心的目标系统验证待完成         | `JAVM_CORE_ONLY`、curl WebSocket、POSIX 数据库锁已实现；三平台启动命令在独立官方宿主夹具中；Windows 两种通信已验证                   | 在 macOS / Linux 验证构建、文件锁、证书和宿主生命周期；完整媒体与能力开关就绪后再接入正式应用配置                         |
| P0     | 完整媒体服务不能在非 Windows 构建    | `native/probe` 已隔离动态加载、Unicode 和工作进程；`native/media/CMakeLists.txt` 仍受限，`common.cpp`、NFO 与旧库导入仍有 Win32 调用 | 验收 POSIX 探测；继续适配 NFO 编码、原子替换、文件身份与锁、符号链接和大小写语义，再接入完整扫描服务                      |
| P0     | 目标 TLS 与代理行为待验证            | `native/http/CMakeLists.txt` 已区分 Schannel、OpenSSL、macOS SecTrust；Windows 上 HTTP 回环、并发、取消及超时验证通过                | 在各目标系统验证 HTTPS、代理、证书库及安装后运行库装载，不能用 Windows Schannel 结果替代                                  |
| P0     | POSIX 工具监督器待目标系统验收       | `toolPaths.ts` 已适配名称 / 路径 / 权限；`native/process` 提供进程组和宿主监护，`native/probe` 已复用；手动 CI 用例已准备            | 在 macOS / Linux 验证官方进程 API、动态库和回收；继续适配 MetaTube 端口和平台组件，完整业务仍受限                         |
| P0     | 业务启动被 Windows 条件限制          | `downloads.ts`、`metadataServices.ts`、`scraping.ts`、`streamResolution.ts` 检查 `NL_OS === "Windows"`                               | 完成底层实现后按能力启用服务；不可只移除判断，否则会触发尚未移植的实现                                                    |
| P0     | 密钥保护仍仅适配 Windows             | 四处目录和缓存调用已接入统一系统路径，Windows 保留原位置；`metadataHttp.ts` 仍用 DPAPI                                               | 为 macOS / Linux 选定系统密钥存储并验证，核对数据库与其他服务的数据位置；不能以明文保存替代 DPAPI                         |
| P1     | 桌面集成需要分别实现                 | `systemIntegration.ts` / `systemProtocol.ts` 使用注册表和 `JAVM.exe`；`PlaybackSettingsService.ts` 要求 Windows EXE 绝对路径         | 实现 macOS URL Scheme / Linux desktop entry、外部播放器启动与选择；验证托盘、窗口恢复、多显示器、DPI 和明确退出           |
| P1     | 隐藏 WebView 与播放器依赖平台引擎    | `hiddenWebview.ts` 通过 PowerShell、WebView2 配置和 CDP 启动隐藏宿主                                                                 | 为各平台确定有界隐藏解析方案；在 WKWebView / WebKitGTK 验证视频编码、HLS、Range、全屏与自动播放权限，不套用 WebView2 参数 |
| P0     | 组件与完整应用构建链只有 Windows x64 | 独立核心已有三平台开发入口和手动矩阵；`scripts/third-party/components.mjs`、打包器、MetaTube 与 FFmpeg 配方仍仅 Windows              | 平台组件指纹、SDK / 运行库路径、Mach-O / ELF 校验、缓存和完整应用构建继续适配                                             |
| P1     | 安装分发与更新识别尚不通用           | 现有更新检查只识别 `windows-x64-offline-*.zip`，与目前 Release 的无时间戳 ZIP 名称已有差异；发布构建只验证 Windows                   | 统一资产命名和平台识别；完成 macOS bundle / DMG / 签名公证及 Linux 包依赖；单独验证安装、覆盖安装和卸载                   |

## 建议实施顺序

1. Windows x64 Setup + Portable 发布已闭合；保持其现有数据和运行行为。
2. 系统路径、Unicode、宿主选择、独立 Extension 核心、工具监督和隔离媒体探测已实现。接下来完成文件身份 / 原子替换 / NFO 等文件语义，并在目标系统验收；按模块解除非 Windows 构建限制。
3. 用户已授权规划并推进无需确认的跨平台部分。手动矩阵已准备 Linux x64、macOS ARM64 / x64 的核心验收，远端尚未运行；完整移植、组件 Release 与平台发布分别按实施计划验收。
4. 用安全合成样例验证扫描、数据库、下载、播放、封面、后台任务取消、关闭到托盘及退出清理。覆盖慢 I/O、大数据、中文和空格路径；不可仅凭编译成功验收。
5. 完成各平台安装、覆盖安装、卸载保留数据、系统运行时前提及目标设备验证后，再把该平台加入 Release 下载表格。

Windows 代码签名、macOS 签名与公证、Linux 各发行版 WebKitGTK / 系统依赖仍需独立验收；本次不据此承诺已支持的平台或版本。

官方配置依据：[Neutralino 系统数据目录与扩展配置](https://neutralino.js.org/docs/configuration/neutralino.config.json/)。本表的平台完成状态以仓库源码为依据，框架自身的能力不代表 JAVM 已完成适配。
