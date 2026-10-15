# 封面读取修复与安全验证

## 原因和范围

卡片原来把远程封面 URL 直接传给 WebView 的 `img`，不会使用应用配置的代理或来源页 Referer；没有 `onError` 或候选图切换。旧版 `origin/main:src-tauri/src/resource_scrape/commands.rs` 的 `proxy_image_to_file` 和 `rs_scrape_fused` 则在后台下载、检查图片，按候选顺序尝试，最终显示本地文件。

本次复用已授权的常驻 libcurl 和官方 Neutralino 文件挂载，不引入新工具或 WebView 宿主：

- 图片走共享 HTTP 队列、应用代理、实际浏览器 User-Agent 和来源页 Referer。最多 3 次重定向，单图 8 MiB、15 秒；候选最多 8 张，整轮最多 30 秒。卡片接近视区才请求，卸载及退出取消。
- 校验 HTTP 状态、响应类型和 JPEG／PNG／WebP／GIF／AVIF 文件头；浏览器最终解码失败继续下一张。HTTP 200 的 HTML 不会保存为图片。
- 缓存目录为本机 AppData 的 `JAVM/cache/image-previews-v1`，最多 256 张／96 MiB，7 天有效；失败地址短暂抑制 30 秒。通过来源地址与 Referer 的 SHA-256 定位缓存，不把番号或原地址写入文件名。
- JavBus 卡片兼容 `src`、`data-src`、`data-original`、`srcset`、`data-srcset`；详情保留大图链接、图片地址及列表缩略图。支持 HTTP 图片经后台加载，页面不直接发起混合内容请求。
- 现有 MetaTube 多种封面字段统一进入候选链。全部失败显示占位；截图及放大预览使用同一网络入口，预览准备期间显示进度并可取消。不会为整页卡片批量发起其他站点的番号搜索。

缓存时间戳单位按 [Neutralino 官方 filesystem 文档](https://neutralino.js.org/docs/api/filesystem/#filesystemgetstatspath) 的 Unix 毫秒读取。

## 本次验证

- `tests/cover-sources.test.ts`：17 项新增安全 mock，通过状态拒绝、HTML 伪图片、格式校验、多候选、缓存复用、缓存外部清理、取消退出、开发隔离及解析到 Film 的完整传递验证。
- 变更文件的 Vite+ 类型与静态检查；前端生产构建、Neutralino 桌面资源嵌入。
- `tests/fixtures/cover-images`：纯 Canvas 色块和固定 mock，CSP 禁止外站。通过浏览器验证正常图片、403 后备用、解码失败后备用、全部失败占位、放大预览及慢请求取消。三张成功图片的 `naturalWidth` 均为 240，没有裂图；截图留在 `.tmp/cover-safe-verification.jpg`。
- 未运行完整测试，未打开真实来源页面、加载真实封面或访问用户媒体数据库。真实图片 CDN 的实时可用性仍需用户在运行环境重试，不能把 mock 成功等同于全部来源均可用。

## 离线交付

- 新包：`dist/offline/JAVM-1.0.0-windows-x64-offline-20261011T031306Z.zip`，37,443,992 字节（约 37.4 MB）。
- SHA-256：`cff88cca0c6d2c0fb49624dc31d6c0965538ebfd39a7f455cdef2643fad3a113`。
- Release 原生构建、前端构建、Neutralino 资源嵌入及离线打包完成。包含已有 FFmpeg、curl、N_m3u8DL-RE、MetaTube、MediaInfo；WebView2 仍依赖系统运行时。
- `Verify-Package.ps1` 校验解包目录 76 个文件；独立 ZIP 流读取再次核验同一清单的 76 个大小及 SHA-256，并校验归档哈希。归档内为单一根目录，文件名使用 Windows 分隔符，验证时已规范化。
- 未启动生产应用进行真实内容验证，也未提交或推送工作区中其他变更。

## 后续修复：收藏刷新后本地图片消失

`NativeLibraryPort.mount()` 原来直接比较目录路径字符串。实测 Windows 路径中的反斜杠会被 Neutralino `server.getMounts()` 规范化为正斜杠，导致第二次刷新时同一目录被判为不匹配，`toFilm()` 随后过滤掉封面和截图。磁盘图片及数据库路径仍然存在；收藏、取消收藏和其他引发片库刷新的操作都可能触发。

目录比较现统一分隔符、末尾分隔符和大小写；确实不同的目录仍不复用挂载，目录外及含 `..` 的图片路径仍被拒绝。无需重新下载、重新收藏或迁移数据库。

- 新增 `tests/library-asset-mounts.test.ts`：修复前复现收藏后封面变为 `undefined`、截图变为空数组；修复后 3 项定向验证通过，覆盖收藏／取消收藏、重新打开详情、等价路径和挂载冲突。
- 新增 `tests/library-asset-mounts-native.integration.test.ts`：正式适配器连接真实 Neutralino 资源服务器，使用临时目录和安全 1x1 PNG；连续挂载刷新 3 次后，两张图片均返回 HTTP 200、正确类型和相同字节，1 项通过。宿主使用无窗口 cloud 模式，禁用扩展，不读取用户数据库或外网。
- 仅运行上述新增用例及修改文件的定向静态检查；前端构建和桌面资源嵌入用于生成单独 EXE 更新，没有重编译原生扩展或第三方工具。

## 后续优化：收藏复用预览缓存与并行补图

详情预览和收藏保存之前各自请求图片；收藏使用串行循环，且与预览请求的大小、超时等参数不同，不能依靠共享 HTTP 请求键避免重复下载。

- 将同一个 `ImageSourceService` 接入收藏图片服务。按图片地址及来源页查找已验证的缓存，优先在全部封面候选中寻找缓存命中，再用原生文件复制保存独立副本。复制与缓存淘汰／失效处理互斥，缓存消失、过期或来源页不同会返回未命中，不在缓存查询中联网。
- 未命中的图片使用最多 4 个处理任务并行下载、后台转换和写入，网络层仍保留总并发 4、同站点 2 的限制。来源顺序在提交时恢复，单图失败保留其他成功结果。
- 取消或致命失败后停止派发，等待全部在途任务结束才能清理；多个未确认停止的任务都保留重试句柄。退出时先停止收藏图片服务，再释放预览缓存。
- 本地图片按 256 KiB 分块读写，每块让出 UI；图片解码、缩放和 JPEG 转换继续在 Web Worker 执行。
- 新增 `artwork-preview-cache.test.ts` 和 `artwork-fetch-parallel.test.ts` 共 8 项安全 mock 验证通过：预览缓存全部命中时断网收藏仍成功且没有新增 HTTP 请求，跨块字节完整，缓存隔离／过期／外部移除、复制与失效互斥、退出、4 并发上限、乱序完成后顺序保存、部分失败、取消和多任务停止确认。未运行旧用例或全量测试，不接触真实图片、来源或用户数据库。
