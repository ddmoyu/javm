# 使用系统 WebView2 的离线包

2026-10-09，按用户提出的精简要求移除包内 WebView2 Fixed Runtime，继续由官方 Neutralino 6.10.0 调用系统已安装的 Evergreen WebView2 Runtime。

本文记录移除 WebView2 时的产物。随后 FFmpeg 也改为精简构建，最新包见 [精简 FFmpeg 验证](2026-10-09-lightweight-ffmpeg.md)。

## 变更与运行前提

- `offline:setup` 不再下载、校验或解压 WebView2 CAB；依赖清单和打包脚本移除固定运行时。
- `JAVM.exe` 仅保留启动入口及资源目录处理；移除运行时目录检查、`WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` 覆盖和 Windows 10 AppContainer 目录权限修改。
- ZIP 不再包含 `runtime` 目录或固定运行时许可证；清单明确标记 WebView2 为系统前提。下载工具、MediaInfo、MetaTube 和静态 Release 数据库扩展继续随包提供。
- Windows 11 预装 WebView2，绝大多数 Windows 10 已安装，仍存在缺少运行时的 Windows 10。此类设备需先安装微软 Evergreen WebView2 Runtime；离线设备应提前准备微软离线安装程序。
- 系统已具备 WebView2 时，启动和本地功能无需下载运行依赖。外部资料、AI 和网络资源下载仍需要相应网络服务。

依据：[微软分发说明](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution)；[Neutralino 6.10.0 WebView 实现](https://github.com/neutralinojs/neutralinojs/blob/v6.10.0/lib/webview/webview.h#L991)将浏览器目录参数留空，由 WebView2 加载器查找运行时。

## 本次交付

- 文件：`dist/offline/JAVM-1.0.0-windows-x64-offline-20261009T144303Z.zip`。
- 启动：完整解压后双击 `JAVM.exe`。
- ZIP：108,531,971 字节，约 103.50 MiB；原包为 400.71 MiB，减少约 74.17%。
- 清单：62 个文件，共 289,764,154 字节，清单本身另计；没有 WebView2 运行时或相关固定版本文件。
- SHA-256：`eb2c96ce1449c191ab146fd1d4745b2a810354a4f292994d6c2ffe1be922a0fe`。
- 打包当时的 `dist/offline/latest.json` 指向此包；之前的完整环境 ZIP 保留为历史产物。

## 验证

环境为本机 Windows 11 专业版 10.0.26200、系统 WebView2 154.0.4258.62。所有数据验证使用本次创建的隔离目录与合成素材，没有使用真实旧数据库或真实 AI 密钥。

- `pnpm offline:setup --Offline`：缓存中的业务工具校验通过，准备过程不再处理 WebView2。
- `pnpm check`：格式、lint、类型检查通过。
- `pnpm desktop:build`：Release 启动器、原生扩展、前端构建和资源嵌入通过。原有大包体与 React Compiler 指令提示仍存在。
- `pnpm test`：161 通过，71 项需显式集成环境的用例跳过。
- 播放偏好桌面验证：9/9，覆盖设置持久化、本地与 HLS 跨窗口续播、关闭与重开窗口、外部播放器参数及失效路径。验证产物与最终包宿主 SHA-256 相同：`12fe88db44c1be2a3f48dc402f365368dc79bfa8565fec7fae48e43eb083ccbb`。
- 最终包 MetaTube / AI 桌面验证：7/7，包含包内 MetaTube 自动发现、启停重启、DPAPI、合成 AI 接口请求、取消和响应限制。没有把合成接口验证当作真实 AI 供应商验收。
- 最终 ZIP 解压验证：62 个文件的大小和 SHA-256 全部一致；包内没有运行时目录。在仅保留系统 PATH、未设置 WebView2 目录的条件下，从中文及空格目录启动 `JAVM.exe` 成功，并确认其子进程来自 `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\154.0.4258.62\msedgewebview2.exe`。
- 同一套正式前端及数据库扩展在隔离数据路径下完成片库初始化、下载设置持久化；宿主退出后两个数据库完整性检查通过。测试自有宿主、MetaTube 和 curl 进程均已退出。

播放与资料测试移除了包内 WebView2 环境变量。日志分别为 `.tmp/system-webview-playback.log` 和 `.tmp/system-webview-metadata.log`；对应目录为 `.tmp/playback-uQSn27` 和 `.tmp/metadata-desktop-EUoAaM`。

最终解压目录为 `.tmp/离线 验证-083cb326/`，记录见 `.tmp/offline-validation.json` 和 `.tmp/system-webview-offline.log`。

本轮没有在 Windows 10、没有 WebView2 的机器或全新虚拟机上验收；没有卸载系统运行时或关闭整台机器的网络。没有提交、推送或发布 GitHub Release。
