# 数据库扩展

运行 `javm_database --version` 可检查 C++20 与 SQLite 的构建结果，不创建数据库。桌面宿主通过官方 Extension 协议启动 `javm_database --database <path>`，stdin 仅接收官方引导 JSON，后续使用 WinHTTP WebSocket 和宿主交换事件。

`src/store.hpp` 保存下载任务和设置，使用独立的 `downloads-v1.sqlite3`、修订号校验和 Windows 所有者锁。不兼容的现有数据库返回错误并保留。下载、重试、FFmpeg 调用与进程编排仍由 TypeScript 服务负责；该存储类不处理下载网络业务。

`src/host_lifetime.hpp` 从官方引导的本地端口识别宿主，持有进程句柄并监测异常退出。IPC 收尾超过 2 秒时结束扩展自身，避免继承的连接句柄使进程残留占库；正常 `close` 请求仍等待后台任务和数据库清理。

- 下载实现和边界见 [视频下载与合并](../../docs/decisions/0007-video-downloads.md)。
- 真实下载 SQLite 测试位于根目录 `tests/download-database.integration.test.ts`，由 `pnpm test:downloads` 执行。
- 媒体目录相关协议与数据库行为见 [目录扫描决策](../../docs/decisions/0006-directory-scanning.md)；其实现位于 `native/media`。

`neutralino.config.json` 已启用扩展；`pnpm native:build` 将 EXE 及运行依赖复制到 `bin`，供开发宿主和桌面打包使用。
