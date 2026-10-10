# ADR 0010：保留 Neutralino 的视频资源查找

2026-10-10，已按用户授权接入。磁力搜索与磁力下载暂不开发。

## 决策

使用“番号＋来源 → 来源模板定位 → 隐藏 Neutralino/WebView2 → 捕获候选 → 结束实例 → HTTP 检查 HLS → 展示结果 → 用户选择下载”的流程。旧版默认来源模板作为配置数据迁移，不继续扩展通用 HTTP 网页解析。开发验证只使用本地安全 mock；迁移模板不代表已经验证真实网站兼容性。

主界面继续使用官方 Neutralino、React 和 Mantine。取流复用当前运行的 Neutralino 可执行文件，启动独立会话，不引入新的 WebView 库、浏览器安装包或 C++ 业务服务。

## 隐藏与生命周期

通过既有官方 `os.spawnProcess` 进程管理启动 PowerShell 监督器。监督器调用 Win32 `CreateProcess`，在创建时设置 `STARTF_USESHOWWINDOW/SW_HIDE`，挂起创建后先加入具有 `KILL_ON_JOB_CLOSE` 的 Job Object，再恢复主线程。Neutralino 同时配置 `hidden`、`skipTaskbar`、不保存窗口状态和不打开检查器。

独立 profile 与配置均位于本任务临时目录。监督器持有 Job 句柄并观察主应用 PID；正常结束、取消、超时或监督器结束时回收该浏览器进程树。TypeScript 等待进程回收并删除临时目录后，才把候选交给 HLS 检查。无法确认回收时保留清理操作，暂停后续取流，支持重试清理。

用户已接受 Neutralino 创建期可能短暂抢焦点，窗口不显示仍是硬条件。不会为交互验证、登录、失败或超时显示取流窗口。

## 资源捕获

独立实例先导航 `about:blank`，关闭原生 API、扩展、全局变量注入、日志和认证文件导出。通过 WebView2 内置 CDP 接口监听网络，在监听安装完成后才导航来源页。CDP 只绑定本机随机端口，端点从本任务 profile 的 `DevToolsActivePort` 读取，连接来源限制为主应用 origin。这里没有自建业务服务器或 stdin/stdout 业务协议。

同时识别请求地址中的 `.m3u8` 与响应 MIME 中的 HLS 清单；附加监听 iframe 和 worker 会话。对常见播放器只尝试静音播放控件，不点击任意链接。禁止默认下载、弹窗、图片和直接媒体加载；HLS 候选由外部受管 HTTP 请求进行小范围检查，不在界面播放网页。

最多一个取流任务运行，同时最多选择 5 个来源；每个隐藏实例工作截止 20 秒，HLS 检查保留 30 秒预算。候选上限 16、最多检查 3 个候选，网络观察上限 512 个请求与 16 个会话，HTTP 检查累计上限 32 次。网页解析和 HLS 解析的既有 Worker 继续复用。

## 结果与下载

应用级 `ResourceSearchService` 持有查询、来源选择、筛选和当前结果，页面切换不取消任务。重新查找会取消旧查询并隔离迟到结果；各来源独立展示排队、查找、检查、失败和重试状态。资源结果不依赖先获得影片资料，也不加载封面。

只有通过清单与小范围分片检查的候选才显示为已找到。复制提供 m3u8 地址；点击“加入下载”会再次检查链接，再调用现有 `DownloadService.add`。同一结果重复点击不会重复交接，现有下载队列继续负责跨查询的重复链接校验。

只传递实际观察到的公开 `Referer`、`Origin`、`User-Agent`；Cookie 与 Authorization 不导入、不交给下载器。使用代理取流时，后续 HLS 检查优先保持同一代理线路。依赖不可复现会话、登录或交互验证的来源返回失败，不以显示窗口方式处理。

## 验证与限制

见 [资源查找验证记录](../verification/2026-10-10-resource-lookup.md)。已验证安全跨域 iframe、无后缀 HLS、来源独立失败与重试、下载交接、超时、取消和带活跃任务退出。未访问真实内容站点，未验证 DRM、真实来源的登录 Cookie、所有播放器/跨进程 iframe 组合或发布包；不声称已完成真实站点兼容性验证。

参考：[Neutralino 配置与 WebView2 参数](https://neutralino.js.org/docs/configuration/neutralino.config.json/)、[CDP Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/)、[CDP Target](https://chromedevtools.github.io/devtools-protocol/tot/Target/)、[CDP Browser](https://chromedevtools.github.io/devtools-protocol/tot/Browser/)。
