# AVWikiDB 实体名单

本目录保存 2026-10-10 采集的公开目录文本快照，已接入 JAVM 发现页的五类离线名单。目录由 Worker 读取和处理，网站不可用时仍可浏览随包快照；网络可用时按有界分页任务异步补充。

| 文件 | 来源目录 | JAVM 维度 | 唯一 ID 数 | 页数 |
| --- | --- | --- | ---: | ---: |
| `actresses.csv` | <https://avwikidb.com/actor/> | 女演员 `actresses` | 44,731 | 448 |
| `male-actors.csv` | <https://avwikidb.com/histrion/> | 男演员 `maleActors` | 379 | 4 |
| `directors.csv` | <https://avwikidb.com/director/> | 导演 `directors` | 5,903 | 60 |
| `makers.csv` | <https://avwikidb.com/maker/> | 制作商 `studios` | 5,450 | 55 |
| `series.csv` | <https://avwikidb.com/series/> | 系列 `series` | 49,388 | 494 |

制作商与发行商不是同一个维度。本次没有确认到独立的发行商目录，因此不生成 `labels` 文件，也不将制作商复制为发行商。

## 格式与中文名称

CSV 使用 UTF-8 BOM、逗号分隔、CRLF 换行。首行为字段名，所有字段都使用双引号转义。

| 字段 | 含义 |
| --- | --- |
| `source` | 固定为 `avwikidb` |
| `kind` | `actor`、`histrion`、`director`、`maker` 或 `series` |
| `source_id` | 来源 ID，按文本处理；接受来源已有的字母前缀编号 |
| `name_original` | 目录中的原名，只去除首尾空白 |
| `name_zh` | 经翻译或校对的中文名，未处理时留空 |
| `aliases` | 后续维护的别名，用 `|` 分隔，初始留空 |
| `translation_status` | 初始为 `pending`，后续可用 `translated` 或 `reviewed` |
| `source_url` | 对应实体页面的来源链接 |

这次采集不将日文原名、日文汉字或简繁转换冒充中文译名。显示名取 `name_zh || name_original`。导演人名和品牌优先采用已有中文名称，无法确认时保留原名。CSV 中重复名称仍保留不同来源 ID。现有发现页按媒体库名称关联和去重，因此显示条数可能小于 CSV 条数；女演员有 44,489 个不同名称。同名不同 ID 无法确认头像身份时使用占位图。

更新时使用 `(source, kind, source_id)` 关联记录，保留人工维护的 `name_zh`、`aliases` 和 `translation_status`。来源删除或改名需单独复核，不能直接丢弃已有中文校对。

## 采集与校验

通过未登录的普通浏览器访问五个公开目录，沿页面实际提供的“下一页”链接顺序读取。只提取目录主列表的实体 ID、名称、来源链接和头像链接元数据，不保存作品详情、图片或视频。隐藏采集页面的文本和图片不用于界面验证或截图。

未访问导演详情页采集作品数，文件不包含作品数量字段。中文译名尚未补译，五个 CSV 的 `name_zh` 与 `aliases` 均留空，`translation_status` 均为 `pending`。

`manifest.json` 记录每页采集时间、分页条数、页面声明总数、去重情况和最终文件 SHA-256。覆盖范围是采集期间可访问的目录分页，不代表全行业完整数据库。站点各分页可能缓存于不同时间，因此页面声明总数可能存在差异；以清单中的观测值和唯一 ID 数为准。

系列目录共读取 49,389 行，第 1、2 页之间有 1 个相同 ID，名称一致，去重后为 49,388 条。系列首页声明 49,378 条，其他分页声明 49,389 条，因此最终唯一 ID 数不与页面声明总数完全一致；不据此虚构或补造缺失实体。

男演员目录声明 386 个条目，其中 7 条链接为 `/histrion/null/`，没有可用来源 ID，已排除并记录在清单中；最终保存 379 条有效记录。女演员 448 页全部读取，44,731 个 ID 无重复。

`validation.json` 保存独立 CSV 读取校验结果：分页连续、来源 ID 唯一、原始名称及链接与采集记录一致、UTF-8 BOM 和 SHA-256 一致。应用构建和安全样例验证另见 `docs/verification/2026-10-10-avwikidb-offline-portraits.md`。

## 头像链接与持久缓存

`portraits.json` 按演员目录和来源 ID 保存 AVWikiDB 页面提供的 DMM 头像 URL。本次女演员有 13,807 个头像链接，男演员主列表未提供可用头像链接；这些是链接元数据，不是图片文件，也不保证当前图片可用。

生产桌面按当前页下载头像：优先 AVWikiDB 链接，缺失或失败后尝试 GFriends 官方 README 列出的 jsDelivr 镜像，再尝试 GitHub 原始地址。GFriends 文件树只做头像精确匹配，不向发现页添加演员。网络失败继续显示占位头像。

头像与备用索引保存在 `%LOCALAPPDATA%/JAVM/cache/portraits`，后续启动直接复用。图片最多 1,000 张、合计 128 MiB，单张 2 MiB；备用索引单独最多 16 MiB。安装包不携带完整 GFriends 图库或已下载头像。详见 ADR 0022。

开发服务器及开发版桌面只使用安全虚构名单和占位图片，不启用真实头像下载；生产适配器的缓存、镜像切换、并发和取消使用 mock 验证。

CSV 是保留原始名称的数据交换文件。用电子表格软件检查时，应通过导入功能将所有列指定为文本，避免把名称或 ID 自动解释为公式、数字或日期。
