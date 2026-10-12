# 隐藏验证的 PAT 401 诊断

日期：2026-10-11。代码适配器标识：`adapterRevision: 7`；本轮没有生成新离线包。

## 用户日志

版本 6 两次真实重试都停留在主文档 HTTP 403 的 `verifying` 阶段。20 次请求，5 个 Worker 已恢复，2 个页面已配置运行状态，脚本异常为 0。

- 唯一被统计为失败的子请求：Fetch／HTTP 401，来源分类为 `challenge`，发生在读取开始后约 1957／2069 毫秒。
- 一个 Fetch 取消：来源分类为 `other`，发生在约 2033／2203 毫秒；并非退出回收阶段产生。
- 两个客户端拦截：旧统计只记录数量，无法判断具体类型或是否属于验证依赖。
- 随后一直没有收到正常作品文档，最终按既有 20 秒总期限退出。

## 官方依据及结论边界

[Cloudflare 官方排障说明](https://developers.cloudflare.com/cloudflare-challenges/troubleshooting/challenge-solve-issues/#401-response-on-a-private-access-token-request) 明确：已知 `/cdn-cgi/challenge-platform/.../pat/...` 请求的 401 可以是 Private Access Token 不可用时的预期响应，之后继续普通验证，不能单独当成验证失败原因。

当前用户日志仅保留来源类别，不能确认该请求就是 PAT。Worker 已恢复与没有脚本异常也不等于挑战已通过。真实 403 的原因仍未确定；[官方支持范围](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/) 对嵌入式浏览器支持有限，生产挑战不支持自动化浏览器，但这同样不能单凭环境类型定位本次失败。

## 本轮代码调整

- 只对 HTTPS、无凭据、默认端口、作品同源或 `challenges.cloudflare.com`、匹配 PAT 路径的 Fetch／XHR 401 单独计数；查询参数中出现 PAT、相似域名、普通接口 401、PAT 端点其他状态均不忽略。
- 识别 PAT 401 后，仅排除同一请求随后的 `ERR_HTTP_RESPONSE_CODE_FAILURE` 重复诊断，真正的连接错误仍记录。
- 新增“隐藏作品读取验证统计”：`pat401Responses`、`blockedChallengeResources`、`blockedResourceTypes`。只输出数字和固定资源类型；不记录 URL、凭据、页面或脚本内容。
- 没有修改认证、代理、请求头、图片／媒体拦截、自动重试或时间上限；持续挑战仍会超时退出。此调整是诊断修正，不是已确认的 403 放行修复。

## 实际验证范围

- `pnpm test tests/avwiki-cancellation.test.ts -t 'PAT 与拦截诊断'`：新增 10 项通过，既有 12 项跳过。
- `JAVM_WEBVIEW_INTEGRATION=1 pnpm test tests/avwiki-cancellation-runtime.integration.test.ts -t 'PAT 401'`：新增 2 项通过，既有 3 项跳过。
- 真实 Neutralino／WebView2 宿主只使用 CDP 合成文档与 DNS 隔离；验证 PAT 401 后继续 403→200，以及 PAT 401 后持续挑战仍按期限退出。两次都没有原生窗口显示事件或可见窗口样本。
- TypeScript 类型检查、本轮 4 个 TypeScript 文件的 Vite+ lint 通过。

没有访问真实作品来源、Cloudflare 在线诊断页或用户数据库，没有执行完整回归、重建或打包。后续真实环境定位需要先与用户对齐其“验证只用安全 mock”的范围。
