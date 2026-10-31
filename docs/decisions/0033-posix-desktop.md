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

2026-10-19 起，组件构建与发布迁入独立的 `third-party.yml`，按组件和平台逐项判断是否缺少发布。`desktop-posix.yml` 仅以读取权限下载、核对清单和哈希、运行安全验证；移除 `--publish-missing`，缺包时提示先完成独立组件工作流。指纹隔离及现有发布的精确迁移见 [ADR 0029](0029-third-party-releases.md)。

## 验证边界

### 2026-10-31：Intel macOS 窗口结构体返回修复

[Issue #14](https://github.com/ddmoyu/javm/issues/14) 报告 Intel macOS 启动时在 `window::getSize()` 崩溃。锁定的 Neutralino 6.10.0 在读取窗口 `frame` 及截图的 `contentRectForFrameRect:` 时，将返回 `CGRect` 的方法直接转为 `objc_msgSend` 调用；x86_64 的结构体返回需要 `objc_msgSend_stret`，否则隐藏返回指针会被误当作接收者。arm64 保留 `objc_msgSend`。

修复并入既有 `patch-neutralino.mjs`，对两个调用位置做精确匹配；上游实现变更时立即终止补丁，要求重新审查。新增编译用例使用 Clang 的 macOS 双架构目标检查实际生成的调用及 Intel 隐藏返回参数，不依赖 macOS SDK。组件的 macOS 验证改用隔离的空白本地窗口，执行尺寸、位置、移动、居中和缩放调用；应用打包后再次对便携包和 DMG 的实际宿主执行同一验证，记录到发布附件。Linux 仍使用 cloud 模式，不加载业务数据或在线内容。

只修改 Neutralino 专属配方输入，三个 POSIX Neutralino 指纹会更新，其余组件继续复用。后续分发必须先完成独立组件构建与验证，再由应用发布消费匹配产物；不修改固定迁移记录，不通过跳过前端窗口 API 隐藏故障。Windows 上的补丁和双架构编译检查不能替代 macOS 实机启动与窗口操作验收。

Windows 上的双架构编译检查、补丁拒绝检查及组件隔离检查已通过；真实 macOS 宿主与发布产物的验收结果在版本发布验证文档中记录。结构体返回入口依据 [Apple 运行时说明](https://developer.apple.com/documentation/objectivec/1456730-objc_msgsend_stret)，架构差异另由实际目标代码生成及 macOS CI 验证。

### 2026-10-31：Cocoa 协议空值保护

补充日志显示崩溃发生在 Touch Bar 枚举代理时的 `conformsToProtocol:` 查询。日志中的宿主 UUID 对应 1.0.16 的公开宿主，与 1.0.17 不同，因此不能据此认定 1.0.17 的窗口结构体修复失效；同时确认两版共有的协议注册风险仍需修复。

`objc_getProtocol` 对尚未注册的协议可以返回空值，而 [Apple 运行时的 `class_addProtocol` 实现](https://github.com/apple-oss-distributions/objc4/blob/main/runtime/objc-runtime-new.mm) 没有对应的协议空值检查，可能将空条目保存在类协议列表。macOS 宿主的四处协议注册统一经过空类、空协议检查，保留有效协议及原有方法；补丁对新增、缺失或重复注册位置拒绝继续。

新增专项编译运行实际注册辅助函数，验证空值与正常返回路径。macOS 组件及安装包验证在隔离空白窗口中加载仅用于测试的探针，检查三个代理类的协议列表，并主动执行完整协议遍历与可用的 Touch Bar 协议查询。探针避免使用 AppKit/WebKit 的 `@protocol` 引用，以免提前注册协议而掩盖故障；探针不随应用分发。该检查不等同于真实 Touch Bar 硬件验收，仍需报告者反馈。

按用户要求，本次先使用手动 `macos-issue14-test.yml` 生成 Intel 专项测试包，不递增版本、不创建标签或 Release。独立宿主任务生成带指纹和哈希的 Actions 组件附件；打包任务校验后替换固定 SHA256 的 1.0.17 基础包宿主，记录源码提交和宿主 UUID，使用独立应用名称及 bundle ID，移除测试包的 URL 关联。仅存放 Actions 附件，不进入更新渠道。此流程是明确的诊断重打包，正式应用发布仍严格消费已验证的组件 Release，缺包立即失败。

最低编译目标和 CI 运行系统分别记录。macOS 15 CI 不能证明 macOS 13 真机表现；Xvfb 不能证明所有 Linux 桌面环境的托盘与图形行为。未签名开发发行不等于已完成 Developer ID、公证或商店发行。

参考：[锁定宿主源码](https://github.com/neutralinojs/neutralinojs/tree/v6.10.0)、[官方 Extension](https://neutralino.js.org/docs/how-to/extensions-overview/)、[WebKitGTK 临时会话](https://webkitgtk.org/reference/webkit2gtk/stable/property.WebView.is-ephemeral.html)、[Apple 临时数据存储](<https://developer.apple.com/documentation/webkit/wkwebsitedatastore/nonpersistent()>)。
