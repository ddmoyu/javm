# JAVM

JAVM 新工程，基于 `dev` 分支使用 React、TypeScript、Mantine、Vite+ 和官方 Neutralinojs 重建。C++20 的 SQLite 扩展与后台媒体服务位于 `native/database` 和 `native/media`。

当前版本为 **1.0.0**，采用全新数据模型，旧库迁移面向 `0.5.3`。沿用旧版 Logo，覆盖标题栏、浏览器页签、桌面窗口和 Windows EXE 图标；版本升级不改变当前功能接入范围。

界面图标统一使用 [Phosphor](https://phosphoricons.com/)（`@phosphor-icons/react`，MIT 许可），从 `frontend/src/components/icons.tsx` 复用。默认线性图标，收藏等选中态使用填充样式；原 JAVM Logo 和旧版图箱保留。许可文本位于 `resources/licenses/phosphor-icons-react.txt`，随前端及 EXE 一起打包。

下拉选中标记、关闭和清除、复选框、密码显隐及数字输入箭头均统一使用 Phosphor。没有图标插槽的数字输入控件使用 `resources/icons` 中的官方导出资源；升级图标库后运行 `pnpm icons:generate` 更新这些资源。

**正式前端使用 Mantine 与 Velvet 主题，目录扫描、媒体数据库与下载按授权逐项接入。** 默认入口展示媒体库、发现、下载、资源刮削、目录和设置，未导入数据时使用真实空状态，不注入 mock 数据。图片预览沿用旧版 Fancybox。旧 Vue/Tauri/Rust 代码及两版独立界面原型可从 Git 历史查看。

后续开发具体功能时，查阅 [竞品与功能参考](docs/REFACTOR_PLAN.md#竞品与功能参考)，其中收录七个竞品的仓库地址及适合借鉴的功能方向。

当前已接入功能、未完成项与验证边界见 [功能开发状态](docs/FEATURE_STATUS.md)，按正式源码核对，区别于早期原型范围。

Windows 视频下载已接入：支持 MP4 直链、m3u8 分片与独立音视频轨合并、暂停续传、任务持久化、失败重试和只重试合并。下载管理及下载设置直接操作真实服务，完成前检查输出文件；使用和依赖说明见 [视频下载与合并](docs/decisions/0007-video-downloads.md)。

内置播放已接入 Video.js 10 默认控制条。业务调用 `play(本地绝对路径或网络直链)` 即可加载并播放，媒体库、详情及完成下载的播放按钮共用该入口；不增加文件选择或链接输入界面。桌面播放器采用独立无边框窗口，悬浮工具栏支持拖动、最小化、最大化／还原与关闭，鼠标移出或静置 3 秒后隐藏，不占用视频高度。默认换片复用窗口，也可设置为不同视频新建窗口；同一视频只保留一个窗口，再次点击恢复并激活原窗口，保留进度。支持本地视频、网络 MP4 与 HLS，调用参数、大文件分块读取及验证边界见 [内置视频播放](docs/decisions/0009-video-playback.md)。

“设置 → 播放设置”可选择默认内置／外部播放器、指定 `.exe` 路径、选择“复用现有窗口”或“在新窗口中播放”，并开启记住播放进度。路径留空时使用系统默认应用；窗口模式与续播仅用于内置播放器，片尾最后 5 秒视为看完，设置保存后从下次播放生效。持久化与异常处理见 [播放偏好](docs/decisions/0011-playback-preferences.md)。

MetaTube 与 AI 资料辅助已接入。MetaTube 仅使用随包内置服务，无需用户下载安装或选择程序路径；首次查询资料时启动，此后保持运行，直到主程序退出。关闭窗口到托盘继续运行。“设置 → 刮削与资料”显示内置版本、运行状态和资料来源。“设置 → AI 辅助”支持 OpenAI 兼容接口的连接测试、番号识别与标题／简介翻译。影片编辑中先确认候选字段，再保存到片库；重扫保留已确认值。AI 默认关闭，需要配置自己的地址、模型和密钥。详见 [MetaTube 与 AI](docs/decisions/0012-metatube-ai.md)。

MetaTube 刮削已贯通下载与片库：搜索结果可“收藏并保存资料”，即使没有视频也能落盘 NFO 和封面；之后从详情下载或关联已有视频，保持同一作品及收藏。片库区分“未下载”“有本地视频”和“文件不可用”，支持一部作品多个视频。视频资源删除后仍保留作品资料，见 [1.0 作品与资源模型](docs/decisions/0021-metadata-first-library.md)。

## 环境

- Node.js 24 LTS（至少 24.11，本机验证版本见 `.node-version`）。
- pnpm 12.10.1，依赖使用一份 `pnpm-lock.yaml`。
- Windows 桌面运行需要 WebView2 Runtime。
- 原生构建需要 Visual Studio C++ 工具链、CMake 3.25+、Ninja。
- 精简 MetaTube 构建需要 PATH 中的 Go；脚本锁定并自动选择 Go 1.25.0。Go 仅用于构建，不随运行包分发。
- 准备离线包还需要 Git Bash 与 PATH 中的 NASM；精简 FFmpeg 使用 MSVC 静态构建，GNU Make 由脚本下载并校验。这些仅用于构建，不随运行包分发。
- 首次安装依赖、下载 Neutralino 宿主和配置 SQLite 需要联网。

## 开发命令

```powershell
pnpm install --frozen-lockfile
pnpm dev                  # 浏览器预览：http://127.0.0.1:5173
pnpm check                # Vite+ 格式、lint 和 TypeScript 检查
pnpm build                # 前端构建：dist/frontend
pnpm preview              # 预览前端生产构建：http://127.0.0.1:4173
```

正式界面代码位于 `frontend/src`。当前可使用页面导航、侧栏折叠、搜索和筛选控件、主题切换、设置选择及导入/下载表单校验。主题、侧栏状态和卡片点击偏好在本机保存；尚未接入的功能只提示“暂未接入”，不生成任务或假成功。详情和图箱只接受实际传入的影片与图片，不生成占位海报。最初的界面范围见 [界面实施说明](docs/decisions/0005-mantine-interface.md)，业务接入以各功能实施文档为准。

桌面端点击“导入影片”或“添加媒体目录”，选择文件夹后即可后台扫描并入库；支持递归、扩展名、进度、停止、重扫、增量更新、NFO 与本地海报导入。MediaInfo 确认视频流并读取时长和分辨率，pugixml 解析 NFO。并发由原生按 `max(1, min(逻辑处理器数 - 2, 16))` 自动计算，界面不显示并发设置，最多 16。浏览器预览不能扫描本机目录。实现及兼容策略见 [目录扫描决策](docs/decisions/0006-directory-scanning.md)。

媒体库按可见范围查询，每页最多 100 条、每个视图最多缓存 600 条；搜索、组合筛选、排序和发现聚合由原生 SQLite 后台执行。卡片和列表使用虚拟滚动，支持查询失败重试与收藏计数联动；设计和 5 万条合成数据验证见 [片库分页决策](docs/decisions/0010-library-paging.md)。

目录页已接入“重复视频”和“广告视频”：按番号与旧版兼容文件指纹分组，按零字节、重复文件名、关键词和排除词筛选，支持核对、单项选择与批量清理。删除前确认范围，可保留视频只清除刮削资料；删除视频保留 NFO 与封面；显式清除资料时拒绝共享资料冲突。旧记录缺少指纹时重新扫描目录即可补齐。见 [片库检查与清理](docs/decisions/0019-library-maintenance.md)。

桌面开发：

```powershell
pnpm desktop:setup        # 下载配置中锁定的官方宿主
pnpm metatube:build       # 编译精简 MetaTube，对比 EXE 和相同压缩参数的 ZIP 体积
pnpm metatube:verify      # 仅验证精简 MetaTube，使用隔离数据库和安全虚构数据
pnpm metatube:build --install # 编译并安装到 bin/tools/metatube
pnpm downloads:setup      # 复制已有 FFmpeg 到 bin/tools；完整运行依赖使用 offline:setup
pnpm desktop:dev          # 构建扩展，启动前端开发服务器与 Neutralino 窗口
pnpm desktop:build        # 构建扩展和前端，打包桌面目录：dist/desktop
pnpm desktop:offline      # 校验运行依赖并生成完整 Windows x64 离线包：dist/offline
pnpm test:offline         # 解压最新离线包，验证启动入口、系统 WebView2 和独立数据库
pnpm test:downloads       # 真实工具与 SQLite 下载集成测试
pnpm test:downloads:public # 显式联网完整下载五条公开 HLS 样本
pnpm test:playback        # 用合成素材验证 WebView2 中的本地和网络播放
pnpm test:player-window   # 验证独立无边框播放器及窗口生命周期
pnpm test:playback:preferences # 验证播放设置、跨窗口续播与外部程序启动
```

不要同时运行 `pnpm dev` 和 `pnpm desktop:dev`，二者使用同一个开发端口。`desktop:build` 是工程打包验证入口，尚不是通过发布验收的安装包。

公开 HLS 样本地址、旧版解析的参考范围和实测结果见 [公开流验证记录](docs/verification/2026-10-09-public-hls-streams.md)。联网样本测试保留原始日志及最终媒体文件，不进入普通测试或自动 CI。

本地运行请使用 `pnpm desktop:offline` 生成的 ZIP，完整解压后双击 **`JAVM.exe`**。随包提供 Release 静态运行库数据库扩展、MediaInfo、FFmpeg、curl 和 MetaTube，无需另装 Node.js、pnpm 或开发工具。界面由官方 Neutralino 宿主调用系统已安装的 **Evergreen WebView2 Runtime**，包内不再携带固定版本运行时，也不覆盖系统的运行时选择。Windows 11 预装，绝大多数 Windows 10 已安装；缺少时需先安装[微软 WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)，无网设备可提前准备其离线安装程序。

适用于 Windows 10/11 x64；满足上述系统前提后，本地片库、扫描和播放可离线使用。网络下载、MetaTube 在线资料和 AI 服务仍需要网络，AI 需要自行配置接口。个人数据仍保存在当前 Windows 用户的数据目录，不随软件包分发。

FFmpeg 采用参考老版 `ddmoyu/ffmepg` 裁剪配置的 **8.0.1 精简构建**，保留 JPEG 抽帧、MP4 无损合并与进度输出，关闭网络、硬件加速与视频转码。媒体轨道和时长检查复用内置 MediaInfo，不再构建或分发 ffprobe。打包会校验构建凭据、二进制哈希、体积和实际能力，拒绝混入完整版。来源与复现方式见 [精简 FFmpeg](docs/decisions/0013-lightweight-ffmpeg.md)。

依赖版本、下载地址和 SHA-256 锁定在 `scripts/offline-dependencies.json`，首次准备需要联网，缓存齐全后可运行 `pnpm offline:setup --Offline` 复用。离线包每次写入新的时间戳目录，不覆盖已有运行目录；包内只有 `JAVM.exe` 和 `bin` 运行依赖目录，窗口和托盘图标已嵌入 EXE，不另带 `resources` 目录。中文说明和校验脚本保留在开发目录，第三方许可证、构建记录和文件清单位于 `build/offline-manifests`，ZIP 旁附带 `.sha256` 校验值。`dist/offline/latest.json` 指向最近一次输出。WebView2 由系统安装及更新，程序不配置其路径或修改其目录权限。

`desktop:build` 输出的基础目录仍位于 `dist/desktop/javm`，主程序为 `javm-win_x64.exe`，前端资源嵌入 EXE。完整运行环境以 `desktop:offline` 输出为准。原生发布构建使用独立的 `windows-release` preset，不携带 Debug CRT。

C++ / SQLite 构建：

```powershell
pnpm native:build
& .\build\native\windows-msvc\bin\javm_database.exe --version
```

脚本通过 `vswhere -prerelease` 发现 Visual Studio，并使用 `vcvars64.bat` 初始化 MSVC 环境。通用构建入口为 `cmake --preset native` 与 `cmake --build --preset native`；macOS/Linux 尚未实测。

`javm_database --version` 只验证 C++ 与 SQLite 链接，不创建数据库。桌面已启用官方 Extension；新媒体库 `library.sqlite3`（schema 1）与下载库 `downloads-v1.sqlite3` 独立保存。启动发现 0.5.3 旧库时显示引导；确认后备份新旧库、转换作品与资源、归档原始记录并校验，成功后清理旧库，保留恢复副本和完成记录。新版已有资料优先，失败或取消保留原数据；详见 [旧库导入](docs/decisions/0018-legacy-database-import.md)。不兼容开发期媒体 schema，未知文件不删除重建。扫描读取 NFO；刮削可以安全更新规范 NFO 并保留原文件备份。构建同时准备 MediaInfo.dll 和依赖许可证，发布时须携带它们。

## 目录

```text
frontend/src/
  app/                    应用外框、界面状态与 Velvet 主题
  components/             共享控件、海报与 Fancybox 图箱
  features/               片库、发现、下载、刮削、目录、设置和详情界面
  services/               片库、下载、刮削、取流、播放、资料与设置服务
  platform/neutralino/    官方客户端、进程、文件、网络及窗口适配
  repositories/           数据访问预留
  contracts/              影片、图片、文件与任务类型
  scrapers/               站点适配预留
  styles/                 基础样式
native/database/          C++20 / SQLite 官方 Extension
native/media/             MediaInfo、pugixml、有界后台扫描与媒体数据库
resources/                宿主和前端共用静态资源
scripts/                  本机开发脚本
tests/                    安全样例、单元与集成验证
docs/                     重构约定、选型和验证记录
```

## 当前边界

- 下载、播放、MetaTube 单片／批量刮削、封面落盘、规范 NFO 写回与下载后入库已接入。番号资源查找使用隐藏 Neutralino，完成 HLS 校验后可复制或交接下载；真实站点兼容性未验证，见 [资源查找验证](docs/verification/2026-10-10-resource-lookup.md)。
- 截图及封面编辑、资源结果回显、维度收藏、文件改名／移动、健康检查、资料补全、多 AI 配置、深度链接和片库备份恢复已接入；更新采用官方发布检查与手动下载。字幕和多语言音轨选择明确不做，磁力暂缓。演员搜索使用在线查询，现有名单默认网站顺序并停止扩充；未证实该顺序代表热度。完整清单见 [功能开发状态](docs/FEATURE_STATUS.md)。
- 0.5.3 迁移已用合成数据库验证；维度收藏与别名提供归档恢复，旧任务保留且不自动执行。日常片库备份覆盖资料和关联记录，不包含媒体文件、下载库或设置。安全桌面完整流程和恢复验证见[模块闭环记录](docs/verification/2026-10-11-module-closure.md)；NAS、慢盘及完整发行环境仍需独立验收。
- 桌面窗口使用官方窗口 API，首次启动居中显示；关闭窗口可按设置留在托盘继续任务，显式退出先停止任务并保存状态。已验证对应事件处理器，长期托盘队列和系统级交互仍需独立验收，见 [后台运行验证](docs/verification/2026-10-10-background-running.md)。
- `pnpm test` 包含查询规则、空资料边界、下载状态机与播放会话测试；`pnpm test:downloads` 覆盖实际下载、合并、进程退出与 SQLite，`pnpm test:playback` 覆盖合成素材的真实播放。通过测试不代表网站、所有编解码器或发布包已全面验收。
- GitHub Actions 仅保留手动触发。提交、推送和 PR 不自动运行检查；旧发布工作流已移除，不自动创建 Release。
- `pnpm test:metadata` 使用隔离的桌面宿主和本机模拟接口验证真实传输与加密存储，并运行已准备的包内 MetaTube，验证按需启动、驻留及宿主退出后的进程回收。测试不使用真实片库或供应商密钥，初始验证见 [资料辅助验证](docs/verification/2026-10-09-metatube-ai.md)。
- 版本组合、选择原因与阶段差异见 [初始化决策](docs/decisions/0001-initialization.md)。

原项目基线：`dd0e6b62b263258b6e78106c72017b3b470b4097`。项目沿用 MIT 许可证，见 [LICENSE](LICENSE)。
