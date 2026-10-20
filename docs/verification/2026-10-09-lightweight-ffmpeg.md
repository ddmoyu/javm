# 精简 FFmpeg 离线包验证

2026-10-09，参考旧版 `ddmoyu/ffmepg` 的裁剪配置，将离线包中的 Gyan essentials 替换为 FFmpeg 8.0.1 `javm-lite-1`。决策、来源及复现步骤见 [精简 FFmpeg](../decisions/0013-lightweight-ffmpeg.md)。没有改动下载引擎的合并策略。

后续内置 MetaTube 的更新包继续沿用本记录中的精简 FFmpeg，最新交付见 [内置 MetaTube 验证](2026-10-09-bundled-metatube.md)。下文保留本次裁剪完成时的交付与测试记录。

## 交付

- ZIP：`dist/offline/JAVM-1.0.0-windows-x64-offline-20261009T151253Z.zip`。
- 启动：完整解压后双击 `JAVM.exe`，继续使用系统已安装的 WebView2。
- ZIP 为 **39,993,483 字节（38.14 MiB）**，上一包为 103.50 MiB，减少约 63.15%。
- 清单为 70 个文件、100,513,720 字节，清单本身另计；独立的 Windows tar ZIP 阅读器列出 71 个文件。
- SHA-256：`4ee5ad7a74b926dad8391a0bfe28e541b7cbd28597224d0ebe51e4eb44e870b0`。
- 打包时 `dist/offline/latest.json` 指向此包，旧包保留。

| 文件          |       原通用构建 |        精简构建 | 精简构建 SHA-256                                                   |
| ------------- | ---------------: | --------------: | ------------------------------------------------------------------ |
| `ffmpeg.exe`  | 105,423,872 字节 | 10,778,624 字节 | `4495099fceb1873ac070981b70e6def890c1565f3a2248e46c8b6bb17cdcd56a` |
| `ffprobe.exe` | 105,221,120 字节 | 10,566,144 字节 | `8136d42c4cac7cbc9bfb929b2c8729565ae3b304730d69d947672a00e54a794c` |

两者合计从约 200.89 MiB 降为 20.36 MiB。实际保留 `file` / `pipe` 协议、MJPEG 编码器和 `image2` / `image2pipe` / `mov` / `mp4` 输出。程序包没有通用 FFmpeg 作为备用，没有带入 FFmpeg 静态库、头文件、编译环境或 WebView2 Runtime。

## 构建与校验

- 首次 `pnpm offline:setup --Offline` 从已校验的源代码和参考包缓存完成 MSVC 静态构建；随后重复运行复用 `build/ffmpeg-lite/94777c2f0d5e4f35`，没有重新配置或编译 FFmpeg。
- `pnpm check`：257 个文件格式通过，200 个文件的 lint / 类型检查通过。检查期间仅将既有 `windowResize.ts` 函数声明按格式器合为一行，未调整其逻辑。
- `pnpm test`：161 通过，71 个需要显式集成环境的用例跳过。
- `pnpm desktop:build`：Release 原生构建、前端构建、Neutralino 嵌入和桌面输出通过。仍有既有的前端分块体积与 React Compiler 指令提示。
- `node scripts/package-offline.mjs`：来源、profile、哈希、体积、裁剪参数和实际能力检查通过。额外将旧完整版放入隔离验证目录，确认以 `FFmpeg lite executable mismatch` 拒绝打包。
- MSVC 依赖检查及最终包系统 PATH 验证确认精简程序无需附带第三方运行时 DLL。

构建记录为 `.tmp/ffmpeg-lite-setup.log`、`.tmp/ffmpeg-lite-cached-setup.log`、`.tmp/ffmpeg-lite-desktop-build.log`。静态检查和常规测试分别为 `.tmp/ffmpeg-lite-check.log`、`.tmp/ffmpeg-lite-test.log`；打包拒绝验证为 `.tmp/ffmpeg-lite-package-guard.log`。

## 实际功能和最终 ZIP

验证环境为本机 Windows 11 专业版 10.0.26200，系统 WebView2 154.0.4258.62。合成素材生成器通过 `JAVM_FIXTURE_FFMPEG` 使用开发机工具，实际下载和合并明确指向最终包内精简程序。

- `pnpm test:downloads`：5 个测试文件、72 项通过。包含 14 项真实下载引擎测试，覆盖 MP4、HTTP 头、代理、并行下载、HLS、独立 fMP4 音视频轨、Range 续传、错误反馈、保留输入重试合并、退出进程回收；同时验证下载数据库和宿主生命周期。日志 `.tmp/ffmpeg-lite-downloads-final.log`。
- `pnpm test:playback:preferences`：最终包宿主验证 9/9 通过，覆盖窗口偏好持久化、本地与 HLS 续播、片尾清理、外部播放器中文和特殊字符参数、失效路径。日志 `.tmp/ffmpeg-lite-playback.log`，隔离目录 `.tmp/playback-gBUG4b`。
- `pnpm test:offline`：解压后的 70 个文件大小及 SHA-256 全部一致；仅系统 PATH 下，精简 FFmpeg/ffprobe 能启动且能力符合裁剪要求。`JAVM.exe` 在中文与空格路径下调用系统 WebView2，隔离片库初始化、下载设置持久化及退出后两个数据库完整性检查通过。
- 最终解压出的 FFmpeg 在仅系统 PATH 下，将合成 H.264 视频输出到 `缩略图 & 100%.jpg`，ffprobe 确认视频图像为 320×180。记录 `.tmp/ffmpeg-lite-artifact-check.json`。
- ZIP SHA-256 通过独立 PowerShell 哈希复核，Windows tar 能正常读取 ZIP 目录。

最终解压目录为 `.tmp/离线 验证-613ff5e4/JAVM-1.0.0-windows-x64-offline-20261009T151253Z`，记录为 `.tmp/offline-validation.json`、`.tmp/ffmpeg-lite-offline.log`。测试自有进程已退出，其他任务正在运行的数据库进程未触碰。

本轮不使用真实旧数据库或真实 AI 密钥，没有重新进行公网样本验收，没有在 Windows 10 或全新虚拟机上验证。没有提交、推送或发布 GitHub Release。
