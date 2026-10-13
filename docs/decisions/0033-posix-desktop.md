# ADR 0033：POSIX 桌面宿主与可验证分发

日期：2026-10-13。状态：已实施；[三个 POSIX 目标的完整桌面与安装 CI](https://github.com/ddmoyu/javm/actions/runs/38398786888) 通过。

## 决策

维持官方 Neutralino API 和 Extension 协议。平台服务、媒体探测及进程监督仍由既有 C++ 模块提供；不另建业务服务器或 stdin/stdout RPC。首发采用 macOS 13 双架构 APP/DMG 与 Ubuntu 24.04 x64 AppImage/DEB，同时提供便携包。

Neutralino 6.10.0 的全局脚本直接拼接单引号字符串，安装路径含单引号时无法初始化前端。POSIX 配方从锁定源码与 SHA 构建，使用 JSON 序列化替换这些拼接，并保留上游提交和补丁标识。该缺陷已用隔离 cloud 宿主和安全 Unicode 路径复现。

隐藏取流复用这个官方宿主和官方广播事件。专用 `--javm-isolated` 模式采用 WebKitGTK ephemeral view 或 WKWebsiteDataStore nonPersistentDataStore，不显示窗口、不复用应用 Cookie；页面不注入认证全局量或官方客户端，没有扩展及文件/进程 API。捕获脚本在顶层页面和 iframe 的文档创建时注入。专用 WebKit 消息通道只能向既有官方事件连接转发候选，不接受原生方法名；最多 128 条、每条 160 KB。这样不依赖网页 CSP 允许连接本机 WebSocket，也不新增业务服务器或数据库协议。页面消息视为不可信数据，候选、长度、协议和公开请求头继续受限。运行受 20 秒期限和既有进程监督约束。macOS 13 无独立代理接口时明确失败，不隐式改变用户的代理选择。

macOS APP 入口负责接收 LaunchServices 的 URL 事件，并通过新官方宿主的现有单实例队列转交。正常再次打开 APP 同样唤回主窗口；Command-Q 通过官方菜单事件进入任务异步收尾。Linux 使用 GIO 的当前用户协议关联，保持既有 Windows 注册表实现。

macOS 的可执行程序位于 `Contents/MacOS`，图标、许可和 MetaTube 组件记录位于 `Contents/Resources`。先签内部程序，再签外层 APP，随后执行深度严格校验。安装验证使用系统 `ditto` 复制 APP 并重新校验签名，覆盖安装和卸载不更改用户数据。

MediaInfo 在 POSIX 工作线程内建立 UTF-8 locale，避免其文件 API 在默认 C locale 下丢失中文路径。线程结束恢复原 locale，不改变其他线程的区域设置。

## 组件和发布证据

curl、MediaInfo、FFmpeg、MetaTube 和 Neutralino 各自记录系统、架构、最低系统、源码、配方指纹、文件清单与哈希。先保留当前构建拥有的草稿，构建后上传并回读验证，再公开组件；失败只清理本次拥有的草稿。组件 Release 使用 `deps-*`，不得标记 Latest。

完整桌面包消费精确匹配的组件。安装与桌面验证在隔离 CI 中使用合成数据，记录源码提交、GUI 结果、清单哈希和卸载保留数据结果。Alpha 汇总必须收齐 Windows 与三个 POSIX 目标的安装包、便携包和验证记录，失败时不公开不完整 Release。新增平台不修改既有已发布版本的附件。

## 验证边界

最低编译目标和 CI 运行系统分别记录。macOS 15 CI 不能证明 macOS 13 真机表现；Xvfb 不能证明所有 Linux 桌面环境的托盘与图形行为。未签名开发发行不等于已完成 Developer ID、公证或商店发行。

参考：[锁定宿主源码](https://github.com/neutralinojs/neutralinojs/tree/v6.10.0)、[官方 Extension](https://neutralino.js.org/docs/how-to/extensions-overview/)、[WebKitGTK 临时会话](https://webkitgtk.org/reference/webkit2gtk/stable/property.WebView.is-ephemeral.html)、[Apple 临时数据存储](https://developer.apple.com/documentation/webkit/wkwebsitedatastore/nonpersistent())。
