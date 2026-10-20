# Windows x64 离线包验证

这是携带固定 WebView2 运行时的历史包记录。后续按用户要求改为使用系统 WebView2，当前交付见[系统 WebView2 包验证](2026-10-09-system-webview2.md)。

本次按用户要求，打包此前完成的播放偏好、MetaTube 与 AI 功能，并补齐本地运行依赖。

## 交付

- ZIP：`dist/offline/JAVM-1.0.0-windows-x64-offline-20261009T142344Z.zip`
- 启动：完整解压后双击 `JAVM.exe`；不需要开发环境或额外安装 WebView2。
- ZIP 大小：420,172,726 字节，约 400.71 MiB。
- 文件清单包含 319 个文件，合计 995,331,814 字节；清单文件本身另计。
- ZIP SHA-256：`9e875f9eddbf16b3ff3cc19ced1e4bb5492e2bb8f454a832d32c040dc4c6bcb4`。
- `package-manifest.json`、`Verify-Package.ps1`、中文使用说明及第三方许可证随包提供。

## 运行组件

| 组件                       | 版本／构建                                          |
| -------------------------- | --------------------------------------------------- |
| JAVM / 启动器 / 数据库扩展 | 1.0.0，Windows x64 Release                          |
| Neutralino                 | 6.10.0，前端嵌入 EXE                                |
| WebView2 Fixed Runtime     | 155.0.4283.45，完整微软原始 CAB 内容                |
| SQLite                     | 3.53.4，静态链接                                    |
| MediaInfo                  | 26.10                                               |
| N_m3u8DL-RE                | 0.6.0-beta，自包含原生版本                          |
| FFmpeg / ffprobe           | 9.0.2 essentials，Gyan 构建                         |
| curl                       | 8.22.0，官方未修改源码，MSVC /MT、Unicode、Schannel |
| MetaTube                   | v1.4.0，官方 Windows amd64 包                       |

发布扩展及启动器采用静态 MSVC 运行库。`dumpbin /dependents` 检查确认 JAVM 启动器、数据库扩展、MediaInfo、curl、FFmpeg、ffprobe、N_m3u8DL-RE 和 MetaTube 无 Debug CRT 或额外开发机 DLL 依赖；WebView2 自身的 DLL 保留在完整运行时目录内。

最初下载的 curl Windows MinGW 包缺少 Unicode 文件名支持，在中文目录直链下载时返回退出码 23。改用官方源码构建后，中文、空格、单引号及 `&` 路径的下载用例全部通过。打包脚本会拒绝缺少 Unicode／Schannel 的 curl。构建脚本和源码来源随包记录。

## 已完成验证

环境：Windows 11 专业版，10.0.26200。使用本任务创建的全新目录与合成媒体，不使用真实旧数据库或真实 AI 密钥。

| 验证                                 | 结果                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `pnpm check`                         | 格式、lint、类型检查通过                                                                       |
| `pnpm test`                          | 161 通过；71 项需显式集成环境的测试跳过                                                        |
| `pnpm desktop:build`                 | Release 静态原生构建、前端构建及资源嵌入通过                                                   |
| 下载工具集成测试                     | 14/14，真实 MP4、HLS、分轨合并、暂停续传、代理、取消、合并重试                                 |
| Release 数据库、资料、NFO 与片库查询 | 34/34                                                                                          |
| 包内 MetaTube / AI 桌面测试          | 7/7，包内 MetaTube 自动识别、启停重启，真实 curl 调用本机合成 AI 接口，DPAPI、取消及错误处理   |
| 包内 WebView2 播放偏好测试           | 9/9，设置持久化、独立窗口、本地及 HLS 续播、外部播放器参数                                     |
| 最终 ZIP 解压                        | 319 个文件的大小及 SHA-256 全部通过                                                            |
| 解压后的 `JAVM.exe`                  | 仅保留 Windows 系统 PATH，未设置外部 WebView2 路径，启动成功且检测到包内 WebView2 进程         |
| 正式前端与数据库扩展                 | 同一套生产资源和二进制，仅替换测试数据路径；片库初始化、下载设置写入、宿主退出后两库完整性通过 |

最终解压验证位于 `.tmp/离线 验证-8c61a3fb/`；记录在 `.tmp/offline-validation.json`。初次与其他桌面测试并行执行时，冷启动进程检测超过 25 秒，单独重新验证通过；验证脚本现将此等待放宽到 60 秒，未改变程序启动行为。

工具测试使用的 curl 与交付包中的 curl SHA-256 相同。清单已排查，不含个人数据库、`.storage`、`.neutralino`、API 密钥、Node 依赖目录或 PDB。

主要日志：`.tmp/offline-download-unicode-test.log`、`.tmp/offline-release-native-test.log`、`.tmp/offline-final-metadata.log`、`.tmp/offline-final-playback.log`、`.tmp/offline-final-smoke.log`。

## 验证边界

- 已在本机隔离目录验证，没有在全新 Windows 虚拟机或 Windows 10 上执行验收。Windows 10 启动器按微软要求给包内 WebView2 添加 AppContainer 读取／执行权限，该分支尚未实机验证。
- 没有关闭整台机器的网络；启动与本地功能验证不下载运行依赖，网络相关用例连接本机合成服务。外部资源下载、MetaTube 在线查询、AI 接口仍需要网络，AI 不包含离线模型。
- WebView2 支持的编码可内置播放，FFmpeg 随包用于下载合并和媒体校验；不支持的播放编码仍可交给用户配置的外部播放器。
- 未提交、推送或发布 GitHub Release。

## 来源

- [微软 WebView2 分发说明](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution)，固定版本下载地址及摘要见 `scripts/offline-dependencies.json`；签名实测为有效 Microsoft Corporation。
- [FFmpeg 官方下载页](https://ffmpeg.org/download.html)列出的 [Gyan Windows 构建](https://www.gyan.dev/ffmpeg/builds/)。
- [curl 官方源码](https://curl.se/download.html)及[构建说明](https://curl.se/docs/install.html)。
- [N_m3u8DL-RE 官方发行](https://github.com/nilaoda/N_m3u8DL-RE/releases/tag/v0.6.0-beta)。
- [MetaTube 官方发行](https://github.com/metatube-community/metatube-server-releases/releases/tag/v1.4.0)。
