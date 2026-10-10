# NFO 兼容读取与旧数据保留

日期：2026-10-09。范围是目录扫描的 NFO 导入与媒体数据库升级。本次不改写用户的 NFO，也不要求丢弃旧数据。

2026-10-10 后续实施：目录扫描仍只读 NFO；用户授权的刮削任务会安全生成／更新 NFO，规则见 [MetaTube 基础刮削](0020-metatube-scraping.md)。

## 参考依据

NFO 没有覆盖所有媒体软件的统一格式。本实现以 [Kodi 电影 NFO](https://kodi.wiki/view/NFO_files/Movies) 的 `movie` 结构为主要参考，兼容 [Jellyfin 的 NFO 字段和别名](https://jellyfin.org/docs/general/server/metadata/nfo/)。例如 `runtime` 使用分钟，`durationinseconds` 使用秒；多站点评分采用 `ratings/rating`，用 `max` 解释量程。

旧 JAVM 基线是 `dd0e6b62b263258b6e78106c72017b3b470b4097`（0.5.4-beta.3），重点核对 `src-tauri/src/nfo/parser.rs`、`generator.rs`、`scanner/service.rs` 和 `db/schema.rs`。旧生成器会写 UTF-8 BOM、多个日期别名、`num`、`uniqueid type="local"`、厂商扩展字段和图片引用；这些数据仍有价值，无需通过重建数据库来处理格式差异。

竞品仅作静态源码参考，未在本轮安装运行，也未复制其业务源码：

| 参考实现                                                                                                                                                        | 本次借鉴的方向                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [OpenAver / nfo_read.py](https://github.com/slive777/OpenAver/blob/3ab09be1c482a5c430bda291fcfc26e19a42f5e7/core/nfo_read.py)                                   | 嵌套演员、资料后备、保持顺序的去重                                                                                                                    |
| [MDCz / nfo.ts](https://github.com/ShotHeadman/mdcz/blob/295f828c76158c6411b52caf6fba9e7b0ee945ba/packages/runtime/src/scrape/nfo.ts)                           | 番号与站点 ID 分开、分钟时长、图片用途和扩展字段保留                                                                                                  |
| [Javdex / nfoArtifactCodec.ts](https://github.com/JavdexLabs/Javdex/blob/004dc15d303dde90eb2829ca01d4f092b9f0ed2d/packages/library/src/nfo/nfoArtifactCodec.ts) | 结构化评分与输入边界；另见其 [兼容说明](https://github.com/JavdexLabs/Javdex/blob/004dc15d303dde90eb2829ca01d4f092b9f0ed2d/docs/NFO_COMPATIBILITY.md) |

完整七个竞品的地址继续保留在 [重构计划](../REFACTOR_PLAN.md#竞品与功能参考)，后续实现对应功能前核对当时的源码与许可。

## 读取规则

仍优先读取视频同名 `.nfo`；目录只有一个候选视频时才回退 `movie.nfo`。节点与属性名称按大小写不敏感匹配，但不任意猜测 XML 命名空间或缺失的闭合标签。

| 数据             | 新读取策略                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 文本编码         | UTF-8／BOM、UTF-16 LE/BE、UTF-32 LE/BE；支持声明的 GBK、GB2312、GB18030、Big5、Shift_JIS 和 Windows-31J。无声明且不是有效 UTF-8 时尝试 GB18030，并提示核对文字；不使用系统默认代码页静默替换字符 |
| 常见 XML 问题    | 支持 CDATA 与标准实体；裸 `&`、未知/非法实体按字面内容读取，移除 XML 禁止的控制字符。仅在内存中处理，显示兼容提示，原文件保持原样                                                                |
| 标题与简介       | `title/localtitle/name`、`originaltitle/original_title`、`sorttitle/sortname`、`plot/outline/review`；保留旧 `originalplot` 等扩展资料                                                           |
| 发行日期         | 依次尝试 `premiered/releasedate/release`，合法日期统一成 `YYYY-MM-DD`；只有 `year` 时可显示年份，不虚构月日                                                                                      |
| 番号与站点身份   | 优先 `num/number`，再考虑 `uniqueid` 的 local/num/jav/javm 类型；IMDb、TMDB 等身份独立保留，不把任意第一个站点 ID 当作番号                                                                       |
| 演员、分类、标签 | 支持平铺及容器节点、纯文本或带 `name` 的演员；保留演员角色、头像和顺序，按名字去重；不随意按逗号拆分姓名                                                                                         |
| 系列与厂商       | 支持 `<set>名称</set>`、`<set><name>名称</name></set>`、`series`；厂商依次尝试 studio/maker/publisher，同时保留多个导演、厂商等来源内容                                                          |
| 时长与分辨率     | 优先 MediaInfo 实测。缺少实测及已有参数时使用 NFO 后备；纯数字 `runtime` 是分钟，也接受 min/分钟或 `HH:MM:SS`，`fileinfo/streamdetails/video/durationinseconds` 是秒                             |
| 评分             | 优先有效结构化评分中的 `default`，再取首个有效值；按 `max` 转成 0～10，保留原量程及来源；兼容旧平铺 `rating`，忽略 NaN、越界或混入文字的数字                                                     |
| 图片             | 分开海报、横图、背景、样本图与演员头像。依次尝试 NFO 本地引用，再使用文件命名约定；仅加载所选根目录内的常见图片，拒绝越界、联接和符号链接，不自动访问远程 URL                                    |

单个 NFO 最多 2 MiB，单个读取字段最多 256 KiB，节点最多 50,000、深度最多 64。拒绝 DTD、多根节点、根节点外正文及截断 XML。结构错误会产生文件级错误，其他视频继续处理，已有资料与最后一次成功读取的快照仍保留。

尚未映射到界面的扩展字段不会凭空消失：原始 NFO 字节保存在数据库中，已解析的扩展资料保存在元数据缓存。此处的“保留”不表示所有字段已有编辑、筛选或导出入口。

## 升级与重扫

媒体库升级到 schema 4，`application_id=1245793613`；支持空库、旧 JAVM schema 2 与此前新工程 schema 3。

1. 对旧库先检查身份、关键列与完整性，使用 SQLite Backup API 生成同目录 `javm.db.pre-v4-<UUID>.bak`，成功后才开始事务迁移。
2. 保留影片 ID、旧目录、资料及关联表、旧图片路径和未知表。新增 `javm_nfo_sources` 保存每部影片最后一次成功解析的 NFO 原始 BLOB、路径、编码、解析器版本与导入时间；不把原始大文本传到 UI。
3. `javm_scan_files.nfo_parser` 记录解析器版本（当前为 2），升级后即使文件签名不变，也会在下次扫描重读 NFO；未改变的视频参数继续复用，避免重复探测。
4. NFO 只补空字段或更新仍等于上次导入值的字段。手工修改过的标题和关联资料保留，即使某次 NFO 恰好与手工值相同，也不因此重新取得自动覆盖权限。
5. 文件名占位标题可由后补 NFO 替换。坏 NFO、NFO 被删除或视频离线不清空资料；最后成功的快照不会被失败输入覆盖。新快照与影片更新在同一事务提交。
6. 迁移失败整笔回滚；未知版本报错保留，不自动删除重建。已有同路径记录复用 ID；无法无歧义迁移的路径会保留原库并报错。

原始快照会增加数据库空间，规模大致随已导入 NFO 的总字节数增长；升级前备份还会额外占用一份旧库空间。当前只保留每部影片最后一次成功的 NFO 快照，不是无限历史版本。

## 兼容边界

- 本次没有必要丢弃旧数据。旧版演员、系列等维度收藏、别名及旧下载任务表会保留；维度收藏界面、旧下载任务执行恢复等业务尚未全部接入，不能把它们视为新影片收藏或新下载任务。
- 启动旧库发现及合并导入现由 [启动导入旧库](0018-legacy-database-import.md) 接管：引导确认后备份并合并，成功校验后移除旧路径数据库。迁移后的库不能交给旧程序继续写，回退使用旧库原始备份。
- 源 NFO 只读；当前没有批量重写/导出 NFO 功能。后续写入功能应遵循上述单位、身份类型和结构化评分约定，并独立验证未知字段保留与原子替换。按用户确认的产品约定，刮削成功后默认写入 NFO，不提供关闭该行为的设置项；正式刮削服务仍待接入。
- XML/NFO 解析、编码转换、文件访问与数据库事务均在原生后台执行，沿用有界任务队列、最多 16 个探测任务及节流进度。实际 NAS、机械硬盘、大型片库的 UI 响应仍需单独验收。
- 本轮验证使用合成 NFO 和旧 schema 夹具，未访问真实用户旧库，也未声称通过 Kodi/Jellyfin 的实际导入验收。详见 [验证记录](../verification/2026-10-09-nfo-compatibility.md)。
