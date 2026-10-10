# MediaInfo 附加功能裁剪验证

2026-10-10。范围见[精简 MediaInfo 决策](../decisions/0014-lightweight-mediainfo.md)。本轮保留格式解析器，只关闭 `LIBCURL`、`LIBMMS`、`EXPORT`、`GRAPHVIZ` 和 `TRACE`。

## 产物

| 指标             |      原版 |    精简版 |
| ---------------- | --------: | --------: |
| DLL 字节数       | 8,564,120 | 6,008,832 |
| DLL 大小         |  8.17 MiB |  5.73 MiB |
| ZIP 内压缩字节数 | 3,588,842 | 2,579,180 |
| ZIP 内占用       |  3.42 MiB |  2.46 MiB |

DLL 减少 29.84%。精简 DLL SHA-256：`a94ddcf3f61156d02306348ecaa017fd85b091d377b5a7e623d58c0808a00069`。

- 运行包：`dist/offline/JAVM-1.0.0-windows-x64-offline-20261010T014246Z.zip`。
- 大小：34,505,784 字节，32.91 MiB；74 个清单文件，另有清单文件本身。
- ZIP SHA-256：`02d183609e175097138518062e5529bedc3b7b3b95e6994615cf17a61136a252`。
- 解压运行 `JAVM.exe`，继续使用系统 WebView2；其他依赖工具保留。

此包以此前验证的 `JAVM-1.0.0-windows-x64-offline-20261010T011330Z.zip` 为底包，只替换 MediaInfo DLL，添加构建凭据、ZenLib/zlib 许可证及裁剪说明。底包 SHA-256、所有文件校验和变更白名单均经过检查，来源记录在新包 `package-manifest.json` 的 `basePackage` 中。没有读取正在运行的程序目录中的个人数据，没有修改已交付的旧 ZIP。

工作区的 MetaTube、播放进度和数据库迁移代码在本轮中另有修改，整体检查尚未全部通过，所以这些变化未纳入本次依赖更新包。构建流程已更新，后续 `pnpm native:build --Release` 和标准离线打包会持续使用精简 MediaInfo。

## 通过的验证

- `pnpm native:build --Release`：MSVC x64 Release 构建成功。源码使用官方未修改的 26.10 AllInclusive 包；CMake 缓存中只有上述五个 MediaInfo 功能显式关闭，其余保持默认。
- `llvm-readobj --coff-imports`：精简 DLL 仅导入 `KERNEL32.dll`，未引入额外运行时 DLL。
- 新增格式回归：22/22。21 个合成音视频样本与一个无效输入，在当前原生程序及最终包内原生程序上分别验证；所有输出字段均与官方原版 DLL 一致。裸 AAC/ADTS 的未知时长与原版一致，未改变探测策略。
- 下载回归：`pnpm test:downloads`，82/82；覆盖本机 HTTP/HLS、分轨合并、媒体探测及任务控制。完整 FFmpeg 仅生成合成素材，被测工具为包内精简 FFmpeg/curl 和新的 MediaInfo DLL。
- `pnpm build`：前端构建通过，保留既有大 chunk 与 React Compiler 指令提示；本次交付仍采用底包内原有前端。
- `pnpm test:offline`：74 个文件大小及 SHA-256 一致；中文/空格目录、仅系统 PATH 下启动成功；确认系统 WebView2、构建凭据、实际 MediaInfo 音轨探测、隔离数据库初始化与设置持久化，退出后两库完整性通过。
- `git diff --check`：通过；本轮更改文件的格式检查通过。

最终解压验证目录：`.tmp/离线 验证-94a20bed/`。构建与测试日志在 `.tmp/mediainfo-trim/`，分别为 `build-final.log`、`formats-final.log`、`package-formats.log`、`download-tests.log`、`package-smoke.log`。

## 全量检查的边界

- 09:40 的 `pnpm check` 在其他 MetaTube/播放模块及其测试中发现 10 个格式问题；之前不检查格式的运行还发现对应 API 修改后的类型问题。本轮没有修改这些模块。
- 09:40 的全量 `pnpm test`：186 通过、95 跳过，播放进度旧测试 7 项失败。
- 当前工作区原生扫描/NFO/片库测试：43 通过，2 项旧迁移用例失败，涉及 schema 期望 4 而实际为 5，以及 `playback_progress` 表已存在。这些迁移代码未包含在本次底包更新中。
- 不宣称当前整个工作区已通过验收，不把本次格式样本测试当作所有文件、真实 NAS、大型片库性能或 Windows 10 的完整验收。

本轮没有提交、推送或发布 GitHub Release。
