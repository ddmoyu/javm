# 常驻 HTTP 与 403 客户端排查验证

日期：2026-10-11。只使用安全合成数据、内存 mock 和本地回环 HTTP 服务器；没有访问真实内容源、读取真实旧数据库、打开应用生产页面或展示媒体。

## 本轮实现

见 [ADR 0023](../decisions/0023-persistent-http.md)。普通请求通过官方 Extension 进入常驻 libcurl multi；业务缓存与限频留在 TypeScript。视频下载及独立播放器分片传输保留既有通道。

## 已完成的验证

- `pnpm native:build`：Windows MSVC Debug 原生构建成功，libcurl 8.22.0 静态链接、HTTP/HTTPS、Schannel，无外部压缩库链接。
- `pnpm exec tsc --noEmit`：类型检查通过。
- 本轮变更 TypeScript 文件的 Vite+ lint 通过；`pnpm build` 前端构建成功，仍有包体大小及第三方 `use no memo` 指令提示。
- `JAVM_HTTP_INTEGRATION=1 pnpm test tests/http-service.test.ts tests/http-native.integration.test.ts tests/http-extension.test.ts tests/http-browser-headers.test.ts tests/avwiki-http-workers.test.ts`：5 个新增文件、44 项检查通过。没有运行既有测试或完整测试集。

| 层级           | 实际证据                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 原生连接复用   | 同一 Extension 连续两次请求只建立 1 条 TCP 连接；第一次 `connections=1`，第二次为 0                                        |
| 原生取消与边界 | 活动和排队传输可取消；确认后输出文件可删除；未知长度超限返回 63，慢请求返回 28；通道断开时中止传输；未创建数据库           |
| 传输契约       | 403 不自动重试；受限重定向、Range、POST 和显式回环代理正确；不回传 Cookie；无效 UTF-8 与重复关键响应头不终止进程           |
| 调度与缓存     | 相同请求合并、订阅者独立取消、全局与同站并发、启动间隔、队列总量与排队超时、Retry-After、TTL、LRU 容量与排除私有／失败响应 |
| IPC 与退出     | 使用官方消息信封；停止失败保留重试句柄，退出确认后才删除；文件复制完成前不清缓存；日志不包含 URL／凭据／请求体             |
| 请求头         | 使用当前 WebView 标识与语言；按用途提供 Accept；调用方大小写无关覆盖，不生成重复 UA；只声明支持的 identity 编码            |
| 403 客户端     | 安全 CDP mock 中，共享 Worker 在网络限制配置后恢复，合成 403 自动检查可继续到作品提取；子请求失败只记录计数、类型及标准码  |

原有适配器的测试 mock 已随接口从 curl 参数改为 HTTP 请求对象，但按照工程约定，本轮未执行这些既有测试。

## 结论边界

上述证据验证客户端实现，不证明真实 Cloudflare 挑战会放行。用户日志只能确认此前停留在 verifying；共享 Worker 的缺失是本次查到的代码问题，尚不能确定为该次故障根因。没有尝试人工验证码自动化，没有调整 TLS 校验或展示隐藏页面。

本轮没有执行生产数据库、真实网络来源、桌面 UI、完整回归或离线包发行验收。
