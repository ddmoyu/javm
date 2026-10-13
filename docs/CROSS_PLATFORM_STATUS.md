# 跨平台支持核对

更新：2026-10-13。已完成约定范围内的 macOS / Linux 开发适配，四平台基础检查和三个 POSIX 目标的完整桌面、安装验收均通过。开发产物版本为 `1.0.5-alpha.9`，尚未发布新的 JAVM Alpha。

| 范围 | 实现 | 验证证据 |
| --- | --- | --- |
| Windows x64 Alpha 4 | Setup、Portable、简洁更新日志和下载表格 | [已发布版本](https://github.com/ddmoyu/javm/releases/tag/v1.0.5-alpha.4) |
| 原生基础、官方 Extension、媒体文件层 | Windows、macOS 双架构、Linux x64 | [四平台核心 CI 全部通过](https://github.com/ddmoyu/javm/actions/runs/38375841919) |
| POSIX 组件 | curl、MediaInfo、FFmpeg、MetaTube、Neutralino 精确配方与独立 Release | [三个目标完整 CI 通过](https://github.com/ddmoyu/javm/actions/runs/38398786888)，组件发布后回读校验，配方一致时复用 |
| 系统凭据、网络与链接 | Keychain、Secret Service、系统证书、HTTP/CONNECT 代理及协议关联 | 同轮通过凭据读写与重启、证书拒绝、Linux 注册/解除、macOS 冷启动与运行中 URL 事件 |
| 桌面业务 | 实际下载与探测、Range、MP4/HLS、隐藏取流、托盘与退出 | 同轮真实 WebKit 通过；覆盖 iframe、CSP、Cookie 隔离、取消、关窗继续下载及 macOS 系统 Quit |
| 安装和发布汇总 | APP/DMG、AppImage/DEB、便携包及跨平台下载表格 | 同轮安装、覆盖安装、正常退出和卸载保留数据通过；发布汇总核对提交、组件配方与附件 SHA-256 |

完整桌面验证源码为 `c75d867825a96dc217af0da60dbd6b49e87afadd`。本轮没有运行历史全量测试；四平台核心与本轮新增的安全目标系统夹具分别验收。CI 的三个 `javm-development-*` 附件保留 14 天。

| 开发产物 | 实际格式 |
| --- | --- |
| macOS Apple Silicon | DMG、包含 JAVM.app 的 Portable ZIP |
| macOS Intel | DMG、包含 JAVM.app 的 Portable ZIP |
| Ubuntu 24.04 x64 | AppImage、DEB、Portable tar.gz |

## 已消除的主要平台限制

- 数据和缓存使用各系统用户目录；Windows 保留原 LocalAppData 布局。POSIX 路径保留大小写、反斜线、Unicode 与空格。
- 原生通信、数据库拥有者锁、文件身份、排序、NFO 编码、原子替换和 MediaInfo 动态库加载已提供平台实现。
- 媒体工具使用对应架构的无后缀程序，检查执行权限；POSIX 子进程通过已有官方进程 API 启动受管监督器。
- 下载、资料、刮削和 HTTP 解析入口已接入桌面能力判断；外部播放器支持 POSIX 程序与 macOS APP；更新服务按操作系统和架构选择安装包或便携包。
- 官方 Neutralino 6.10.0 的 POSIX 构建修复特殊路径的全局变量转义，并增加隐藏取流专用的临时 WebKit 会话。版本、源码 SHA、补丁和附件哈希均进入组件记录。

## 后续公开版本发布

收到新版本发布授权后，标签流程重新构建 Windows 和三个 POSIX 目标；全部成功后才合并附件并公开 Release。安装、桌面验证和附件清单必须来自同一源码提交，更新日志最后的下载表格只列出实际附件。现有 Alpha 4 保留原发布内容。

## 平台边界

- 首发最低系统：macOS 13、Ubuntu 24.04；macOS CI 实际运行在 15，Linux CI 使用 X11。未进行 macOS 13 真机、所有 Linux 桌面环境及不同 GPU 的验证。
- macOS 开发包只有 ad-hoc 签名，没有 Developer ID 或公证。
- macOS 13 的隐藏 WebKit 无独立代理接口；目前 POSIX 隐藏取流遇到应用代理或自定义请求头会明确失败。普通 HTTP 解析、播放传输及下载保留代理支持。
- macOS 系统链接声明随 APP 管理；应用内不能使用私有 API 强制注销。Linux 仅删除当前用户由 JAVM 创建的关联，不覆盖其他应用或删除系统安装的 desktop entry。
- AppImage 和便携包不捆绑整套桌面系统库，需要与 DEB 相同的 Ubuntu 24.04 运行依赖。
- 不包含 Android、Windows ARM64、Linux ARM64、RPM、字幕和音轨选择。

详细实施与命令见[适配计划](CROSS_PLATFORM_PLAN.md)。
