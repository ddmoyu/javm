# MetaTube 精简构建与体积比较

2026-10-12，按用户要求精简现有 Go 版本，保留官方 v1.4.0 的全部刮削来源和 JAVM 当前功能。

## 结果

| 产物 | 官方版 | javm-lite-1 | 减少 |
| --- | ---: | ---: | ---: |
| Windows x64 EXE | 47,316,992 字节 / 45.12 MiB | 33,260,032 字节 / 31.72 MiB | 29.71% |
| 相同参数单文件 ZIP | 16,886,727 字节 / 16.10 MiB | 12,470,274 字节 / 11.89 MiB | 26.15% |

官方原始下载 ZIP 为 16,909,929 字节。表格中的两个 ZIP 均由同一 .NET `CompressionLevel.Optimal` 参数生成，内部均只有 `metatube-server.exe`，避免混用下载包与解压体积。

精简 EXE SHA-256：`861148684026d9430374d3d0b7d61c6427e78cc488fabaaeebc157c45a613126`。

产物与机器记录位于 `build/metatube-lite/`：`metatube-server.exe`、`metatube-server-lite.zip`、`size-comparison.json`、`verification.json`、`build-info.txt`、`installed.json`。官方基线保留为 `metatube-server-official.exe`。

## 保留与移除

- 保留原版 30 个影片来源、1 个人物来源。59 个 provider 源文件和来源注册文件与锁定的上游 Git blob 完全一致，包括原版默认未启用的实验性实现文件；构建标签与官方发行一样不启用 `experimental`。
- 保留来源列表、影片搜索和详情、人物接口、鉴权、代理、请求超时及 SQLite 缓存。数据库结构和数组、日期、JSON 字段格式不变。
- 保留来源内部的图片比较、裁剪与全部解码兼容能力，包括 jpegli/wazero；保留 Otto JavaScript 解析。FANZA 的图片匹配和其他来源的脚本解析仍依赖这些组件。
- 移除对外图片加工、翻译和评论路由，以及人脸检测、徽标、图片编码/缩放/水印等无调用的实现。
- 移除 PostgreSQL 的 GORM/pgx 驱动；GORM datatypes 仅保留原版 Date/JSONType/JSONSlice 和 SQLite 行为，移除 MySQL 特有分支。仍保留 `lib/pq`，因为旧 SQLite 缓存中的数组沿用其编码格式。
- User-Agent 数据在构建时按上游规则筛选，保留 846 条候选的原始顺序和重复项权重，运行时仍使用相同的 `math/rand/v2.IntN` 随机选择；因此可以移除 projectdiscovery/useragent 及工具依赖。其 JSON 序列已与直接运行原版 Go 筛选代码的结果比较，SHA-256 均为 `b63789178b470d7f8e97b06d36b2658aa846786d1c41d781c1023d4ca9e93358`。
- Gin 使用 `nomsgpack` 构建标签，不再链接 JAVM 未使用的 MessagePack 编解码器；现有 JSON 请求/响应不变。

## 可复现构建

上游源码锁定到 `metatube-community/metatube-sdk-go` 的 `c0e053f8c4ac58ebfb2794d52ed90640d9b1509b`，对应 v1.4.0。Go 锁定为官方二进制使用的 `go1.25.0`，`CGO_ENABLED=0`、Windows amd64 v1、`-trimpath -s -w -buildid=`；没有使用 UPX。

`scripts/metatube-lite/source-lock.json` 只列出生产 Go 源码、GraphQL 查询模板、构建所需依赖片段及许可证，逐文件校验 Git blob 或 SHA-256。不会下载上游测试样例或媒体。补丁只应用到新的构建目录，不修改 Go 模块缓存。

```powershell
pnpm metatube:build
pnpm metatube:verify
pnpm metatube:build --offline --install
```

首次构建需要 PATH 中有 Go，并下载锁定工具链及依赖；后续缓存完整时支持 `--offline`。`--install` 写入 `bin/tools/metatube`，不操作用户的 MetaTube 数据目录。默认构建不运行验证，`metatube:verify` 是本次新增的专项验证。

`offline:setup` 已接入该构建；离线打包核验 profile、源提交、工具链、构建配方哈希及 EXE 哈希，拒绝混入旧官方程序。构建脚本和第三方修改说明、许可证归入开发侧打包记录，不额外增加运行包文件。

## 已执行验证与边界

1. Windows x64 Go 构建成功，在线源码准备和离线重建成功。
2. 官方版与精简版分别启动在隔离目录，仅使用新建 SQLite 数据库和安全虚构资料。
3. 9 个接口场景的状态码及 JSON 完全一致：来源列表、数据库版本、无效鉴权、详情、大小写 ID、指定来源搜索的缓存回退、URL 搜索、缺少查询参数和未知来源。
4. 30 个影片来源和 1 个人物来源的名称、URL 完全一致；移除的图片、翻译和评论接口返回 404。
5. 官方版创建并填入安全资料的 SQLite 缓存，经两个版本打开后，表结构、影片记录和评论记录均保持一致；覆盖 Unicode、数组中的引号/反斜杠及日期。
6. 搜索回退使用本机拒绝代理，共拦截 4 个请求，没有连接真实内容源。未读取用户数据库，没有运行全量测试、前端构建或桌面 UI 验证，也未重新打包整个 JAVM。

来源解析器的保留通过源码哈希和注册列表验证；这不代表对所有真实网站进行了在线可用性测试。
