# 隐藏 WebView 能力与库选型

本页保留选型与隐藏生命周期诊断的历史记录。后续已接入官方 Neutralino 的资源查找闭环，当前实现与验证见 [ADR 0010](../decisions/0010-resource-lookup.md) 和 [闭环验证记录](2026-10-10-resource-lookup.md)；文中的“尚未接入”和“后续验证”均指选型时点。

2026-10-10。当前目标是“番号与来源 → 对应资源页 → 隐藏 WebView 捕获 m3u8 → 关闭实例 → 检查链接”。旧版没有独立的番号 HTTP 取流实现，后续不继续扩展 HTTP 网页解析；已有 HLS 清单验证可以复用。

Neutralino 支持隐藏窗口配置。本机验证表明，6.10.0 的常规启动仍会产生窗口显示和前台焦点事件；显式使用 Win32 隐藏启动标志后，没有记录到窗口可见，但仍有一次前台焦点事件。

用户随后明确：抢焦点尽量解决，解决不了也可接受，窗口不显示是硬条件。因此当前选择保留官方 Neutralino，使用 `CreateProcess + STARTF_USESHOWWINDOW + SW_HIDE`，同时启用 `hidden` 与 `skipTaskbar`。不再把零焦点事件作为接入前提；下列 C/C++ 库保留为能力不足时的备选，暂不引入。

## 旧版入口

核对基线 `dd0e6b62b263258b6e78106c72017b3b470b4097`：

- `rs_find_video_links(code, site_id)` 将番号与来源交给 `open_video_finder_webview`。
- `build_site_url` 使用来源模板，将 `{code}` 替换为小写番号、`{CODE}` 替换为大写番号。它是直接定位资源页，并非先对任意网页执行通用 HTTP 提取。
- HTTP 来源解析器用于资料与磁力搜索；`analyze_single_hls` 接收已经知道的 m3u8。

依据：[取流命令](https://github.com/ddmoyu/javm/blob/dd0e6b62b263258b6e78106c72017b3b470b4097/src-tauri/src/resource_scrape/commands.rs#L2036-L2054)、[站点模板和 WebView 实现](https://github.com/ddmoyu/javm/blob/dd0e6b62b263258b6e78106c72017b3b470b4097/src-tauri/src/resource_scrape/video_finder.rs)。没有访问这些模板指向的网站。

## Neutralino 的配置与实测

[官方配置](https://neutralino.js.org/docs/configuration/neutralino.config.json/#modeswindowhidden-boolean)有 `modes.window.hidden: true` 和 `skipTaskbar: true`；CLI 对应 `--window-hidden=true`。

6.10.0 Windows 后端先创建窗口，并调用 `ShowWindow(SW_SHOW)`、`SetForegroundWindow`，上层在 WebView 初始化后才根据 `hidden` 调用 `hide()`，随后导航。底层窗口初始坐标在屏幕外，因此操作系统记录为可见不等于已观察到屏幕上的网页闪现。[底层构造](https://github.com/neutralinojs/neutralinojs/blob/v6.10.0/lib/webview/webview.h#L1285-L1310)、[上层隐藏与导航](https://github.com/neutralinojs/neutralinojs/blob/v6.10.0/api/window/window.cpp#L588-L675)

诊断脚本：[probe-hidden-webview.ps1](../../scripts/probe-hidden-webview.ps1)。使用独立目录、独立 WebView2 profile、本地文字页面 `DEMO-001`，关闭扩展与日志，不启动 JAVM 主界面，不访问真实数据库或内容站点。外部页面请求被限制到不可用的本机代理，只有本机地址绕过；脚本不接受外部 URL。页面仅写入场景标记，由页面或监督器结束进程。

| 启动方式 | 可见窗口采样 / 显示事件 | 前台事件 | 完成标记与正常退出 |
| --- | --- | --- | --- |
| .NET ProcessStartInfo，`CreateNoWindow=true`、`WindowStyle=Hidden`，Neutralino `hidden=true` | 有 / 有 | 有，事件发生时窗口可见 | 是 |
| Win32 CreateProcess，`STARTF_USESHOWWINDOW`、`SW_HIDE`，Neutralino `hidden=true` | 无 / 无 | 一次，事件发生时窗口不可见；轮询未采到它成为前台 | 是 |

Win32 的首次 ShowWindow 会受启动信息控制，符合[微软说明](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-showwindow)。这解释了两种启动方式的差异。两次运行最终的前台窗口均与开始时一致，退出后未发现属于这两个 profile 的 Neutralino / WebView2 进程。

### 焦点问题

创建期的 `SetForegroundWindow` 是已定位的主动激活调用。`SW_HIDE` 能控制首次显示，不能消除这个独立调用。`WS_EX_NOACTIVATE` 也不能可靠阻止主动激活；[微软文档](https://learn.microsoft.com/en-us/windows/win32/winmsg/extended-window-styles#ws_ex_noactivate)明确指出仍可用 `SetForegroundWindow` 激活这种窗口。

从源头消除这次调用的办法是在 Neutralino Windows 宿主创建窗口时识别隐藏模式，跳过显示和前台激活；这需要维护和构建修改后的宿主，尚未实施或验证。当前没有找到仅靠官方配置就可靠消除焦点事件的办法。按用户的新要求先保留这个已知限制，不采用全局锁定前台或抢回焦点的方式干扰用户操作。

### 隐藏生命周期补测

补测使用挂起创建，在恢复主线程前设置目标 PID 与事件观察，避免漏记窗口创建初期事件。窗口轮询每 10 毫秒执行一次，并监听该 PID 的 SHOW 和前台事件；焦点事件只记录，不作为失败条件。

| 安全 mock 场景 | 可见窗口采样 / SHOW 事件 | 前台事件 / 前台采样 | 退出结果 |
| --- | --- | --- | --- |
| 正常完成标记 | 无 / 0 | 1 / 有 | 页面正常退出 |
| 无候选标记 | 无 / 0 | 1 / 有 | 页面报告 `no_candidates` 后退出 |
| 页面持续等待 | 无 / 0 | 1 / 有 | 20 秒到期，监督器结束本任务进程树 |

三次运行最终前台窗口均与开始时相同；按本次 profile 路径检查，未发现遗留 Neutralino / WebView2 进程。报告分别保存在：

- `.tmp/hidden-webview-d9ad0a85053e42a28582475220fccaf7/report.json`
- `.tmp/hidden-webview-9566df36a8274bf38cc66c51810da4e7/report.json`
- `.tmp/hidden-webview-ef15d153199b49568431856e53df20e8/report.json`

复现命令，三个场景应逐个运行，避免相互影响焦点观察：

```powershell
powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File scripts/probe-hidden-webview.ps1 -Launch win32 -Scenario success
powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File scripts/probe-hidden-webview.ps1 -Launch win32 -Scenario no-result
powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File scripts/probe-hidden-webview.ps1 -Launch win32 -Scenario hang
```

宿主 SHA-256：`1B3F87C0DD1B53015F8B33AAE17EA2FA806CCEBA18AFE2737B9F522438ED043D`。本次没有截图，也没有捕获或播放视频；这些结果只证明安全本地页的窗口生命周期，未验证取流、权限弹窗、跨域 iframe、媒体静音或真实站点兼容性。生产进程启动器尚未接入这里的 Win32 启动方式；当前实现仅在诊断脚本中。

## C 与 C++ 候选

| 方案 | 从创建起隐藏的依据 | 获取资源链接 | 适用判断 |
| --- | --- | --- | --- |
| `webview/webview` 0.12.0，MIT，C/C++ | 传入自己创建且从不 ShowWindow 的 HWND。Windows 后端仅在 `m_owns_window` 为真时显示、聚焦顶层窗口；默认传空句柄会显示窗口 | 可通过 `webview_get_native_handle(...BROWSER_CONTROLLER)` 获取 WebView2 controller，再订阅原生网络事件 | 如官方能力不足，优先考虑的轻量备选；使用独立进程，不替换主界面的 Neutralino |
| `saucer` 8.0.5，MIT，C++ | Win32 创建使用的标准样式不含 `WS_VISIBLE`，`show()` 是独立操作 | 稳定原生接口暴露 `ICoreWebView2_2*` 与 controller | 备选；功能与 C++ 依赖面比本次小型取流宿主更大 |
| Microsoft WebView2 Win32 SDK | 自建隐藏 HWND，并在导航前将 controller 的 `IsVisible` 设为 false | 官方请求、响应事件和脚本注入 API | Windows 专用实现最直接；需要自行管理 COM、消息循环、权限和退出 |
| CEF | `SetAsWindowless` 与 `windowless_rendering_enabled` 明确支持无浏览器窗口渲染 | `OnBeforeResourceLoad`、`OnResourceResponse` | 功能充足，但需分发与维护 Chromium，不作为本次首选 |

源码与 API：

- [webview 0.12.0](https://github.com/webview/webview/blob/0.12.0/core/include/webview/webview.h)：原生窗口参数、controller 句柄、Windows 构造中的所有权判断。嵌入已有 HWND 前需要 STA COM 初始化；窗口与消息循环的生命周期由调用者负责。
- [saucer 窗口创建](https://github.com/saucer/saucer/blob/v8.0.5/src/win32.window.cpp)、[窗口样式](https://github.com/saucer/saucer/blob/v8.0.5/private/saucer/win32.window.impl.hpp)、[WebView2 原生接口](https://github.com/saucer/saucer/blob/v8.0.5/include/saucer/modules/stable/webview2.hpp)。
- [WebView2 可见性与关闭](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller)、[资源响应事件](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_2#add_webresourceresponsereceived)。仅设置 controller 隐藏不会隐藏父 HWND，两者必须分别控制。
- [CEF 无窗口配置](https://github.com/chromiumembedded/cef/blob/master/include/internal/cef_win.h)、[请求处理](https://github.com/chromiumembedded/cef/blob/master/include/cef_resource_request_handler.h)。

另外查了 WebUI。它有 `webui_set_hide`，但当前源码的外部 Chromium 启动分支使用 headless 参数，Windows 内嵌 WebView2 分支仍直接 `ShowWindow`。不能仅凭这个 API 名称把它当作已确认的隐藏 WebView 方案。[声明](https://github.com/webui-dev/webui/blob/main/include/webui.h)、[实现](https://github.com/webui-dev/webui/blob/main/src/webui.c)

上述第三方库仅完成文档与源码核对，没有安装、编译或运行。推荐顺序是本项目判断，尚不是兼容性测试结果。

## 后续最小验证范围

先将已验证的 Win32 隐藏启动方式接入受管 Neutralino 子进程，再验证官方脚本注入和结果回传能力。独立会话、静音、禁止弹窗和默认下载需在导航前配置；不以 `CreateNoWindow` 或启动后再 `hide()` 代替创建期隐藏。

验证输入为虚构番号 `DEMO-001`，通过本地来源模板定位 mock 页面，页面延迟发起合成 m3u8 请求。检查捕获成功后退出、无候选到期退出、取消、父进程退出回收，以及全程不显示。焦点事件记录为已知限制，不阻塞接入。最多一个取流实例、工作截止 20 秒，不能靠显示窗口完成人工验证。

若官方接口在脚本时机、跨域 iframe 或资源捕获上仍有已证实的缺口，再验证原生备选。该情况下原生部分仅负责 WebView 与网络事件，番号定位、排队、候选筛选和 HLS 验证保留在 TypeScript。原生请求过滤应使用支持 request source kinds 的新接口；旧 `AddWebResourceRequestedFilter` 存在 iframe 覆盖限制。[官方说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2#addwebresourcerequestedfilter)

正式取流宿主尚未接入，本次没有增加原生依赖或修改 C++ 构建，也没有运行全量检查、构建或回归测试。
