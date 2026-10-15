# 发现作品访问失败安全验证

## 证据与范围

用户提供的进程日志多次出现 curl 35；开启代理后界面收到 HTTP 403。原来的错误处理只显示“来源暂时不可用”或混合的“验证或重定向”，不能区分网络握手、站点拒绝和没有作品。显示的演员名单来自随包 CSV 或缓存，不能作为作品页已经访问成功的证据。

技术参考：

- [curl 错误码](https://curl.se/libcurl/c/libcurl-errors.html)：35 表示 TLS 握手失败，具体原因需要进一步诊断。
- [MDCz AVWikiDB 适配](https://github.com/ShotHeadman/mdcz/blob/main/packages/runtime/src/crawler/sites/avwikidb.ts)：站点专用请求头与资料结构。
- [MDCz NetworkClient](https://github.com/ShotHeadman/mdcz/blob/main/packages/runtime/src/network/NetworkClient.ts)：带 Chrome 请求特征的 Impit 客户端。

这些代码差异支持完善请求适配，但不证明本次 403 的确切拦截规则。

## 变更

- HTTP 正常返回时继续原有解析。AVWikiDB 请求补充当前 WebView 的浏览器标识、来源和页面导航请求头。
- 仅作品页／详情 HTTP 403 触发一次隐藏浏览器兜底，沿用相同来源身份和代理。后台名单请求不启动浏览器。
- 共用既有隐藏 Neutralino 监督器与独立 profile；关闭图片、媒体、下载和弹出窗口，不自动点击验证。成功、失败、取消和超时均经过退出清理。
- 使用隔离环境生成页面快照，以 32768 字符分块传回，限制 UTF-8 正文最多 2 MiB，再送目录 Worker 解析。
- HTTP 401／403／重定向／429 与 curl 错误分别提示；不将失败展示成空作品，不记录页面正文、Cookie、代理地址或资源 URL。

## 定向验证

- `pnpm exec vp test run tests/avwiki-access.test.ts`：12 项通过。全部网络、文件和宿主由安全 mock 替换；覆盖 HTTP 优先、403 兜底后的作品解析、同一代理、持续拒绝、人工验证、跳转、大小限制、分块、取消、超时与清理所有权。
- `JAVM_WEBVIEW_INTEGRATION=1 pnpm exec vp test run tests/avwiki-hidden.integration.test.ts`：1 项通过。实际启动隔离的隐藏 Neutralino/WebView2，由 CDP 在请求阶段返回手写的合成文档，并禁止 DNS 解析和外部资源。正式 DOM 读取返回两条安全作品，受管实例随后退出。
- 本次 7 个 TypeScript 文件的定向 lint／类型检查通过。

未运行完整测试。没有请求真实站点、图片、视频或用户数据库；没有验证真实来源当前是否允许这条代理线路。人工验证和服务端持续拒绝仍可能使获取失败，此时隐藏实例会自动结束并返回明确错误。

## 自动检查重载修复（同日追加）

用户已确认尚未使用 `20261010T151513Z` 包重试，因此此前的 403 反馈不能作为隐藏浏览器仍被拦截的证据。

复查发现隐藏浏览器要求请求 URL 和 DOM 地址完全一致，会拒绝同一实体的临时验证参数和末尾斜杠规范化；另外，收到 200 响应头后立即读取 DOM，可能仍处于旧验证文档，重载还会销毁读取中的执行环境。这些属于可复现的客户端缺陷，不代表已确认真实站点此次采用了这些行为。

- 只放行同一来源、实体与页码的三个已知临时检查参数，继续拒绝跨来源、登录页、其他实体和未知参数。
- 按文档 loader 等待提交；自动重载期间重新创建读取环境、丢弃旧文档分块，其他错误仍立即返回。
- 日志增加隐藏文档的数字状态码和是否存在挑战标记，不记录 URL、token、响应正文或 Cookie。
- `pnpm exec vp test run tests/avwiki-access.test.ts -t '自动验证跳转修复'`：13 项新增安全 mock 通过，覆盖参数、文档提交顺序、分块中重载、创建环境时重载以及诊断脱敏；既有 12 项未运行。
- `JAVM_WEBVIEW_INTEGRATION=1 pnpm exec vp test run tests/avwiki-hidden.integration.test.ts -t '403 自动检查后重载'`：1 项新增实际隐藏 WebView2 合成流程通过：403 自动检查文档 → JavaScript 重载并附加临时参数 → 同实体 302 规范化 → 200 作品列表。全部文档由 CDP 提供，DNS 禁用，未连接真实来源；受管实例读取完毕后退出。

技术依据：[Cloudflare 的挑战响应标记](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)、[CDP 的页面提交事件](https://chromedevtools.github.io/devtools-protocol/tot/Page/#event-frameNavigated)、[CDP 的执行环境销毁事件](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#event-executionContextDestroyed)。隐藏浏览器的真实放行结果仍须与合成流程验证区分；[Cloudflare 官方兼容说明](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/)也没有保证嵌入浏览器或自动化环境能够通过生产验证。

## 隐藏读取超时定位（同日追加）

用户随后提供的日志显示，HTTP 403 后已启动隐藏监督器，其中两次约 20 秒退出，但没有隐藏文档响应记录。现有证据不能区分启动、控制连接、页面网络或验证等待，也不能确认用户启动的是哪个离线包。因此不把“超时”直接解释成站点验证失败。

- 宿主记录 `launch`、`connect`、`read` 三个阶段，附带 `adapterRevision: 3`；页面记录请求、自动验证、正文提取阶段。超时提示按最后已确认的阶段及响应区分。仍使用原来的 20 秒期限，不延长等待。
- 主文档响应允许用已关联的请求编号匹配，兼容 CDP `Network.responseReceived` 省略可选 `frameId` 的情况；无关请求不能成为主文档。主请求的 `Network.loadingFailed` 立即结束，只显示标准 `ERR_*` 错误码，不输出原始错误文本或 URL。
- 带 `cf-mitigated: challenge` 的 HTTP 200 继续等待验证，不作为作品正文读取。这些是可复现的客户端缺口，但尚未证明它们就是用户这次超时的原因。
- `pnpm exec vp test run tests/avwiki-timeout.test.ts`：11 项新增安全 mock 通过，覆盖响应关联、失败事件、错误脱敏及各阶段超时。8 个相关源码、测试和脚本的定向格式／lint／类型检查通过；未运行完整测试或扩展既有回归范围。
- 新增离线包宿主合成场景：实际使用打包后的 Neutralino EXE，文档全部由 CDP 返回，验证 403 自动检查重载后的作品提取。它与直接启动开发运行时的场景分开记录。
- `node scripts/test-hidden-catalog-host.mjs --system-temp`：以隔离的安全应用替换打包 EXE 的资源和配置，通过真实 Neutralino Native API 启动生产隐藏读取流程，系统临时目录下得到 `TEST-001`、`TEST-002`，随后完成退出。安全代理只拒绝连接、不转发，WebView 的预连接和背景探测均被本地拒绝，作品正文由 CDP 提供；没有连接真实来源。
- 同一宿主脚本的 `--proxy-probe --system-temp` 模式，仅放行 `https://www.gstatic.com/generate_204`，通过当前启用的本地代理收到 HTTP 204。该结果只验证隐藏宿主和当前代理的基础连通性，不返回作品、不证明真实来源的 403 或自动验证已经解决。

真实 AVWikiDB 的放行结果仍未验证。此次修改没有读取真实成人页面、图片、视频或用户数据库；下一次真实运行若失败，可用阶段日志继续定位，无需提供页面正文或截图。

交付包为 `JAVM-1.0.0-windows-x64-offline-20261010T155421Z.zip`（37,135,848 字节，SHA-256 `68733fa6df166204c2e3f86b2268a0f4ac8eafe2a632f3b10ebd70536cce784c`）。`pnpm desktop:offline` 完成；构建期间 310 个打包输入文件未变化。独立解压后随包校验脚本核对 76 个文件成功，8 个必需运行文件齐全；最新包 EXE 的新增“离线包宿主”合成场景 1 项通过，既有 2 项跳过。构建仍有前端块体积及第三方指令警告，未把构建成功视为真实来源验收。
