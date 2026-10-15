# ADR 0027：发现页移除 AVWikiDB，只使用 JavBus

- 日期：2026-10-12
- 状态：已接入源码，未重新打包
- 依据：用户要求移除 AVWikiDB，只使用 JavBus。取代 [ADR 0022](0022-avwikidb-discovery-navigation.md) 中的名单、头像与在线作品来源，以及 [ADR 0024](0024-javbus-discovery-works.md)、[ADR 0025](0025-javbus-catalog-counts.md) 中“保留 AVWikiDB CSV”的部分。

## 决策

- 删除 `data/catalogs/avwikidb` 快照（五类名单、`portraits.json` 头像链接、清单与校验文件）。发现页名单只来自 `data/catalogs/javbus` 与用户目录中的 JavBus CSV，以及已读取详情汇总的记录，保持网站顺序。
- 删除 AVWikiDB 目录分页、作品与详情解析、名称映射，以及仅为 AVWikiDB 验证页准备的隐藏 WebView 读取器和诊断。JavBus 读取继续使用常驻 HTTP；403 直接反馈，不启动隐藏浏览器。隐藏 WebView 宿主仍供资源取流使用。
- JavBus 没有男演员目录，发现页撤下“男演员”入口；元数据中的演员筛选不受影响。
- 头像：JavBus 名单不保存头像地址，演员头像只按名称、译名和别名精确匹配 GFriends，并沿用现有本地缓存。同一分区内同名不同编号仍显示占位图。
- 在线作品列表的封面取自 JavBus 列表页卡片中 `<img>` 提供的地址，详情大图取自 `bigImage` 链接；按来源页 Referer 经后台 HTTP 加载。不会改用其他站点搜索封面。

## 迁移

- 名单缓存版本升至 7。读取更早版本时丢弃女演员、男演员、导演、制作商、系列的旧名单名称（来自 AVWikiDB），保留 JavBus 记录、数量、人工字段、分类和发行商缓存；不删除存储键。
- 已收藏资料若记录 `AVWikiDB` 或未记录来源，不自动转到 MetaTube 获取图片；用户先点击“刮削资料”，确认采用 MetaTube 资料后再获取。

## 刮削与预览边界（2026-10-12 补充）

- 刮削搜索、详情、封面与预览使用 MetaTube，不复用发现页详情缓存，也不回退到目录站查询。片库普通浏览只读已保存资料，发现页继续使用 JavBus。
- 用户主动刮削后保存预览片、预览图链接与来源页；重开片库直接读取这些链接，不重新请求 MetaTube。普通目录收藏不会覆盖已经保存的刮削预览。
- 影片详情“预览”区域首位展示预览片卡片，随后展示图片；默认采用普通视频（MP4），未提供时采用 HLS，两者都没有时只展示图片。点击卡片使用现有播放器，不提供右键格式选择。

## 验证

类型检查、修改文件的格式与 lint 通过；仅运行重写的 `discover-categories`、`catalog-seed-retry` 定向用例。未运行完整测试，未访问真实站点，未重新打包。
