# 目录文本快照

演员、分类、制作商和发行商的多列 UTF-8 BOM CSV。保留 ID、原名、人工中文名、别名、分区、类别分组、影片总数和数量采集时间。`video_count` 取明确的“全部影片”总数；未知留空，零值保持 `0`。不使用当前页条目数或磁力子集推算数量。

`manifest.json` 记录实际行数、已取得数量的行数、文件 SHA-256、完成状态及缺少名称的演员身份。制作商和发行商来自已有资料及指定分页的信息区；未宣称全站名单完整。未保存作品标题、描述、原始页面、图片或视频。

采集和续采：

```powershell
pnpm catalog:collect --relations-pages 10
```

会话文件仅保存在忽略目录 `.tmp/javm-catalog/session.cookies`，不提交或输出 Cookie 内容。没有可用会话或遇到人工验证时停止；可通过 `--cookie-file <Netscape文件路径>` 使用用户已有的正常会话。`--refresh-counts` 重读数量，`--refresh-directories` 从两个演员目录首页重读；两者均保留已保存的人工字段。`--seed-only` 只导出现有记录，不请求网络。

`--install` 同步到 `%LOCALAPPDATA%/JAVM/catalogs/javbus`，先验证原 CSV，再合并并保留人工字段和备份；损坏文件不会被覆盖。`--priority-ids okq` 可优先读取指定演员身份，最多 20 个，以逗号分隔。旧版 CSV 仅在首次迁移到版本 8 的缓存时读取；采集过程中不会自动打开真实内容界面。现有名单已足够，未经用户再次授权不继续采集。

取消采集并保存已取得的结果：

```powershell
New-Item -ItemType File -Force .tmp\javm-catalog\cancel.request | Out-Null
```

生产包使用 `pnpm catalog:build` 生成的精简 `catalog.sqlite3`，不再打包 CSV。仅从内置演员名单移除 `video_count` 未知的记录，零值保留；原始 CSV 作为开发快照保留。`catalog.sqlite3.json` 记录转换前后的条数、文件大小和哈希。正式构建自动重新生成，开发模式仍只使用安全虚构数据。

桌面旧用户目录使用相同 CSV 字段，男演员文件名为 `maleActors.csv`，本快照使用 `male-actors.csv`。来源身份仅作内部路由与数据关联，应用界面不展示站点名称或来源标签。运行时读取、迁移与在线搜索规则见 [ADR 0028](../../../docs/decisions/0028-compact-sqlite-catalog.md)。
