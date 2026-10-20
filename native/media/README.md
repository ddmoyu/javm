# 原生媒体扫描

实现约定见 [目录扫描 ADR](../../docs/decisions/0006-directory-scanning.md)。

MediaInfo 从锁定的官方源码编译，保留格式解析器并裁剪未使用附加功能；构建、打包校验和格式回归见[精简 MediaInfo](../../docs/decisions/0014-lightweight-mediainfo.md)。

`scanner.cpp`：后台目录枚举、有界线程池、增量扫描与进度；`probe.cpp`：MediaInfo 独立子进程、音视频轨与时长、超时与取消；`probe_service.hpp`：下载探测的独立有界队列，经官方 Extension 的 `media.probe` / `media.cancelProbe` 调用；`nfo.cpp`、`nfo_encoding.cpp`、`nfo_fields.cpp`：有限读取、编码兼容、pugixml 解析与字段归一；`store.cpp`：SQLite 事务、旧库备份迁移、资料合并和原始 NFO 快照。`work_queue.hpp` 同时供原生 Extension 的异步媒体请求调度使用。

1.0 媒体库为 `library.sqlite3`、schema 1，作品、视频资源和 NFO 独立存储，支持无视频刮削及后补视频。`store_library.inc` 管理作品与关联，`store_scrape.inc` 安全写入 NFO，`legacy_import.cpp`/`store_import.inc` 单独迁移 0.5.3。仅迁移器读取旧结构，不保留开发期升级链；详见 [数据模型 ADR](../../docs/decisions/0021-metadata-first-library.md)。

并发按 `max(1, min(逻辑处理器数 - 2, 16))` 自动计算，不提供手动设置；文件等待队列上限 64。逻辑处理器数通过 `std::thread::hardware_concurrency()` 读取，读取失败或不超过 2 时使用单并发。每个探测子进程使用独立 MediaInfo 句柄，不跨线程共享解析器。

```powershell
pnpm native:build
$env:JAVM_MEDIA_INTEGRATION = '1'
pnpm exec vp test run tests/nfo-native.integration.test.ts tests/media-native.integration.test.ts tests/library.test.ts
```

媒体集成测试需要本机 FFmpeg，仅用于生成虚构的 2 秒纯色视频；应用扫描和独立 NFO 测试不依赖 FFmpeg。可用 `JAVM_FFMPEG` 指定测试工具路径。测试库与视频只写入 `.tmp/media-integration-*`，NFO 样本写入 `.tmp/nfo-fixtures-*`，不会访问用户数据库。`javm_database --nfo-inspect <path>` 是只读诊断入口，输出解析结果或错误，不打开数据库。
