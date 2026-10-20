# 统一资源搜索与刮削设计

日期：2026-10-09。用户已确认本方案；当时只调整交互原型，正式服务按后续 ADR 接入。

2026-10-12 清理：独立原型已移除。本文保留已确认的交互决策和调研记录，当前实现以 [功能开发状态](../FEATURE_STATUS.md) 和后续 ADR 为准。

## 确认的交互

- 左侧仍叫“资源刮削”，页内只保留“搜索资源”和“批量刮削”。输入番号或片名后，同时查影片资料、磁力和在线视频，不再先匹配影片、跳页、重新寻找链接。
- 搜索采用两层结构。第一层直接列出全部匹配影片，不能默认展开第一部或把其余影片藏进候选下拉框。每项展示小封面、番号、片名、演员、年份、时长、评分、厂商、入库状态和已返回的磁力／在线视频数量；支持按入库状态过滤、相关度／发行年份／番号排序与分页。
- 同一影片先按规范化番号合并，再过滤、排序、分页及计数；大小写、分隔符、数字前导零不产生重复项。片库与站点命中汇总到同一张卡片，保留来源列表与标题别名，优先展示已关联的片库资料，不因名称相同就合并不同番号。原型的重复“特别篇”占位样本改为同番号的不同来源资料，另外保留四部独立的未入库作品。
- 点击整项进入第二层：同页展示完整影片资料、可放大的封面、六张可连续浏览的截图以及下载资源。资料包含演员、发行日期、导演、厂商、系列、分类、分辨率、来源和原始名称；已入库影片按需补全或编辑，未入库影片也有完整搜索资料。返回保留关键词、筛选、排序、页码、列表滚动和原项焦点，支持上一部／下一部连续浏览。
- 资源区提供全部／磁力／在线视频筛选、画质筛选和排序，展示名称、画质、大小、可用性和来源。每部影片独立缓存来源状态和资源；仅按当前页预取资源，进入详情复用结果，避免为几千部影片同时展开全部资源。正式 provider 分页与限流仍需后续实现。
- 下载资源按内容标识合并，来源名称、条目标识或展示文件名不同不重复列项。当前原型识别 40 位十六进制 BTIH，忽略磁力的名称和 tracker 参数；在线视频按 URL 合并，忽略片段标识但保留查询参数。不同 hash／地址保留为不同资源，不按片名、画质或相似文件名误合并。合并后汇总来源，保留稳定条目标识和已知做种数；正式接入的完整磁力规范化仍按后续实现方向处理。
- 精确番号只返回对应影片；从片库详情的“查找更多资源”进入时，已知目标可直接打开该影片的搜索详情。无影片资料但识别出番号时，仍可进入资源区。磁力做种数未知显示“未知”，不能按零处理；做种数也不保证实际可下载。
- 常用下载操作直接展示；复制、查看来源、重试来源放到右键和可见更多菜单。查询、筛选与结果在切换批量页、查看详情后保留。
- “补全资料”按需打开窗口，默认勾选缺失字段并保留已有资料。资料搜索与资料写入分开；搜索本身不改片库，也不开始下载。
- 各来源独立返回、独立报错和重试。元数据没有匹配结果时，已经找到的资源仍可查看与处理。新查询取消旧查询，停止搜索保留已到达结果。
- 批量刮削保留独立队列，默认只补元数据，不自动扩展成批量下载。
- 沿用暖黑／酒红／玫红与浅色主题，采用紧凑桌面列表；不添加大标题、介绍卡片、页尾宣传文案、通知中心或媒体库多选。

## 后续实现方向

1. TypeScript 定义资料、在线视频、磁力三类 provider，统一结果和来源状态。来源搜索限流、超时、取消与失败退避独立处理，查询代次隔离迟到响应。
2. 起步采用少量 HTTP 来源适配器；可选连接外部 Torznab 服务，不强制捆绑 Jackett、Prowlarr、Python、.NET 或 PostgreSQL。
3. 动态网页的视频链接仍保留 WebView 提取路径。Neutralino 宿主的实际窗口、会话隔离、脚本注入和资源拦截能力须先验证，不能将原型等同于已有可用实现。
4. 磁力按规范化 infohash 去重并保留多个来源；BTIH 十六进制／Base32、BTMH 等不同表示需要正式实现时明确支持范围，不能只按展示标题合并。
5. 初期支持复制磁力或显式发送到外部下载器；“已发送”仅代表交接状态，不展示成应用正在托管的真实下载进度。后续可通过 qBittorrent Web API 接入认证、添加任务和状态同步。
6. DHT 爬虫不是实时关键词搜索接口：先获取 hash 和元数据、建立索引，才能按番号检索。自行维护 DHT 索引不纳入初期桌面应用，可选接入外部 bitmagnet 的 Torznab 端点。

## 开源调研备忘

以下为 2026-10-09 的公开仓库快照，属于实现参考，不表示已经验证各站点可用。版本和活跃状态后续开发时须重新核实；借鉴代码前单独评估许可证兼容性。

| 项目                                                                        | 当时的版本／最近活动                                                                                                       | 可借鉴内容与边界                                                                                                                                                            |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Jackett](https://github.com/Jackett/Jackett)                               | [v0.24.2806](https://github.com/Jackett/Jackett/releases/tag/v0.24.2806)，2026-10-08；最近提交按北京时间为 10-09；GPL-2.0  | 每站适配器、Cardigann 规则与统一 Torznab 输出。关注 `IIndexer.ResultsForQuery`、`ReleaseInfo` 的大小、做种、hash 和磁力字段。适合作为可选外部服务或适配模式参考。           |
| [Prowlarr](https://github.com/Prowlarr/Prowlarr)                            | [v2.6.5.5623](https://github.com/Prowlarr/Prowlarr/releases/tag/v2.6.5.5623)，北京时间 2026-09-17；最近提交 10-04；GPL-3.0 | 来源成功／失败状态、退避、限流、缓存搜索结果与下载交接。所查看的搜索服务使用 `Task.WhenAll`，按 Guid 去重；本项目的渐进呈现与 hash 去重是自己的设计，不是照搬其已实现行为。 |
| [qBittorrent search-plugins](https://github.com/qbittorrent/search-plugins) | 最近提交北京时间 2026-10-07，属于文档图标维护；GPL-2.0                                                                     | `jackett.py` 并发查询索引器，解析磁力／下载 URL、大小、做种数和日期。最近提交不证明所有搜索引擎都可用；不把 Python 插件运行环境加入当前技术栈。                             |
| [bitmagnet](https://github.com/bitmagnet-io/bitmagnet)                      | v0.10.0，2025-03-02；最近提交 2026-05-21；MIT                                                                              | DHT 采集、元数据分类、自有搜索索引与 Torznab 输出。仍标注 alpha，原生安装也需要 PostgreSQL；更适合作为可选外部服务。                                                        |

源码定位：

- [Jackett：统一索引器接口](https://github.com/Jackett/Jackett/blob/d734f69053190410b0b763331cb4f844781b842b/src/Jackett.Common/Indexers/IIndexer.cs)、[结果字段](https://github.com/Jackett/Jackett/blob/d734f69053190410b0b763331cb4f844781b842b/src/Jackett.Common/Models/ReleaseInfo.cs)。
- [Prowlarr：来源状态与退避](https://github.com/Prowlarr/Prowlarr/blob/3c6e1d97ac485a70cc9d4063dd5d17af7a77584d/src/NzbDrone.Core/ThingiProvider/Status/ProviderStatusServiceBase.cs)、[搜索调度](https://github.com/Prowlarr/Prowlarr/blob/3c6e1d97ac485a70cc9d4063dd5d17af7a77584d/src/NzbDrone.Core/IndexerSearch/ReleaseSearchService.cs)。
- [qBittorrent：Jackett 搜索插件](https://github.com/qbittorrent/search-plugins/blob/33f4e0c1655b293b890e77f86db373e7a13403c3/nova3/engines/jackett.py)、[WebUI API](https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-%28qBittorrent-5.0%29)。
- [bitmagnet：Torznab 结果适配](https://github.com/bitmagnet-io/bitmagnet/blob/e31b30d7351c269dc801876f92ebc59d31fee545/internal/torznab/adapter/search_result.go)、[安装依赖](https://bitmagnet.io/setup/installation.html)、[Torznab 接入](https://bitmagnet.io/guides/servarr-integration.html)。
- [Torznab 1.3 草案](https://torznab.github.io/spec-1.3-draft/torznab/Specification-v1.3.html)、[BEP 5：DHT 查询协议](https://www.bittorrent.org/beps/bep_0005.html)。

## 本轮原型边界与验收

仅使用安全、虚构影片和来源。异步返回、超时与交接是本地示例状态；不调用网站、WebView、磁力协议、外部下载器或数据库。链接使用无效示例域名和虚构 hash，剪贴板复制为真实本机操作。

验收覆盖一次搜索的混合结果、筛选排序、查看详情后返回、按需补全、重复下载防护、外部交接状态、部分来源失败及重试、没有影片资料时保留资源、快速改查与取消、批量队列保留，以及深浅色与窄窗口布局。具体结果写入原型验证记录。
