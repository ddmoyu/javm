# 移除 ffprobe 并复用 MediaInfo

2026-10-09，按用户要求移除运行时、构建和分发中的 ffprobe。下载输入轨道识别、合并进度与输出校验改为复用现有 MediaInfo。N_m3u8DL-RE 下载及 FFmpeg `-c copy` 合并保持原有职责。

## 实现

- `ToolDownloadEngine` 调用宿主的媒体探测接口，不再查找或执行 ffprobe。旧 `ffprobePath` 设置被忽略，其他设置和已有数据库保留。
- 官方 Extension 增加 `media.probe` / `media.cancelProbe`，复用已有 MediaInfo 子进程，支持纯音频输入、音视频轨数量及毫秒时长。没有新增工具、服务器或前端 stdin/stdout 协议。
- 下载探测最多使用两个后台工作线程，等待队列上限 8；与扫描共享 MediaInfo 子进程总上限 16。保留单次探测 15 秒超时、取消、Job Object 进程回收及宿主退出清理。
- 保留输出非空、视频轨、预期音频轨和时长未明显缩短的检查。失败时保留输入供重试，不发布完成文件。
- FFmpeg profile 更新为 `javm-lite-2`，显式 `--disable-ffprobe`，只生成 `ffmpeg.exe`。清理旧构建输出位置的 ffprobe EXE 和其版本说明，不删除历史发布 ZIP。
- 打包校验拒绝混入 ffprobe，解压验收同时检查清单中不存在该程序。

## 验证

| 项目                           | 结果                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `pnpm check`                   | 261 个文件格式通过；202 个文件无 lint／类型错误或警告                                    |
| `pnpm test`                    | 170 通过；73 项需显式集成环境的测试跳过                                                  |
| `pnpm test:downloads`          | 6 个文件、82 项通过，实际工具使用当前精简 FFmpeg、内置 MediaInfo 和 N_m3u8DL-RE          |
| 原生扫描回归                   | `JAVM_MEDIA_INTEGRATION=1` 下 `media-native.integration.test.ts` 14/14 通过              |
| `pnpm offline:setup --Offline` | 从校验过的缓存重建 FFmpeg，其余依赖复用缓存                                              |
| `pnpm desktop:build`           | Release 原生扩展、前端及嵌入桌面程序构建通过                                             |
| 打包拒绝验证                   | 在隔离目录放入不可执行的 ffprobe 占位文件，校验明确拒绝该目录                            |
| `pnpm test:offline`            | 最终 ZIP 的文件校验、系统 PATH 启动、官方 Extension 的独立音频探测及数据库完整性检查通过 |

下载回归覆盖 MP4、HTTP 请求头、代理、HLS、独立 fMP4 视频与音频轨、Range 续传、并发下载、合并重试和退出清理。本轮增加纯音频探测、无效媒体拒绝、探测队列满载与取消后重试，以及输出缺少视频、缺少音频或时长缩短时保留输入的用例。常规测试另覆盖取消后拒绝迟到结果。

原生编译首次在复制到 `bin/javm_database.exe` 时因旧窗口测试占用而失败；关闭该测试宿主后重建成功。FFmpeg 上游代码编译包含既有 MSVC 警告；前端构建保留既有分块体积与 React Compiler 指令提示。

日志：`.tmp/remove-ffprobe-check-final.log`、`.tmp/remove-ffprobe-unit-final.log`、`.tmp/remove-ffprobe-downloads.log`、`.tmp/remove-ffprobe-scanning.log`、`.tmp/remove-ffprobe-native-final.log`、`.tmp/remove-ffprobe-setup.log`、`.tmp/remove-ffprobe-desktop-build.log`、`.tmp/remove-ffprobe-package.log`、`.tmp/remove-ffprobe-offline.log`。打包拒绝证据为 `.tmp/remove-ffprobe-package-guard.json`。

## 最终运行包

- ZIP：`dist/offline/JAVM-1.0.0-windows-x64-offline-20261009T155521Z.zip`。
- 大小：35,508,319 字节（33.86 MiB），此前为 39,992,011 字节（38.14 MiB）。移除的 ffprobe EXE 解压体积为 10,566,144 字节。
- SHA-256：`5d5e0bd3651911e6413c69a5f542cd03b01782774912349b190a75f3d26cfb93`。
- 清单 68 个文件，清单本身另计；独立 Windows tar 阅读器列出 69 个文件，无 ffprobe。PowerShell 独立复核 ZIP 哈希。
- FFmpeg 仍为 10,778,624 字节，SHA-256 为 `20ee40af5abbeac3ac3805b294bceae5a885246822f9474d009d0e701120f7a0`，构建目录 `build/ffmpeg-lite/15b1f1cea5026f9d`。
- 继续内置 MetaTube v1.4.0，并使用系统 WebView2，不附带 WebView2 Runtime。完整解压后运行 `JAVM.exe`。

解压验收目录为 `.tmp/离线 验证-2f8bea35/JAVM-1.0.0-windows-x64-offline-20261009T155521Z`，记录为 `.tmp/offline-validation.json`、`.tmp/remove-ffprobe-artifact-check.json`。在中文和空格路径、仅系统 PATH 下，实际包内 MediaInfo 经官方 Extension 正确识别合成 PCM 独立音轨及 1 秒时长。

本机 Windows 11 与系统 WebView2 154.0.4258.62 验证通过；没有使用真实旧数据库、重新下载公网样本或执行 Windows 10／全新虚拟机验收。没有提交、推送或发布 GitHub Release。
