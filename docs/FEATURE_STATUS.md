# JAVM 功能开发状态

2026-10-10，按代码提交 `369658e` 的正式界面、应用服务、原生接口及现有验证记录核对。媒体库、扫描、下载、播放、基础刮削和视频资源查找已经接入；图片管理、文件整理等功能仍有缺口。原型交互和早期计划中的未勾选项不作为当前实现状态。

本次是静态核对，没有运行测试、构建或发布，也没有启动应用、读取用户媒体库或访问真实内容源。已有测试结果以各功能验证记录的执行范围为准。

**已接入的主要功能**

| 模块 | 当前实现 | 依据 |
| --- | --- | --- |
| 媒体库与作品模型 | SQLite 分页、搜索、筛选、排序、作品收藏、资料编辑；作品、视频、NFO 独立建模；支持无视频收藏、后补视频与一作品多资源 | [作品与资源 ADR](decisions/0021-metadata-first-library.md)、[LibraryService](../frontend/src/services/library/LibraryService.ts) |
| 扫描与迁移 | 后台目录扫描、增量重扫、自定义扩展名、MediaInfo、NFO；0.5.3 数据转换、双库备份、失败保留与旧记录归档 | [扫描 ADR](decisions/0006-directory-scanning.md)、[迁移实现](../native/media/src/legacy_import.cpp) |
| 片库清理 | 重复视频与广告文件规则检查、逐项删除或清除资料、共享文件保护 | [清理 ADR](decisions/0019-library-maintenance.md) |
| 下载 | 视频直链、VOD HLS、独立音视频轨合并、暂停续传、失败重试、任务持久化、下载后入库与刮削交接 | [DownloadService](../frontend/src/services/downloads/DownloadService.ts)、[刮削 ADR](decisions/0020-metatube-scraping.md) |
| 播放 | 本地及网络视频、HLS、独立播放窗口、窗口复用或多开、外部播放器偏好、自动保存与恢复播放进度 | [播放 ADR](decisions/0009-video-playback.md)、[进度 ADR](decisions/0015-automatic-playback-progress.md) |
| 资料刮削与 AI | 内置 MetaTube 按需启动、搜索与详情、单片及批量任务、封面落盘、规范 NFO 写回；单个 OpenAI 兼容接口的识别、翻译与连接测试 | [刮削 ADR](decisions/0020-metatube-scraping.md)、[AiService](../frontend/src/services/metadata/AiService.ts) |
| 视频资源查找 | 统一按番号／片名搜索并合并影片；详情内隐藏取流，即时追加去重链接及分辨率／时长；来源统计持久化并调整优先级；复制与下载前复检。本次仅定向检查和新增 mock 验证，未做桌面回归 | [取流 ADR](decisions/0010-resource-lookup.md)、[资源服务](../frontend/src/services/streamResolution/ResourceSearchService.ts) |
| 发现页 | 五类离线名单、分页与本地作品关联、目录增量更新、头像来源兜底与持久缓存；开发模式使用安全虚构数据 | [发现页 ADR](decisions/0022-avwikidb-discovery-navigation.md) |
| 设置与运行 | 主题、网络代理、下载及播放偏好、可选关闭到托盘、任务退出清理、统一日志与日志导出；Windows 离线包构建脚本 | [主服务装配](../frontend/src/app/mainView.tsx)、[Settings](../frontend/src/features/settings/Settings.tsx)、[打包脚本](../scripts/package-offline.mjs) |

**尚未完成的功能**

| 功能 | 具体缺口与现状 | 代码或范围依据 |
| --- | --- | --- |
| 影片详情中的资源列表 | 详情的资源页始终显示空状态，排序控件没有结果可排序。搜索页已有可下载结果，但尚未按作品保存并回显到详情，重启也不恢复搜索结果 | [FilmResources](../frontend/src/features/films/FilmResources.tsx)、[ResourceSearchService](../frontend/src/services/streamResolution/ResourceSearchService.ts) |
| 截图与封面编辑 | 视频抽帧、长截图、独立获取图片、手动选择或裁剪封面、清空及删除截图未接入。现有图片查看和刮削自动保存封面已经实现 | [FilmArtworkEditor](../frontend/src/features/films/FilmArtworkEditor.tsx)、[FilmDetail](../frontend/src/features/films/FilmDetail.tsx) |
| 发现页维度收藏 | 演员、导演、制作商、系列等收藏只更新 React 内存中的 Set，重启丢失，旧维度收藏未接回此入口。影片本身的收藏已经持久化 | [Discover](../frontend/src/features/discover/Discover.tsx)、[旧记录归档约定](decisions/0021-metadata-first-library.md) |
| 视频文件整理 | 重命名、移动、跨卷操作恢复、普通影片的单资源删除入口、离线路径批量重关联尚未形成业务流程。已有手工关联视频、移除纯资料作品和重复／广告候选清理 | [LibraryService](../frontend/src/services/library/LibraryService.ts)、[影片菜单](../frontend/src/features/films/FilmMenu.tsx)、[文件操作计划](REFACTOR_PLAN.md#文件与数据库操作) |
| 片库健康检查与目录监听 | 尚无独立健康检查流程，也未接入目录变化监听及自动增量扫描。已有手动扫描、重扫、缺失资源状态和重复／广告检查 | [维护模式](../frontend/src/contracts/maintenance.ts)、[扫描入口](../native/media/src/scanner.cpp)、[模块计划](REFACTOR_PLAN.md#四-功能模块迁移清单) |
| 实体别名管理 | 名单可以读取已有别名；跨语言实体归并、人工合并、屏蔽错误关联、规范名称维护及旧别名业务恢复尚未实现。名单中文名称的补译与校对也是待完成的数据工作 | [CSV 读取](../frontend/src/services/catalog/avwikiCsv.ts)、[名单说明](../data/catalogs/avwikidb/README.md)、[模块计划](REFACTOR_PLAN.md#四-功能模块迁移清单) |
| 进阶资料刮削 | 现有 MetaTube 多来源候选查询最终采用一个匹配详情；尚无应用级字段多源融合、来源评分与冲突策略、独立站点资料适配、自动重试退避、复杂分卷识别和字幕关联流程 | [ScrapeService](../frontend/src/services/scraping/ScrapeService.ts)、[后续范围](decisions/0020-metatube-scraping.md#后续范围) |
| STRM 与资料批量导出 | 独立资料目录和规范 NFO 写入已完成；STRM 生成／导入、面向已有作品的批量 NFO 导出／整理尚未接入 | [作品与资源 ADR](decisions/0021-metadata-first-library.md)、[模块计划](REFACTOR_PLAN.md#四-功能模块迁移清单) |
| 下载的附加能力 | 多语言音轨选择、字幕下载与合并、已有任务或成品的改名流程未接入；当前下载器显式丢弃字幕轨 | [ToolDownloadEngine](../frontend/src/services/downloads/ToolDownloadEngine.ts)、[下载 ADR](decisions/0007-video-downloads.md) |
| 多 AI 供应商与自动兜底 | 当前仅保存一组地址、模型和密钥；尚无多供应商优先级与失败轮换，也未将 AI 识别作为批量刮削的自动兜底 | [AiService](../frontend/src/services/metadata/AiService.ts)、[番号识别](../frontend/src/services/scraping/identity.ts) |
| 深度链接与主应用单实例 | 尚无协议注册、冷启动链接分发、已有主实例唤醒与参数转发。播放器的窗口复用不能替代主应用单实例 | [启动器](../native/launcher/main.cpp)、[主应用入口](../frontend/src/app/mainView.tsx)、[模块计划](REFACTOR_PLAN.md#四-功能模块迁移清单) |
| 应用更新与发行安装流程 | 检查更新按钮禁用；前端资源／整包更新、失败回退、安装器和签名流程未接入。已有便携离线包脚本，不等于自动升级已经实现 | [Settings](../frontend/src/features/settings/Settings.tsx)、[发行计划](REFACTOR_PLAN.md#十七-打包发布与回退) |

建议先补齐资源结果在详情中的回显和维度收藏持久化，再接截图、文件整理与健康检查；多源融合、别名管理和更新流程按后续范围分别推进。本清单不授权开发这些功能。

**已经实现但仍有验收边界的部分**

- 资源查找的定向用例与安全桌面 fixture 已通过；桌面 fixture 的下载末端是 mock。真实来源模板可用性、站点会话和播放器兼容性尚未验证，不能据此宣称所有来源可下载。取流期间可能短暂抢焦点是用户接受的现有限制，窗口不显示仍是要求。
- 下载、刮削、作品关联各有定向验证；新增取流、实际下载器、刮削和入库尚未在同一安全桌面样例中完成整链验收。后续仍应使用安全样例和 mock，不接入真实成人内容源。
- 0.5.3 迁移用合成数据库验证；新作品模型和本轮取流加入后的完整发行包、干净 Windows 环境、NAS／慢盘与长时间托盘队列尚未全面验收。旧离线包的验证记录不能覆盖后加功能。

**明确暂缓或已调整的范围**

- 磁力搜索及相关交互按用户要求暂不开发；内置 BT 引擎、DRM 和显示登录／验证窗口不属于当前取流范围。
- 番号定位沿用旧版来源模板与隐藏 Neutralino。通用 HTTP 解析器及 HLS 校验保留，但没有独立的纯 HTTP 番号检索链路；按本轮决策不把它列为必须补做项。
- 仅迁移 0.5.3；旧下载／刮削任务与暂未支持的数据归档保留，不自动恢复执行，也不补建开发期媒体 schema 的升级链。
- 旧版使用统计上报没有迁移；是否保留仍需产品决定，不默认重新加入数据采集。macOS/Linux 发行也不属于 Windows 首期交付。
