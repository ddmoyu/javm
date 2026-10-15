# 隐藏作品读取的 403 运行环境修复

日期：2026-10-11。适配器日志版本为 `adapterRevision: 5`。

## 复现与修复

使用真正的 Neutralino 隐藏宿主和系统 WebView2，所有文档与脚本由 CDP 返回安全合成内容，DNS 解析被禁用。未访问真实作品来源或数据库，也未生成截图、加载图片或视频。

| 问题                   | 修复前的运行证据                                                                                 | 修复                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 隐藏窗口暂停动画帧     | 合成 403 文档通过 `requestAnimationFrame` 重载时，期限内没有第二次文档请求，一直停留在 verifying | 使用 CDP `Emulation.setFocusEmulationEnabled` 维持主页面和跨域 iframe 的运行状态；不显示或激活原生窗口 |
| 图片通配符误拦脚本     | `/safe-check.js?hint=placeholder.png` 无法运行，合成验证持续等待                                 | `Network.setBlockedURLs` 改为按路径匹配的 URLPattern；保留 Image、Media、Font 类型拦截和全局禁图       |
| 人工验证直到超时才结束 | 旧逻辑只在正常 200 文档中检查验证控件                                                            | 带挑战标记的文档也只读取人工验证标志，不提取正文；检测到主文档的验证码或密码输入时结束                 |

单独添加后台计时／窗口遮挡相关 Chromium 参数不能恢复本机隐藏宿主中的动画帧，因此没有加入这些参数。CDP 页面运行状态设置已在本机 WebView2 验证；API 依据 [Emulation 协议](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Emulation.pdl)，路径拦截依据 [Network 协议](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-setBlockedURLs)。

跨域 iframe、专用 Worker 和共享 Worker 的安全样例均能完成。最初测试工具向 Worker 发送其不支持的 Fetch 命令，修正测试拦截层后通过；该失败不是业务代码故障。

日志新增 `activePages`（已配置运行状态的页面数）与 `scriptErrors`（异常次数）；不输出脚本异常文本、页面地址、Cookie 或内容。超时伴随脚本异常时显示对应原因。既有 20 秒总期限、请求数与会话数上限及进程回收保持有效。

## 定向验证

`JAVM_WEBVIEW_INTEGRATION=1 pnpm test tests/avwiki-challenge-runtime.integration.test.ts`：新增 7 项检查通过：

- 动画帧、带图片查询参数的脚本、跨域 iframe 与专用 Worker、共享 Worker：合成文档状态从 403 变为 200，并读取安全结果。
- 媒体路径及无后缀媒体请求仍被阻止，没有返回媒体字节。
- 人工验证自动结束；持续验证在测试的短期限内取消并回收实例，未重试文档请求。
- 每个实例均在原生进程恢复前安装窗口显示事件钩子，同时检查可见窗口；`ShowEvents=0`、`VisibleSamples=0`，收尾移除本次隔离目录。

本轮仅运行上述新增用例；旧超时测试的断言随“只读取人工验证标志”调整，未执行旧测试或完整回归。未重新构建原生模块或发行离线包。

后续按用户要求构建了 `20261010T171021Z` 离线包，并使用包内 Release 程序完成 17 项定向安全验证，详见[离线包交付记录](2026-10-11-offline-403-package.md)。

`pnpm exec tsc --noEmit`、本轮修改 TypeScript 文件的 Vite+ lint 及 `git diff --check` 均通过。

## 结论边界

已修复能够稳定复现的客户端阻塞，不能据此认定用户那次真实 403 已解决。[Cloudflare 官方文档](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/) 对嵌入式浏览器仅提供有限支持，并不支持自动化环境解决生产挑战。真实结果仍需用户在新构建上重试；不自动点击验证码、不导出会话 Cookie、不改变 TLS 校验，也不弹出验证窗口。
