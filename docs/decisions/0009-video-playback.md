# 内置视频播放

2026-10-09。按用户授权接入本地和网络播放，参考旧版的本地路径、HLS 与 Referer 行为。使用 Video.js 10 默认皮肤和控制条，不增加“打开本地文件”或“打开网络链接”表单。

## 函数入口

```ts
import { play } from "./platform/neutralino/playback";

await play("E:\\Videos\\movie.mp4");
await play("https://example.com/video/index.m3u8");
await play("https://example.com/media?id=123", {
  title: "影片标题",
  format: "hls", // 无扩展名且服务端类型不准确时可明确指定
  referer: "https://example.com/watch/123", // HLS 按需传入来源页面
});
```

`play(source, options?)` 自动区分本地绝对路径和 HTTP/HTTPS 直链，按已保存的播放偏好选择内置或外部播放器。内置播放在桌面端打开独立播放器窗口并尝试自动播放。返回的 Promise 表示播放源准备完成或外部程序已启动；解码、网络及自动播放策略造成的后续问题显示在播放器中。浏览器阻止自动播放时可直接点击默认播放按钮。地址校验或本地文件准备失败会拒绝 Promise，业务调用方应显示错误。

媒体库现有播放操作、详情中的影片与本地文件播放、已完成下载的播放按钮均调用同一个应用级入口。默认复用最近打开的窗口并替换视频；播放设置也可选择为不同视频新建窗口，保留其他视频。同一视频始终激活已有窗口并保留播放进度，不创建重复实例。从最小化状态传入视频会恢复并激活目标播放器。解码不支持时，可在播放设置中选择外部播放器后重新播放，路径留空时使用系统关联；网络地址的系统关联可能是浏览器。窗口模式、配置和续播规则见 [播放偏好](0011-playback-preferences.md)。

## 独立无边框窗口

按后续用户确认，桌面端通过官方 `window.create` 创建独立宿主窗口，设置 `borderless: true`，保留任务栏入口。窗口工具栏悬浮在视频上方，不再占用固定标题栏高度，保留最小化、最大化／还原、关闭和双击最大化。鼠标进入或移动时显示，移出播放器或静置 3 秒后淡出；拖动窗口和键盘操作工具栏期间保持可见，失去窗口焦点时隐藏。隐藏后不拦截鼠标，键盘聚焦可重新显示；遵循系统减少动画设置。

2026-10-10 按用户要求移除顶部“外部播放”和“重新加载视频”按钮，以及对应的窗口交接、强制重载接口和通信指令。

工具栏显隐只修改浮层属性，不随鼠标移动重新渲染 React 视频组件。绑定随组件卸载清理计时器和事件监听，兼容 StrictMode。拖动通过官方 `window.getPosition` / `window.move` 实现；跨过 4 像素阈值才移动，同时只保留一个原生请求和最新位置，避免快速拖动堆积 IPC。最大化时拖动先还原，按鼠标在工具栏的位置定位窗口。

主窗口持有 `PlayerWindowController` 并管理各窗口的独立会话，每个子窗口持有自己的实际 `PlaybackService`；同源 `BroadcastChannel` 传递有界指令与状态。创建 URL 仅包含随机窗口标识，文件路径、签名链接和 Referer 不放进命令行。子窗口使用主页面资源 origin，但原生 API 连接到自己的宿主端口。

播放器启动分支不加载主业务入口；创建参数显式禁用 Extensions，不初始化数据库、下载队列或托盘。关闭播放器按钮和 Alt+F4 都先取消播放、清理挂载及传输，再退出子宿主。关闭主窗口仍遵循原有托盘行为；显式退出应用先等待播放器收尾。启动超时、关闭中取消和清理失败会反馈，清理失败保留连接供再次关闭。心跳租约在主页面异常离开后关闭子窗口，休眠／后台计时器节流后重新等待心跳。

浏览器预览保留应用内浮窗；桌面主页面不再渲染第二个内嵌播放器。

## 播放引擎

- 锁定 `@videojs/react` / `@videojs/hlsjs-video` 10.0.1，使用默认 `VideoSkin` 和中文控件。
- 普通媒体使用 `Video`；HLS 使用官方 `HlsJsVideo`，支持 TS / fMP4 分片及 AES-128。采用该包实际依赖的 hls.js 1.6.7，不混用另一版本的 Worker。
- HLS 解封装在独立 Worker 中执行；前向缓存目标 30 秒、最大 60 秒，保留 30 秒后向缓存。
- 无扩展名链接先异步检查 Content-Type，再尝试有限前缀识别；不正确的服务端响应可由调用方的 `format` 补充。地址必须是媒体直链，播放器不解析视频网站页面。

## 本地文件与大文件

本地目录通过官方 `server.mount` 临时挂载，关闭或切换即卸载。视频文件使用 Service Worker 将浏览器的开放 Range 拆为最多 1 MiB 的有界请求，沿用官方资源服务，不另开 HTTP 服务器。

原因是 Neutralino 6.10.0 的文件读取实现会按 Range 的剩余长度分配缓冲区，`bytes=0-` 可能一次读取整个视频；仅检查 206 状态不能证明适合大文件。Service Worker 按流的消费速度读取，并处理取消，视频不会作为完整 Blob 留在内存。

开发页面或独立播放器页面与宿主端口不同源时，通过官方 `filesystem.readBinaryFile` 按 256 KiB 读取并传给 Worker，限制客户端库每次 Base64 解码量。普通视频位于磁盘/共享根目录时也走单文件分块读取，不挂载整个根目录。本地 m3u8 应放在独立目录中，以保留相对分片路径；不支持跨挂载目录的 `../` 分片引用。

Worker 只响应当前页面登记的随机媒体路径，最多保留 4 个并行读取通道，关闭会话后立即撤销映射并取消请求。Worker 重启时从当前页面取得资源信息，避免依赖 Worker 内存长期存活。

## 网络 HLS 回退与生命周期

通常由浏览器直接读取。遇到 CORS / 403 时，桌面端使用系统 curl 回退；显式指定 Referer 时直接使用原生传输。返回重定向后的地址，保留相对播放列表、分片、密钥与字节范围的解析基准。请求参数通过现有安全进程封装传递。

回退最多并行 3 个请求、排队 8 个请求，单响应最多 64 MiB；连接超时 10 秒，总请求超时 30 秒，同时尊重 HLS 加载器的超时。缓存保存在专属临时目录，发布版用官方资源挂载传输二进制，开发版按小块读取。关闭、替换及显式退出会停止请求进程、卸载挂载点并移除缓存；清理失败保留资源引用供下一次收尾重试。

应用服务独立于 React 挂载。组件卸载停止媒体元素，StrictMode 模拟卸载不会清空正在使用的 source。加载期间拒绝额外切换，避免无界排队；用户仍可关闭取消。

播放传输的取消使用官方 `os.updateSpawnedProcess(..., "stdInEnd")` 关闭监督进程输入，监督进程收到 EOF 后终止自己持有句柄的 curl 并回收输出管道。该通道仅传 EOF，不承载业务数据；避免强制结束外层 shell 时与 curl 启动形成竞态。取消方式按播放请求启用，既有下载执行方式不变；未能确认退出时保留重试清理能力并显示错误。

## 验证与范围

```powershell
pnpm check
pnpm build
pnpm test
pnpm test:playback
pnpm test:player-window
$env:JAVM_PLAYBACK_DEV = '1'
pnpm test:playback
pnpm test:player-window
Remove-Item Env:JAVM_PLAYBACK_DEV
```

`test:playback` 需要 Windows、已下载的 Neutralino 宿主与 FFmpeg（PATH 或 `JAVM_FFMPEG`）。它启动隔离的 WebView2 测试应用，禁用数据库扩展，不接触真实片库；临时 HTTP 服务只用于测试网络流。素材全部由 FFmpeg 合成，结果与截图保留在 `.tmp/playback-*/`。大文件用 NTFS 稀疏区构造，真实 H.264/AAC 数据位于 4 GiB 之后，不写入 4 GiB 的空白数据。

实测覆盖中文及特殊字符路径、大文件播放与拖动、本地 HLS、网络 MP4、HLS 重定向、TS / fMP4、AES-128、无扩展名、无 CORS、原生类型探测、字节范围分片和指定 Referer。每个播放样本都检查实际画面尺寸、播放进度、定位、暂停时定位、关闭后资源释放，另测缺失文件和慢请求取消。开发模式与生产构建均需通过。

容器和编解码器能力仍由 WebView2 / 系统决定，不代表所有 MKV、AVI、HEVC、TS 裸文件都可内嵌播放；不引入自动转码。多窗口同时播放已按后续授权实现；截图及站点登录/DRM 不在本次范围。尚未进行 NAS、真实长片、长期播放及安装包发布验收。

本机结果、耗时和验收边界见 [播放验证记录](../verification/2026-10-09-video-playback.md)。

参考：[Video.js 文档](https://videojs.org/docs/)、[官方 HLS 适配器](https://videojs.org/docs/framework/react/reference/components/hlsjs-video)、[Neutralino 窗口 API](https://neutralino.js.org/docs/api/window/)、[子窗口 CLI 参数](https://neutralino.js.org/docs/cli/internal-cli-arguments/)、[Neutralino 资源挂载](https://neutralino.js.org/docs/api/server/)、[Neutralino 6.10.0 文件读取实现](https://github.com/neutralinojs/neutralinojs/blob/v6.10.0/api/fs/fs.cpp)。
