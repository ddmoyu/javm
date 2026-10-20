# ADR 0023：通过官方 Extension 承载常驻 libcurl

- 日期：2026-10-11
- 状态：用户明确授权实现

## 问题与范围

发现名单、作品页和未命中缓存的头像原来各启动一个 curl.exe。头像并发和页面切换会产生大量启动、退出、停止记录；进程数量不等于作品接口的重试次数。CLI 退出后无法跨请求保留连接池。

将普通 HTTP 传输移入现有 `javm_database.exe` 的独立网络模块和线程，仍通过 Neutralino 官方 Extension 收发消息。HTTP 分支不初始化数据库。保留原来的前端技术栈、后台运行和明确退出语义，不添加服务器、自定义标准输入输出协议或新的运行时依赖。

迁移的调用方为发现名单与作品、头像和索引、MetaTube／AI JSON 请求、资源解析与 HLS 校验、资料图片、刮削封面以及代理测试。文件下载继续由下载器处理。独立播放器通过 `--enable-extensions=false` 创建，其视频分片和跨域回退仍使用既有播放通道，本次不改动多窗口架构。

## 传输与调度

- `native/http` 静态链接与离线依赖清单相同版本、相同 SHA-256 的 libcurl；复用已缓存源码。仅启用 HTTP/HTTPS，使用系统 Schannel 校验证书。不依赖外置 curl.exe 完成普通请求。
- 一个长期存活的 `CURLM` 和网络线程管理连接、DNS 缓存与 TCP keepalive。全局最多 4 个活动传输，每主机最多 2 条连接，空闲连接缓存最多 16 条，复用连接的空闲时间不超过 60 秒。
- TypeScript 应用级调度最多 4 并发、同 origin 最多 2 并发、同 origin 请求启动至少相隔 300 ms，等待队列最多 64 项。同一请求最多 64 位订阅者。
- 单次超时包含 TypeScript 排队时间。429／503 按 Retry-After 让同站后续请求退让 1～60 秒；不自动重试。
- 每个请求明确传入代理。空值代表直连，忽略进程环境里的代理与 NO_PROXY。连接和缓存不会跨不同代理错误复用。
- 请求体最多 1 MiB、响应体最多 64 MiB、累计响应头最多 64 KiB、请求头最多 32 项。调用方继续使用更小的业务上限。未知 Content-Length 的流在传输期间也受限。
- 响应正文直接写有界临时文件，前端只收到状态码、有限白名单响应头、字节数、耗时和新建连接数。畸形 UTF-8 响应头返回错误；关键头重复交由解析层拒绝。不回传 Cookie 值或原始错误正文。

## 请求头兼容性

默认采用当前 WebView 的 User-Agent 和语言列表，按页面／图片／JSON 用途设置 Accept。来源指定的头以大小写无关方式覆盖默认值。作品页另外保留 Referer、Sec-Fetch-Dest、Sec-Fetch-Mode、Sec-Fetch-Site 和 Upgrade-Insecure-Requests。

不硬编码过时浏览器版本、不伪造登录 Cookie 或客户端提示。内置构建没有压缩库，默认只声明 `Accept-Encoding: identity`。补齐请求头不等于实现浏览器 TLS 指纹、JavaScript 或站点验证会话。

## 缓存、取消和退出

图片适配器显式开启短期 GET 文件缓存和相同请求合并，最多 32 MiB／64 项，TTL 上限 5 分钟并受 Cache-Control max-age/Age 限制。键包含 URL、代理、完整请求头及传输约束。作品和名单继续由现有业务服务缓存，手动刷新会真实请求。

有 Authorization、Cookie、Range 或请求体的请求不共享缓存。403、挑战标记、非 200、传输错误、Set-Cookie、私有／禁止缓存、Vary:* 和有歧义的关键响应头均不缓存。LRU 淘汰文件；缓存只在当前应用运行期间存在。现有头像持久缓存继续生效。

淘汰文件删除失败时保留清理所有权，阻止继续传输积累临时文件；下次请求与退出时重试清理。调用方复用输出路径时允许覆盖先前失败响应的文件。

每个订阅者可独立取消；最后一位取消时才发送 `http.cancel`。原生移除 easy handle、关闭输出文件并结束原请求后，返回停止确认。停止未确认时保留临时文件和可重试句柄，阻止新传输；退出时再次确认，不能假装已经取消。

显式退出先停止业务调用方，再清理 HTTP 服务，等待原生请求和文件复制完成，清除缓存与监听器。隐藏主窗口不关闭连接池。官方 Extension 通道断开时原生线程中止所有传输并退出。

## 403 排查的结论与边界

用户日志表明隐藏浏览器已经连接并收到 `403 + cf-mitigated: challenge`，随后停留在 verifying 超时。换成 libcurl 不直接解决网站验证。

本次修复一个客户端问题：自动附加调试器后，`shared_worker` 原先未被配置和恢复执行；现在与普通 Worker 一样先设置网络限制，再恢复。新增只含计数、资源类型及标准错误码的失败统计，区分验证脚本／XHR／子文档失败与客户端主动屏蔽图片。适配版本为 4。保持全程隐藏、禁止图片媒体、20 秒总预算和失败自动退出。

mock 能证明上述客户端行为，不能证明真实来源使用了共享 Worker，也不能证明它是用户此次 403 的原因。没有访问真实内容源，没有绕过人工验证码。

## 依据与验证

- [libcurl multi](https://curl.se/libcurl/c/libcurl-multi.html)、[跨请求连接复用](https://everything.curl.dev/transfers/conn/reuse.html)
- [CDP 自动附加](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-setAutoAttach)、[恢复等待调试器的目标](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-runIfWaitingForDebugger)
- [Cloudflare 挑战响应标记](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)、[浏览器支持边界](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/)
- [本轮隔离验证记录](../verification/2026-10-11-persistent-http.md)

## 图片分道限流（2026-10-12）

影片详情的封面和预览图加载很慢。原因是所有请求共用一套限流：全局 4 个、每站 2 个、同站两次起始间隔 300 ms。同一图片站点的 20 张图至少要排队 6 秒以上，原生 libcurl 层同样是总数 4、每站 2 个连接。

现在按用途分道：`artwork` 和 `portrait` 走图片道，全局 8 个、每站 6 个、不设起始间隔；网页、资料、取流等其他请求保持原来的全局 4 个、每站 2 个、间隔 300 ms，不增加目标站点的风控风险。两道的站点计数互不占用。调用方传入自定义限流参数但没有给出 `images` 时，图片沿用网页的参数（测试即按此保持原有语义）。原生层把总并发提高到 12（与两道之和对应），每站连接数提高到 6，连接池保留 24 个；分道细节仍由 TypeScript 队列控制。

2026-10-13：头像业务层的并发上限由 4 调整为 6，与图片通道的单站上限一致。移除固定槽位轮转，改为共享名额空闲后立即接续下一张，避免慢请求占用一个槽位时其他空位无法利用。最多两个批次共享这六个名额，等待队列最多六项，取消批次会立即移除尚未开始的任务；保留每批最多一百项、Worker 每次五十项、缓存复用与退出清理。
