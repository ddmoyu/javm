# 隐藏作品读取的请求取消处理

日期：2026-10-11。适配器标识：`adapterRevision: 6`。

## 用户日志能确认什么

用户在版本 5 的日志中报告：普通 HTTP 返回 403；隐藏浏览器收到带挑战标记的 403 后一直停在 `verifying`，约 20 秒后超时。20 次请求、5 个 Worker 均恢复、2 个页面已配置运行状态、脚本异常为 0；最后一次被统计为失败的子请求是 Fetch／`ERR_ABORTED`。

这些信息能确认自动验证没有完成，不能证明 `ERR_ABORTED` 导致验证失败，也不能证明 5 个 Worker 内部检查成功。[Chromium 的网络错误定义](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/base/net_error_list.h) 将 `ABORTED` 定义为操作取消；[CDP Network 协议](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Network.pdl) 另外提供 `canceled` 与 `blockedReason` 字段。

## 已复现并修正

- 超时会同时开始回收宿主，而读取循环每 200 毫秒检查一次。旧事件处理器仍可能收集退出期间的取消、脚本销毁等事件，随后把它们写进失败提示。现在信号取消后停止处理浏览器事件，诊断只保留取消前的事实。
- 主动取消与客户端拦截单独计数，不再覆盖真正的网络错误；同一请求的 HTTP 错误和传输错误不重复计数。请求编号与 CDP 会话一起关联，避免跨会话同编号误判为主文档。
- 自动重载取消旧主导航时，继续在原有期限内等待新文档；旧文档作废，真正的连接错误仍立即结束。取消后没有新文档仍超时退出，没有增加重试次数或延长期限。
- 超时提示分别描述“验证未完成”与期间记录到的异常，不再把最后一个取消当成超时原因。

新增“隐藏作品读取取消统计”日志：取消数、客户端拦截数、最后取消的资源类型／来源类别、距离开始读取的毫秒数，以及最后真实错误的来源类别／时间。来源仅取 `source`、`challenge`、`other`、`unknown`；不保存网址、查询参数、脚本或请求正文。每条日志不超过 8 个字段，避免日志清理器截掉诊断末尾。

## 定向验证

本轮仅执行新增用例，没有执行既有用例或完整回归：

- `pnpm test tests/avwiki-cancellation.test.ts`：12 项通过。修改前先执行最初 10 项，9 项失败，复现了退出事件污染、取消覆盖真实错误、重复计数及导航被提前终止等问题。
- `JAVM_WEBVIEW_INTEGRATION=1 pnpm test tests/avwiki-cancellation-runtime.integration.test.ts`：3 项通过。真正的隐藏 Neutralino／WebView2 使用安全合成响应和 DNS 隔离，覆盖 Fetch 取消后 403→200、持续挑战超时、真实连接错误不被后续取消覆盖。
- 真实宿主测试均观察到 `ShowEvents=0`、`VisibleSamples=0`，结束后回收宿主与隔离目录。
- TypeScript 类型检查及本轮 5 个 TypeScript 文件的 Vite+ lint 通过。

没有访问真实来源、显示图片视频或打开用户数据库。修复的是可复现的客户端错误；用户遇到的真实站点持续 403 仍未确认解决。

## 离线包

- 文件：`dist/offline/JAVM-1.0.0-windows-x64-offline-20261010T172559Z.zip`。
- 大小：37,424,777 字节，约 35.7 MiB。
- SHA-256：`a03a34a8cade139b5f33aab42d0fdaa6f2dc574eecdefa1d325613134c817c5e`。
- `pnpm desktop:build` 与离线打包完成；包含常驻 libcurl 和既有 FFmpeg、MediaInfo、curl、N_m3u8DL-RE、MetaTube 等工具及许可证。WebView2 仍沿用系统安装版本。
- ZIP 及包目录的 76 个清单文件哈希通过；8 个二进制未发现缺失导入或 Debug CRT；内嵌 69 个 JavaScript 文件与本次前端产物逐字节一致，包含适配器版本 6。
- 使用新包内宿主重跑本轮新增的 3 项取消处理安全场景，全部通过；没有运行既有或完整测试，也没有启动用户片库界面。

使用时从托盘彻底退出旧程序，完整解压新包并运行 `JAVM.exe`。失败时提供“隐藏作品读取网络统计”和“隐藏作品读取取消统计”即可继续定位；无需提供页面、图片、网址或 Cookie。
