# MetaTube Sidecar 集成计划

> 状态:**规划中(未动代码)**
> 创建日期:2026-06-17
> 目标:将 MetaTube Server(Go 静态二进制)作为本地 sidecar 服务随 javm 启动,通过其 HTTP API 新增一个**聚合刮削数据源**。

---

## 1. 背景与目标

当前 javm 自研了 16 个 HTML 解析数据源,维护成本高(站点改版即失效)。MetaTube 是社区维护的元数据聚合服务,把多源解析、反爬、图片处理、翻译都做在服务端,客户端只需调 HTTP API。

**目标**:不替换现有自研源,而是**新增一个 MetaTube 聚合源**,纳入现有多源并发 + 评分排序体系,作为稳定性补充。

**核心收益**:
- 一次性获得 MetaTube 的 20+ provider(含 R18/r18.dev、JavBus、Arzon 等)。
- MetaTube 返回**结构化 JSON**,新数据源用反序列化即可,无需写/维护 HTML 解析器。
- 附带能力:演员头像(GFriends/XsList)、图片裁剪 + 人脸检测、文本翻译。

---

## 2. 可行性结论:✅ 可行

| 关键点 | 结论 |
|---|---|
| 是否 Go 静态二进制 | ✅ `metatube-sdk-go`,官方提供多架构预编译(`metatube-server-releases`) |
| 是否需要外部数据库 | ❌ 不需要,`-dsn metatube.db` 用 sqlite 本地文件即可 |
| 默认端口 | 8080(可配置) |
| 运行命令 | `metatube-server -dsn <path>/metatube.db -port <port>` |
| 本项目是否已有 sidecar 先例 | ✅ `bin/N_m3u8DL-RE.exe`、ffmpeg,均走 `bundle.resources` + 路径解析 |

**与现有 sidecar 的本质差异**:ffmpeg / N_m3u8DL-RE 是「用完即退」的短命进程;MetaTube 是**长驻 HTTP 服务**,需要额外的进程生命周期管理(启动 → 健康检查 → 退出时杀掉)。这是本计划的工程重点。

---

## 3. 架构方案

```
┌─────────────────────── javm (Tauri 桌面应用) ───────────────────────┐
│                                                                      │
│  前端 (Vue)  ──invoke──►  Rust 后端                                  │
│                              │                                       │
│                              │  resource_scrape (现有多源体系)        │
│                              │   ├─ 自研 HTML 源 ×16                  │
│                              │   └─ MetaTube 源 (新增, JSON)  ──HTTP──┼──► MetaTube Server
│                              │                                       │      (127.0.0.1:<port>)
│                              │  sidecar 生命周期管理 (新增)           │      sqlite: app_data/metatube.db
│                              │   ├─ 启动 spawn                       │
│                              │   ├─ 健康检查轮询                      │
│                              │   └─ 退出时 kill                      │
└──────────────────────────────────────────────────────────────────────┘
```

MetaTube 进程只监听 **127.0.0.1**(回环),不对外暴露。

---

## 4. 关键技术点

### 4.1 二进制获取与打包
- 从 `metatube-community/metatube-server-releases` 下载对应平台二进制,放入 `src-tauri/bin/`,由现有 `bundle.resources: ["bin/*"]` 自动打包。
- **多平台命名要按 target triple 区分**(win x64 / mac arm64 / mac x64 / linux),避免重蹈 ffmpeg sidecar 在 arm64「误选同名目录」的坑(见 commit `584b3c1`)。
- 运行时定位**复用 `resolve_ffmpeg_path()` 的多候选模式**:exe 同级目录 → `bin/` 子目录 → 开发期 `target/{debug,release}/bin`。
- ⚠️ **体积(已实测 v1.4.0)**:zip 约 14–16MB,**解压后单平台二进制约 45MB**(windows-amd64 实测 47.3MB)。只需打包**当前平台一个**二进制,但仍偏大。**建议做成「按需下载」**(首次启用刮削源时下载对应平台,而非随安装包分发)。
- **平台覆盖(已确认)**:官方预编译覆盖 windows/darwin/linux/freebsd/openbsd × amd64/arm64 等,含 Apple Silicon arm64,满足 javm 全平台需求。

### 4.2 进程生命周期管理(新增模块,建议 `src-tauri/src/metatube/`)
- **启动时机**:应用 setup 阶段 spawn(或延迟到首次需要刮削时,降低启动负担)。
- **端口选择**:固定 8080 有冲突风险。建议启动前用 `TcpListener` 探测一个空闲端口,再以 `-port` 传入。
- **数据库路径**:`app_data_dir()/metatube.db`(用 Tauri path resolver,勿放安装目录)。
- **健康检查**:spawn 后轮询健康端点直到返回 200,再标记「就绪」;未就绪时该源跳过。
- **退出清理**:监听应用退出事件,`child.kill()`;Windows 需处理子进程树。**这是与 ffmpeg 最大的不同**——长驻进程必须保证不残留僵尸进程。
- **隐藏控制台**:Windows 复用 `CREATE_NO_WINDOW`(ffmpeg.rs 已有 `hide_console_window`)。
- **本机鉴权**(可选但推荐):启动时生成随机 token 用 `-token` 传入,前后端共享,防止本机其它程序访问该端口。

### 4.3 API 集成(新增 `Source` 实现)
- 在 `resource_scrape/sources/` 新增一个 MetaTube 源,实现现有 `Source` trait,但 `parse()` 改为**反序列化 JSON**而非 HTML 解析。
- 纳入现有多源并发搜索 + 详细度评分排序;把 MetaTube 当成一个"会自己内部聚合的源"。

**端点(已由源码 `route/route.go` 确认,v1.4.0)**:

| 端点 | 用途 | 鉴权 |
|---|---|---|
| `GET /v1/movies/search?q=&provider=&fallback=` | 影片聚合搜索 | private(需 token) |
| `GET /v1/movies/:provider/:id` | 影片详情(完整 MovieInfo) | private |
| `GET /v1/actors/search` / `/v1/actors/:provider/:id` | 演员搜索/详情 | private |
| `GET /v1/images/{primary,thumb,backdrop}/:provider/:id` | 图片(含裁剪) | public |
| `GET /v1/translate` | 翻译 | public |
| `GET /v1/providers` | 列出可用源 | public |

**聚合机制(已由 `engine/movie.go` 确认)**:
- 客户端**只发 1 个 search 请求**,不带 `provider` 时 server 内部走 `SearchMovieAll`——**并发查所有启用 provider**,按 **provider 优先级稳定排序**,聚合返回一个候选列表(每命中源一条,精简字段)。`fallback=true`(默认)再查本地缓存补缺。
- ⚠️ 是**"优先级择优"而非"跨源字段融合"**:最终详情来自**单一 provider**(排序最前那条),不会把多源字段拼成一条。如需跨源互补,需客户端自行对多个 provider 调 detail 再合并。
- **两步流程**:`search`(拿排序候选)→ `GET /v1/movies/:provider/:id`(取完整详情)。
- **鉴权**:影片/演员接口在 `private` 组需 `-token`;图片/翻译公开。请求头确切格式(`Authorization: Bearer` / query token)接入前实测确认。

### 4.4 字段映射(已确认,源自 `model/movie.go` / `model/actor.go`)

**MovieInfo(影片)→ ScrapeMetadata**(JSON 格式):

| MetaTube 字段 | 映射 | 备注 |
|---|---|---|
| `number` `title` `summary` `director` `actors[]` `series` `genres[]` `score` `runtime` `release_date` | 直接对应 | 已有 |
| `maker` / `label` | → studio / label | MetaTube 无单独 studio,用 maker |
| `cover_url` `big_cover_url` `thumb_url` `big_thumb_url` | → poster/cover | 取大图优先 |
| `preview_images[]` | → thumbs(剧照) | 已有 |
| `preview_video_url` / `preview_video_hls_url` | 🆕 预告片 | 现有体系暂无,可选扩展 |
| `homepage` `provider` `id` | 来源标识 | UI 以「数据源 N」呈现 |

> MetaTube 无 `tags`/`mpaa`/`country` 字段:`genres` 当作 tags。另有 `MovieReviewInfo`(影评)可选。

**ActorInfo(演员)** — 现有演员表仅名字,以下均为新增能力:`images[]`(头像)、`aliases[]`、`summary`、`birthday`/`debut_date`、`height`/`cup_size`/`measurements`、`blood_type`/`nationality`/`hobby`/`skill`。对应 JvedioNext 分析中的「演员头像库」提升点。

### 4.5 UI 呈现(遵循项目约定)
- 按既有约定,UI 中**不显示 MetaTube 背后各 provider 的真实网站名**,统一以「数据源 N」或「MetaTube 聚合源」呈现。
- 设置项:开关启用、provider 偏好、翻译开关。

---

## 5. 风险与权衡

| 风险 | 说明 | 缓解 |
|---|---|---|
| 安装包体积 +30~50MB | Go 二进制不小 | 做成「首次启用时下载」而非随包 |
| 进程管理复杂度 | 长驻进程需健康检查 + 退出清理,处理不当残留僵尸进程 | 单独模块、充分测试退出路径、Windows 进程树 kill |
| 首次启动变慢 | sidecar 拉起 + 健康检查需时间 | 延迟启动 / 异步,不阻塞主窗口 |
| 二进制来源信任 | 引入第三方预编译二进制 | 校验 release 哈希;或自行从源码编译 |
| provider 仍可能被反爬 | MetaTube 服务端抓取也可能失败 | 仅作补充源,保留自研源兜底 |
| 合规 | 成人内容 + 版权 | 维持「个人使用/教育」定位,与现状一致 |
| 跨平台二进制管理 | 多 target triple,易选错(ffmpeg 已踩坑) | 严格按平台命名 + 打包脚本校验 |

---

## 6. 分阶段实施步骤(后续逐步落地)

1. **阶段 0 — PoC 验证(纯手动,不写代码)**
   - 手动下载 metatube-server,`-dsn test.db -port 8080` 启动。
   - curl 实测 search / detail / image 端点,记录真实 JSON 结构 → 回填 4.3、4.4。
   - 确认二进制体积、首次冷启动耗时。
2. **阶段 1 — sidecar 生命周期**:新增 `metatube` 模块,实现 spawn / 端口探测 / 健康检查 / 退出 kill;开发期手动放二进制到 `target/.../bin`。
3. **阶段 2 — 数据源接入**:实现 MetaTube `Source`,JSON 反序列化 + 字段映射,纳入多源评分;打通「番号 → 搜索 → 详情 → 保存 NFO」。
4. **阶段 3 — UI 与设置**:启用开关、provider 偏好、翻译;数据源以「数据源 N」呈现。
5. **阶段 4 — 打包与跨平台**:二进制纳入 `bin/`(或实现按需下载),验证 Windows 打包,处理多 target triple。

---

## 7. 接入前必须实测验证的项

- [x] ~~MetaTube v1.4.0 真实 API 端点路径与参数~~ — 已确认(见 4.3,源自 route/route.go、engine/movie.go)
- [ ] 鉴权请求头确切格式(`-token` 启动参数已确认;头部 `Authorization: Bearer` vs query token 待实测)
- [ ] 监听地址能否限定 `127.0.0.1`(参数名)
- [x] ~~返回 JSON 的完整字段~~ — 已确认(见 4.4,源自 model/movie.go、actor.go)
- [x] ~~二进制体积、各平台可用性~~ — 已确认(解压后约 45MB/平台;全平台覆盖含 arm64)
- [ ] 退出时进程是否干净清理(Windows 进程树)

---

## 8. 验收标准

- sidecar 随应用启动、退出时无残留进程。
- 对一个标准番号,MetaTube 源能返回结果并参与多源排序。
- 生成的 NFO 字段与现有自研源一致或更全。
- 关闭 MetaTube 源时,现有自研源功能不受任何影响。

---

## 参考来源

- [MetaTube SDK & API Server (Go)](https://github.com/metatube-community/metatube-sdk-go)
- [MetaTube Server 预编译二进制发布](https://github.com/metatube-community/metatube-server-releases)
- [MetaTube 组织主页](https://github.com/metatube-community)
