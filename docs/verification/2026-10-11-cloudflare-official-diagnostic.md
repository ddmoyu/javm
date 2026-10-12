# Cloudflare 官方安全诊断与隐藏宿主端口修正

日期：2026-10-11。代码适配版本：`adapterRevision: 8`。

## 范围与方法

用户明确回复“允许官方安全诊断”，授权使用同一隐藏 Neutralino 浏览器及应用代理访问 `https://debug.challenges.cloudflare.com/`。本轮未访问真实作品来源、读取用户媒体数据库或显示网页图片，没有操作验证控件。

- 使用上一离线包的 `javm-win_x64.exe`（Neutralino 6.10.0），系统 WebView2 `154.0.4258.62`，应用已保存的 HTTP 回环代理。
- 沿用正式配置、隐藏进程启动器、隔离 profile、Worker 恢复与页面运行配置；关闭图片、媒体、额外窗口及下载。
- 手工诊断脚本额外限制为官方诊断、挑战和官方文档列出的 DNS 探测域名；一次观察 30 秒，进程硬期限 44 秒。业务总期限仍为 20 秒，没有延长。
- Win32 显示事件钩子在子进程恢复前安装，持续采样窗口可见性；诊断后关闭所属 Job 并删除隔离 profile。只保存脱敏文本和数字，未保存 Cookie、验证令牌或截图。
- 初始诊断脚本的通配符格式错误导致两次启动在导航前结束；修正诊断脚本后才进行以下有效对照。这两次不是官方网络失败或验证通过证据。

## 观察结果

| 条件 | 原生 webdriver | 官方诊断 | 原生窗口显示 |
| --- | --- | --- | --- |
| 原启动参数，安全隔离空白页 | true | 不访问网络 | 0 |
| 非零调试端口，安全隔离空白页 | false | 不访问网络 | 0 |
| 原启动参数，官方诊断 | true | Automated Browser Detected | 0（306 次可见性采样） |
| 非零调试端口，官方诊断 | false | 四项检查通过 | 0（307 次可见性采样） |
| 修正后的正式启动器，官方诊断 | false | 四项检查通过 | 0（307 次可见性采样） |

修正后的四项结果为：未检测到自动化、系统时钟同步、未检测到隐私工具干扰、可以连接 Cloudflare。诊断主文档及挑战 iframe 均为 HTTP 200，4 个 Worker 均恢复，脚本异常为 0，Cookie 支持已开启。

官方页面仍显示 `Turnstile Status: loading`。同时观测到 PAT 401、一个 404、请求取消和 `ERR_CONNECTION_CLOSED`；诊断域名白名单也拦截了一个样式请求和一个 Other 请求。没有完整挑战通过证据，不能把“四项诊断通过”当作实际验证放行，也不能由这些子请求状态单独确定余下原因。

本轮确认的是一个本地启动配置问题，不是所有 403 的唯一原因。真实作品来源是否放行仍待使用新包重试。

## 修正

Chromium 对调试端口 0 设置自动化标志，见 [MDN 的 webdriver 说明](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver)。对照试验只改变端口分配方式，未注入或覆盖 `navigator.webdriver`、UA 等属性。

`hiddenProcess.ps1` 现在先用系统分配非零回环端口，在启动前写入本次临时配置；随后核对 TCP 监听 PID 属于本次 Job，再通过无代理、禁止重定向、有限响应大小的本机 HTTP 请求发现 CDP 端点。返回端点需匹配本机地址、所分配端口和固定路径，并再次验证所属 Job，才原子发布给前端。端口竞争或未知进程不会被连接，仍受原有期限和退出清理约束。

普通 libcurl 请求、代理设置、媒体拦截、窗口隐藏及业务重试次数均保持原行为。PAT 401 的独立诊断继续保留；[Cloudflare 官方说明](https://developers.cloudflare.com/cloudflare-challenges/troubleshooting/challenge-solve-issues/#401-response-on-a-private-access-token-request) 指出这种响应本身不代表验证失败。

## 验证

- 新增 `tests/hidden-debug-port.integration.test.ts`：真实隐藏宿主使用 DNS 隔离与 CDP 合成数据，主页面及跨域子页面验证原生状态，模拟 403 → 200 后正常读取；1 项通过，同时确认窗口从未显示及 profile 清理。
- 两次隔离空白页端口对照、三次有效官方诊断均结束并清理。
- PowerShell 语法解析、新增测试和配置文件的定向 Vite+ lint 通过。
- 未运行既有回归或完整测试，没有真实来源验收。诊断页结果只代表本次浏览器和代理条件。

本机脱敏原始记录位于 `.tmp/cf-official-baseline.json`、`.tmp/cf-mock-port-zero.json`、`.tmp/cf-mock-port-explicit.json`、`.tmp/cf-official-explicit.json`、`.tmp/cf-official-launcher.json`，不纳入发行包。

## 离线包

- 文件：`dist/offline/JAVM-1.0.0-windows-x64-offline-20261010T180547Z.zip`，37,427,059 字节。
- SHA256：`1c83aa5cbc3c90638c511d41c17bf3091f13f5d30f3c69c8cfdade673b9546b9`。
- 包含适配版本 8、前一轮 PAT 401 诊断修正、常驻 libcurl 及原有 FFmpeg、MediaInfo、curl、N_m3u8DL-RE、MetaTube 第三方工具；WebView2 仍使用系统已安装运行时。
- 执行前端构建与桌面资源打包；未改动原生服务源码，沿用与上一已验证包 SHA256 相同的 Release Extension、MediaInfo 二进制，没有无关原生重编译。
- 目录与 ZIP 内 76 项清单文件逐项校验通过，8 个 EXE／DLL 没有缺失导入或 Debug CRT，69 个嵌入式 JS 文件与本轮构建完全一致，并确认端口修正、适配版本 8 与 PAT 统计已嵌入。
- 新包宿主再次执行本轮新增的 1 项安全集成用例并通过；未启动真实用户库界面，没有运行完整回归。
- 构建存在既有大文件分块和 React 编译指令提示，不影响本轮构建成功。
