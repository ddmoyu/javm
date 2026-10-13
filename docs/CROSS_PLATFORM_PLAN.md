# macOS / Linux 适配计划

更新：2026-10-13。范围已由用户确认；约定的开发适配、完整桌面与安装自动化验收已完成。公开新版本和真机覆盖的边界见下文。

## 首发范围

| 系统          | 架构                 | 交付形式                              |
| ------------- | -------------------- | ------------------------------------- |
| Windows 10/11 | x64                  | Setup EXE、Portable ZIP，延续已有交付 |
| macOS 13+     | Apple Silicon、Intel | JAVM.app、DMG、Portable ZIP           |
| Ubuntu 24.04  | x64                  | AppImage、DEB、Portable tar.gz        |

macOS 开发包使用本地 ad-hoc 签名以满足执行要求，不包含 Developer ID 或公证；Linux 开发包不签名。本轮发布版本为 `1.0.5-alpha.10`，下载以 [Release 实际附件](https://github.com/ddmoyu/javm/releases/tag/v1.0.5-alpha.10)为准。现有公开 Alpha 4 不覆盖、不替换。

继续使用 React、Mantine、TypeScript、官方 Neutralino API 和 Extension 协议。目录、数据库、探测和进程管理保留现有原生模块边界。不加入 Android、Windows ARM64、字幕或多音轨选择。验证只使用合成素材、空白页面、临时数据库和回环服务。

## 验收顺序

1. **基础与核心：已完成四平台 CI。** 系统目录、Unicode、POSIX 进程监督、MediaInfo 隔离探测、文件锁、原子写入、扫描、NFO 编码、备份恢复以及官方 Extension 生命周期。
2. **桌面业务：已完成目标系统验收。** 系统凭据、播放器参数、更新附件选择、系统链接、托盘与退出、WebKit 播放和隐藏取流。
3. **组件：按精确配方构建、校验并回读。** curl、MediaInfo、FFmpeg、MetaTube、Neutralino 按系统和架构独立发布 `deps-*`，不标为 Latest。配方未变时复用已验证组件。
4. **桌面与安装：三个 POSIX 目标手动 Actions 全部通过。** GUI 安全夹具验证下载、MP4/HLS 播放、Range、隐藏取流及取消；安装夹具验证便携启动、安装、覆盖安装和卸载保留数据。证据见 [完整桌面 CI](https://github.com/ddmoyu/javm/actions/runs/38398786888)。
5. **发布：本轮已获 Alpha 发布授权。** 标签流程等待 Windows 及三个 POSIX 目标成功，核对提交、组件指纹、附件哈希、桌面与安装记录，再生成下载表格和公开 Release。

## 开发与验证入口

- `.github/workflows/portability-checks.yml`：四平台核心和文件系统夹具，仅手动触发。
- `.github/workflows/desktop-posix.yml`：三个 POSIX 目标的组件、完整原生、凭据、网络、链接、GUI 和安装验证；允许手动及已授权 Alpha 标签流程调用。
- 新工作流未进入默认分支时，可手动运行 `release-alpha.yml`，选择 `desktop`；分支运行不发布 JAVM Alpha。
- POSIX 本地开发：`node scripts/third-party/posix/resolve.mjs`、`pnpm desktop:setup --verified-posix-host`、`pnpm native:build --release`、`pnpm build`、`node scripts/build-desktop.mjs --no-archive`、`node scripts/package-posix.mjs`。
- `--publish-missing` 只用于允许发布组件的环境。默认 resolve 只消费已有、配方匹配且验证通过的组件。
- 系统凭据、安装和 GUI 集成脚本只允许在隔离 CI 虚拟机运行。开发时不默认运行全量测试；新增用例按本轮范围验证。

## 实现约束

- POSIX 监督器仅管理它创建的进程组，保留 PID/PGID 身份，取消先 TERM 再 KILL；不会按名称全局结束程序。自行脱离进程组的守护进程不在该契约内。
- macOS 使用 Keychain，Linux 使用 Secret Service；不可用或锁定时明确失败，不回退明文存储。
- macOS 13 缺少 WKWebView 独立代理接口。隐藏取流无法复现应用代理或自定义会话时明确失败，HTTP 解析与下载仍使用现有代理链路。
- Linux 便携包与 AppImage 依赖 Ubuntu 24.04 的 GTK、WebKitGTK、GStreamer、Secret Service、ICU 等系统运行库；优先推荐能安装依赖的 DEB。
- macOS CI 使用 macOS 15 runner，编译最低目标为 13；这不等于已经在 macOS 13 真机运行。Linux CI 使用 Xvfb/X11，实际桌面环境体验需分别记录。

最新证据与未完成项统一记录在[支持核对](CROSS_PLATFORM_STATUS.md)。宿主补丁与分发边界见 [ADR 0033](decisions/0033-posix-desktop.md)。
