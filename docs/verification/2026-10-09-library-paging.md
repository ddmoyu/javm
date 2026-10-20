# 片库分页优化验证

日期：2026-10-09。范围见 [片库分页决策](../decisions/0010-library-paging.md)。所有数据库均位于仓库 `.tmp/library-query-*`，由测试生成，不使用真实媒体或用户数据库。

## 构建与自动测试

- `pnpm native:build`：通过，使用脚本发现的 MSVC 工具链构建真实 Extension。
- 原生查询新测试 6 项通过；既有媒体扫描 14 项、NFO 兼容 23 项通过。包含 50,000 条影片、1,001 位演员、旧字段兼容、尾页读取、自然排序、全部演员/分类关联、组合筛选、收藏 revision、查重、参数白名单和分页上限。
- `pnpm test`：105 项通过，65 项按环境条件跳过。服务与分页覆盖 16 项，包括最新查询与过期失败、缓存淘汰、随机末页、隐藏视图、失败重试、扫描状态竞态与收藏刷新。
- `pnpm build`：通过。构建仍报告超过 500kB 的 chunk 和依赖 `use no memo` 指令警告；本次不把构建成功等同于消除首载开销。
- 末次 `pnpm check`：210 个文件格式通过，类型检查被同时新增的播放窗口代码阻断：`frontend/src/platform/neutralino/playerWindow.ts:83` 的 `PlayerCommand.request` 报 TS2339。该文件不属于片库优化改动；本记录不宣称全项目检查通过。

原生相关测试复现命令：

```powershell
pnpm native:build
$env:JAVM_MEDIA_INTEGRATION = '1'
pnpm exec vp test run tests/library-query-native.integration.test.ts tests/media-native.integration.test.ts tests/nfo-native.integration.test.ts tests/library.test.ts tests/library-paging.test.ts
Remove-Item Env:JAVM_MEDIA_INTEGRATION
```

一次真实 Extension 请求计时样本：首屏 100 条 697ms，末页 offset 49,900 为 928ms，番号自然排序 215ms，首屏响应 85,186 字节。样本采集时其他验证并行运行，包含 IPC、SQL 和字段装配，不是隔离基准或响应时间保证。每次测试的原始结果保存在对应合成目录 `query-timings.json`。

## 浏览器交互

使用正式 App、LibraryService 和生产前端构建，通过测试专用 Vite 中间件连接真实 C++ Extension。夹具只允许 `.tmp/library-query-*` 目录，不允许接入真实应用数据目录；不扫描磁盘、不启动视频下载或播放。测试中间件不会进入正式构建。

1280×720 窗口中的实测：

| 操作                                        | 结果                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 首次加载 50,000 条片库                      | 只请求一页影片，每页上限 100 条；仅挂载 20 张海报卡片                                                 |
| 从首屏直接滚到末尾                          | 最后显示第 50,000 条，仍仅 20 张卡片；最终 offset 49,900，累计 3 次分页请求（含滚动过程中的中间位置） |
| 表格滚动至末尾                              | 挂载 15 行，实际行高与虚拟估算均为 72px                                                               |
| 加入 800ms 查询延迟、连续改搜索词并切换页面 | 导航仍可操作，最终只显示最新搜索结果，旧结果不覆盖                                                    |
| 按“配角独有”筛选                            | 命中第 50,000 条，次要演员关联参与查询                                                                |
| 首次从详情跳转演员作品                      | 显示对应的 50 部影片，首次挂载导航参数未丢失                                                          |
| 发现页翻至第二页、进入作品再返回            | 每页 50 项，返回保留第二页和演员位置；共 1,001 项、21 页                                              |
| 收藏范围内取消收藏                          | 影片消失，收藏总数减一；回到全部影片仍能找到该记录                                                    |
| 人为令下一次查询失败                        | 显示错误和重试按钮，显式重试后恢复正确结果                                                            |

重置长任务记录后，生产构建的海报首屏至末尾滚动和表格至末尾滚动都未观察到超过 50ms 的主线程任务。发现页从 100 项改为 50 项后，翻页与返回测试也未观察到此类长任务。

这不代表整个应用所有操作都低于 50ms：检查期间首次打开筛选约 51ms、视图切换约 55ms、打开详情约 63ms，首载也有约 50ms 的记录。已定位并减少卡片重复渲染、未访问页面同时挂载与单页维度条目过多的开销；这些首次挂载和复杂弹窗仍需继续性能采样，未作为全面无卡顿验收。

最终末页截图保存在本机 `.tmp/library-verification/library-50000.jpg`。截图内均为合成资料，缺少真实封面是测试夹具的预期行为。

浏览器夹具复现命令（先运行上述原生测试生成合成库）：

```powershell
$libraryFixture = Get-ChildItem -LiteralPath .tmp -Directory -Filter 'library-query-*' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
$env:JAVM_LIBRARY_FIXTURE = $libraryFixture.FullName
pnpm exec vp build --config tests/fixtures/library/vite.config.ts
pnpm exec vp preview --config tests/fixtures/library/vite.config.ts
```

访问 `http://127.0.0.1:5177/`。底部测试工具可模拟 800ms 慢查询、注入一次错误并查看分页/DOM/长任务计数；停止预览后可删除当前 PowerShell 会话的 `JAVM_LIBRARY_FIXTURE` 环境变量。

## 验证边界

前端影片缓存的 600 条上限由单元测试验证，不是进程堆内存的测量值；原生 SQL 查询自身仍可能处理全库数据。此次未用真实旧库、真实海报集合、NAS 或机械硬盘做规模验收，也未重新打包并运行桌面 WebView2 导入流程。
