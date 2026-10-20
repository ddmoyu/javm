# 迁移旧版 Supabase 使用统计

日期：2026-10-15。

用户授权将 0.5.3 的 Supabase 使用统计迁移到新版，沿用原配置和上报逻辑；随后确认保留次日上报，修复其他已审查问题。本决策覆盖早期功能状态中的“不默认加入统计上报”。

## 保留的契约

- `supabase.json` 从旧标签 `v0.5.3:src-tauri/src/analytics.rs` 提取原项目地址和 publishable key，表名仍为 `app_daily_stats`。无需新建项目、配置或安装 SDK。
- `POST /rest/v1/app_daily_stats?on_conflict=user_id`，请求体为单条记录数组；保留 `apikey`、`Content-Type: application/json` 和 `Prefer: resolution=merge-duplicates,return=minimal`，超时 12 秒。复用应用代理和常驻 HTTP 服务。
- 原 14 个字段：`user_id`、`stat_date`、`os`、`cpu_arch`、`system_language`、`app_version`、`play_video_count`、`download_video_count`、`app_launch_count`、`active_duration_seconds`、`search_designation_count`、`search_resource_link_count`、`download_video_failed_count`、`video_total_count`。
- 日期使用当地日期。主实例每次启动加一。自动上传和 `syncNow()` 都只发送早于今天的日期；当天继续累计，退出仅保存，不新增当天或退出上报。

## 优化后的计数口径

- `active_duration_seconds` 指主窗口可见时间，不表示用户实际操作时长。15 秒心跳结合 `visibilitychange` 和退出结算，按单调时钟实测间隔累计整数秒，同日保留不足一秒的余量，跨当地午夜拆分日期。超过 30 秒的停顿或墙钟明显跳变不计入，避免休眠产生虚假活跃；这会保守地少算长时间主线程停顿。不采集鼠标、键盘、焦点、子播放器或托盘任务活动。
- 播放成功打开后增加播放次数；同一播放源仅激活已有窗口、取消或打开失败不计数。这里表示打开播放源，并不代表已观看一定时长。
- 下载成功和失败分别在任务状态成功持久化为 `completed`、`failed` 后计一次；同一状态的进度保存和重载不重复计数。用户重新尝试后再次失败或完成，分别计入该次尝试，不把失败次数解释为不同视频数。
- 资料服务实际开始查询后计一次 `search_designation_count`，忙碌拒绝或取消不计入。资源查找每次有效搜索计一次 `search_resource_link_count`，多来源展开不再乘倍；用户手动重试某来源计一次。下载前链接复验不重复计数。各来源表现仍由现有本地来源统计维护。
- 当前视频数按 `media_files` 记录数采样，最多每分钟读取一次；纯资料作品不计入。读取暂时失败时仍保存其他计数并保留上次采样值。字段名沿用旧版，但以上计数修正与 0.5.3 的口径有差异，分析时应按应用版本区分。

## 存储和生命周期

TypeScript 应用级服务负责计数、日期和网络调度；SQLite 读写通过官方 Extension 在原生线程执行。服务只在主实例创建，不依赖 React effect，浏览器预览和播放器子窗口不创建统计服务。

在应用数据目录使用独立 `analytics.sqlite3` 的 `usage_analytics_state`，不纳入片库备份和恢复。兼容此前保存在片库中的快照：首次复制原 revision 与 payload，保留源表；此后恢复片库不会回滚统计身份、计数或 revision。若没有该快照，再优先从已导入归档读取 `analytics_meta`、`analytics_daily`；未导入片库时，仅以只读连接读取旧路径中的这两张统计表。沿用旧 `analytics_user_id` 及未上报记录，不删除、不改写原库。无旧统计时才创建随机 UUID，不读取硬件标识。匿名标识代表此应用数据实例，不等于自然人。

持久化使用 revision 检查并支持同一快照重放，避免 Extension 超时重试重复累计。损坏或无法读取的记录保留，不自动清空或生成新身份。本地持久化最多保留 32 个日期，按日期升序同步；较早记录失败时停止后续发送。达到上限时保留原快照，新计数暂留有界内存缓冲，上传释放空间后继续保存；长期完全离线仍存在容量边界，未落盘的溢出缓冲不能跨进程恢复。

内存事件按日期和计数类型合并，最多 32 个日期。本地保存串行，网络独立、可取消且最多一个请求，先保存再上传已持久化快照；只有成功回执与当前完整快照相同时才清除待同步标记，防止迟到回执抹掉新增计数。传输、限流与服务器错误按 1、2、4 分钟指数退避，最长 60 分钟；其他 HTTP 4xx 按 6 小时退避。业务事件不会绕过退避。退出先收尾业务任务，再取消统计网络并保存已接收计数，之后关闭共享 HTTP 和数据库服务。失败写入警告日志，不打断业务、不弹异常反馈框。

统计入口只接受固定计数类型，不接受或上报标题、路径、链接、搜索词、封面或媒体内容。日志不输出 publishable key、匿名标识或上报正文。

## 服务端按日历史：已部署

旧表 `app_daily_stats` 按 `user_id` 覆盖，只能保留每个实例最后一次快照。2026-10-15 已通过用户登录的 Supabase 控制台完成以下预检和迁移，保留 0.5.3 和当前请求兼容：

- [只读预检](../../scripts/supabase/inspect-analytics.sql)：查看实际列、唯一索引、RLS、权限及触发器，不查询用户明细。
- [归档迁移](../../scripts/supabase/20261015_analytics_daily_history.sql)：保留原表和请求，新建 `app_daily_stats_history`，主键为 `(user_id, stat_date)`，从原表推导字段类型；触发器归档每次成功写入。同一天重传按累计计数最大值合并，不累加重试；视频总数保留最后快照值。填充原表当前仍存在的数据，无法恢复已被覆盖的往日记录。
- [部署核验](../../scripts/supabase/verify-analytics.sql)：检查原表与历史表数量、归档完整性、唯一键、触发器、RLS 和权限；在只读事务中切换匿名角色验证 GET、HEAD 与 POST 策略。

新增历史表启用 RLS，撤销普通客户端直接访问；受限 `SECURITY DEFINER` 触发器使用空 `search_path` 和全限定表名。原表撤销匿名和已登录客户端的 DELETE、TRUNCATE、REFERENCES、TRIGGER 权限；保留 upsert 所需的 SELECT、INSERT、UPDATE，但三个 RLS 策略均限定 `request.method = 'POST'`，GET 和 HEAD 不返回统计行。沿用公开 key 和匿名 UUID 不能证明请求来自可信安装实例，不声称解决恶意伪造；本次不引入新的登录系统。

依据：[PostgreSQL 触发器](https://www.postgresql.org/docs/current/sql-createtrigger.html)、[函数权限](https://www.postgresql.org/docs/current/sql-createfunction.html)、[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)、[PostgREST 请求事务](https://docs.postgrest.org/en/stable/references/transactions.html)、[INSERT 与 ON CONFLICT 权限](https://www.postgresql.org/docs/current/sql-insert.html)。迁移在一个事务内执行，有锁等待和语句超时，新对象冲突时失败而不覆盖。回退时可停用新增触发器并保留历史表。

生产预检确认原表主键为 `user_id`，原有 451 条快照，非负约束检查无异常。迁移事务执行成功；随后 10 项结构、权限与数量回读均符合预期：原表和历史表各 451 条，全部现有快照均已归档，组合主键、触发器和 RLS 生效，历史表不可被普通客户端访问，上报所需原表权限保留。匿名角色的只读断言验证 GET、HEAD 无可见行，POST 可访问 upsert 所需原行。

原公开 key 的 REST 检查中，带精确计数的零行 GET 返回 HTTP 200、`Content-Range: */0`；原 POST 上报入口发送空数组 `[]` 返回 HTTP 200，没有插入任何测试统计。未读取用户统计明细，也未以真实非空客户端上报验证触发器写入；已确认触发器安装启用及迁移归档结果。

## 验证边界

首次迁移的 `analytics.test.ts` 与 `analytics-native.integration.test.ts` 使用固定虚构身份、模拟网络和隔离临时 SQLite。本轮另新增 `analytics-reliability.test.ts`、`analytics-events.test.ts` 和 `analytics-isolation-native.integration.test.ts`，覆盖网络与保存隔离、次日上报、旧回执保护、退避、尾段与跨日计时、播放激活去重、多来源搜索、下载失败、独立库迁移和片库恢复。全部使用安全合成数据，不向生产写入测试数据，不加载真实片库。

2026-10-15 首次迁移的 14 项验证已通过；随后本轮仅运行上述三个新增文件共 15 项，全部通过，其中最后新增的损坏片库身份保护用例单独运行。`pnpm typecheck` 和 `pnpm native:build`（Windows MSVC Debug）通过。未重跑既有或完整测试，未启动桌面界面、构建前端发行包或发布版本。生产变更限于上述表结构、权限、触发器和现存快照归档；验证仅使用只读 SQL、零行 GET 和空数组 POST，无虚构生产记录。
