# macOS / Linux 适配计划

日期：2026-10-13。状态：基础、核心、工具监督、隔离探测及完整媒体服务的平台文件操作已实现；macOS / Linux 实际构建与运行待验证。

依据：[重构计划](REFACTOR_PLAN.md)、[缺口核对](CROSS_PLATFORM_STATUS.md)及现有 ADR。用户已授权推进无需产品选择或外部凭据的部分；技术实现与安全 mock 验证可继续开展。

## 目标与边界

- 保留 React / Mantine / TypeScript / 官方 Neutralino，继续使用官方 Extension 协议；重用现有业务服务和 SQLite 数据契约。
- 用户已确认首发范围：macOS 13+ Apple Silicon / Intel（APP + DMG）、Ubuntu 24.04 x64（AppImage + DEB），开发包先不签名。Windows x64 保持现有行为。
- 当前已交付版本仍是 [v1.0.5-alpha.4](https://github.com/ddmoyu/javm/releases/tag/v1.0.5-alpha.4) 的 Windows Setup + Portable。本地后续开发版本为 `1.0.5-alpha.9`，不代表新增平台已经可以下载。
- 不引入 Android / Windows ARM64，不扩展字幕、多音轨或业务来源；开发和测试只使用安全合成数据、占位素材与回环服务。
- 原生编译成功、宿主能启动、业务可用、安装可用分别验收。平台未达到发布门槛前，保留业务启动限制和现有发布矩阵。

## 分阶段推进

| 阶段            | 工作与依赖                                                                                                                             | 完成条件                                                                                                         | 当前状态                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1. 通用基础     | 统一系统目录；选择正确架构的 Neutralino 宿主；独立 UTF-8 校验；手动基础检查矩阵                                                        | Windows 数据位置兼容；POSIX 路径不再要求盘符；未知目标明确失败；纯原生工具可独立编译                             | 已实现，本机针对性验证完成；远端矩阵待运行                     |
| 2. 最小原生闭环 | 抽离通信和宿主监护；实现 curl WebSocket、退出清理、按平台选择 TLS；独立开发配置接入三平台命令及构建入口                                | 官方 Extension 完成认证、请求、事件、关闭；安全临时 SQLite 可读写；HTTP 回环、超时、取消可用；宿主异常退出无残留 | 核心已实现，Windows 两种通信及官方宿主验证通过；目标系统待验证 |
| 3. 媒体与工具   | POSIX 子进程组、参数与执行权限；动态库加载；MediaInfo / FFmpeg / curl / MetaTube 工具路径；文件身份、锁、符号链接、原子替换和 NFO 编码 | 扫描、探测、下载、合并、封面生成均通过安全样例；取消后仅回收本应用进程树；中文、空格、大小写与符号链接用例通过   | 工具监督、探测及完整媒体文件层已实现；目标平台运行待验证   |
| 4. 桌面业务     | 逐项启用能力；系统密钥存储；托盘和明确退出；外部播放器；多显示器、深度链接；WKWebView / WebKitGTK 播放及隐藏解析                       | 不阻塞 UI；任务跨页面与关窗继续；显式退出可靠回收；凭据不落明文；可用能力与界面入口一致                          | 待开发，部分产品行为与目标系统需确认                           |
| 5. 组件与分发   | 按平台增加可复现组件配方与指纹；Mach-O / ELF 架构、运行库和许可证检查；APP / DMG 与 Linux 安装包；按平台识别更新附件                   | 精确配方的组件 Release、资产哈希、安装/覆盖安装/卸载保留数据、干净机器运行均通过，再加入下载表格                 | 待开发；首发基线、包格式和无签名开发包已确认                             |

阶段 2 不应一次性删除媒体构建的 Windows 限制：先隔离可构建模块，再逐项移植调用点，避免“配置通过但运行即失败”。新增目标先用独立开发构建与安全夹具；发布流程继续只消费已验证的平台组件。

## 第一阶段实现

### 系统路径

`frontend/src/platform/neutralino/applicationPaths.ts` 集中处理应用数据和缓存目录，已接入目录种子、旧 CSV 导入、头像缓存和图片预览缓存。

| 系统    | 目录副本                               | 图片 / 头像缓存                                     |
| ------- | -------------------------------------- | --------------------------------------------------- |
| Windows | `%LOCALAPPDATA%/JAVM/catalogs/...`     | `%LOCALAPPDATA%/JAVM/cache/...`，保持原位置         |
| macOS   | `os.getPath("data")/JAVM/catalogs/...` | `os.getPath("cache")/JAVM/...`                      |
| Linux   | `os.getPath("data")/JAVM/catalogs/...` | `os.getPath("cache")/JAVM/...`，由宿主解析 XDG 设置 |

保留空格和 Unicode 路径；支持 Windows UNC 重定向；拒绝空路径、相对路径及越界子目录；读取失败允许重试，不静默回退到应用安装目录。这里只改目录副本与缓存，数据库、Neutralino storage、MetaTube 数据和凭据的位置继续沿用当前契约，后续分别核对。

Windows 不能直接把旧 `LOCALAPPDATA` 替换成 `os.getPath("data")`：Neutralino 6.10.0 的 Windows `data` 实际指向 Roaming，而 macOS 为 Application Support、Linux 为 XDG data。依据：[官方 API](https://neutralino.js.org/docs/api/os/#osgetpathname)、[锁定版本的路径实现](https://github.com/neutralinojs/neutralinojs/blob/v6.10.0/lib/platformfolders/platform_folders.cpp)。

### 宿主与原生基础

- `scripts/desktop-host.mjs` 为 Windows x64、Linux x64、macOS x64 / arm64 选择对应宿主，不默认借用其他架构；`desktop:setup` 保留独立暂存区，复制当前目标并设置 Unix 执行权限。应用打包和 `desktop:dev` 的非 Windows 原生链路仍待后续阶段完成。
- `native/common/utf8.hpp` 用标准 C++ 校验 UTF-8；HTTP 响应头已使用该实现，移除了此处的 `windows.h` 与 `MultiByteToWideChar`。仍拒绝过长编码、代理项、截断序列及超范围码点，不修改 HTTP 业务协议或错误语义。
- `tests/native` 是不依赖应用、第三方组件和数据库的独立 CMake 夹具。`pnpm native:build -PortabilityChecks` 使用现有 `vswhere -prerelease` / MSVC 发现流程，仅编译这些夹具，不覆盖应用扩展。
- `.github/workflows/portability-checks.yml` 仅允许手动触发，包含 Windows x64、Linux x64、macOS arm64 / x64 的基础检查。没有新增 push / PR 自动触发，也不创建 Release。runner 选择来自 [GitHub 官方矩阵](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)；CI 镜像版本不等于产品最低系统版本。

## 第二阶段实现

### 原生核心与官方通信

- `JAVM_CORE_ONLY` 单独构建 SQLite、HTTP 和 Extension 通信，输出 `build/native/<preset>/bin/javm_database_core[.exe]`，许可证留在该构建目录。不会复制到应用 `bin`，媒体库和扫描器不参与链接。Windows 核心构建还编译一份完整入口的目标文件，检查媒体分支编译兼容性，但不链接或部署完整应用。
- Windows 默认继续使用 WinHTTP 和既有宿主进程监护。macOS / Linux 使用锁定版本 libcurl 的 WebSocket；Windows 可通过 `--curl-transport` 编译同一实现来验证。HTTP 的官方 Extension 事件及数据库协议保持版本 1。
- curl 后端由一个 I/O 线程管理连接，收发队列各限制 64 条 / 8 MiB，单消息上限 4 MiB；业务线程可以并发提交。支持部分发送、分帧 UTF-8、控制帧和失败反馈；发送期限 5 秒，心跳每 5 秒一次、Pong 等待上限 5 秒。断连后先清理 HTTP 和数据库；若清理卡住，独立监护在约 2 秒后结束扩展自身。
- `capabilities` 返回数据库、HTTP、媒体和传输能力，查询不打开数据库；核心构建明确拒绝媒体请求。未打开数据库时执行 `close` 不再创建空数据库。
- `tests/fixtures/core-extension/neutralino.config.json` 提供 `commandWindows`、`commandLinux`、`commandDarwin`。真实官方宿主验证仅运行隔离目录内的 `cloud` 模式，使用空白安全页面和合成数据库。该配置只用于开发验收；正式配置在媒体与能力开关完成后再接入非 Windows 命令。

通信依据：[官方 Extension 启动与事件协议](https://neutralino.js.org/docs/how-to/extensions-overview/)、[libcurl WebSocket](https://curl.se/libcurl/c/libcurl-ws.html)。空闲 Ping 的及时回应使用 [CURLWS_NOAUTOPONG](https://curl.se/libcurl/c/CURLOPT_WS_OPTIONS.html) 加显式 Pong，避免自动回应滞留发送缓冲。

### 存储与 TLS

数据库拥有者锁抽为平台实现：Windows 保留独占文件句柄，POSIX 使用 `flock`、`O_CLOEXEC` 和 `O_NOFOLLOW`；POSIX 释放时保留锁文件，避免删除后重建 inode 导致双实例同时加锁。升级备份路径使用原生 `filesystem::path` 加 ASCII 后缀，不经宽字符往返转换，保留中文、空格和 emoji 路径。现有 SQLite 数据结构和升级备份策略不变。

TLS 构建按平台选择：Windows 使用 Schannel，Linux 使用 OpenSSL 和系统 CA，macOS 使用 OpenSSL 加系统 SecTrust。HTTP 仍启用证书及主机名验证。curl 通信构建保留 HTTP(S) / WS(S)，其他协议关闭；已发布的 Windows HTTP-only 组件不能误用于 WebSocket 构建，发布组件配方及指纹未变。目标平台 TLS、代理和证书库运行验证仍待完成。

### 开发入口与验证

`pnpm native:build` 改为跨平台分发入口。Windows 仍调用 PowerShell 脚本，以 `vswhere -prerelease` 发现 MSVC；保留旧参数。非 Windows 当前要求 `--core-only` 或 `--portability-checks`，不能误启动尚未适配的完整构建。Linux 需要 CMake、Ninja、C/C++ 工具链和 OpenSSL 开发包；macOS 需要 Xcode 工具链、CMake、Ninja 和 OpenSSL 3，脚本可发现已安装的 Homebrew OpenSSL，也可使用 `OPENSSL_ROOT_DIR`。

```powershell
# Windows 默认通信核心
pnpm native:build --core-only
$env:JAVM_CORE_EXE = 'build/native/windows-core/bin/javm_database_core.exe'
$env:JAVM_CORE_TRANSPORT = 'winhttp'
node --disable-warning=ExperimentalWarning --test scripts/core-extension.test.mjs

# 同一跨平台通信实现，在 Windows 上验证
pnpm native:build --core-only --curl-transport
$env:JAVM_CORE_EXE = 'build/native/windows-core-curl/bin/javm_database_core.exe'
$env:JAVM_CORE_TRANSPORT = 'curl'
node --disable-warning=ExperimentalWarning --test scripts/core-extension.test.mjs

# 真实官方宿主，仍使用隔离数据和无界面模式
$env:JAVM_NEUTRALINO_EXE = 'bin/neutralino-win_x64.exe'
node --test scripts/core-neutralino.test.mjs
```

```sh
# Linux；macOS 把 linux-core 改为 macos-core
pnpm native:build --core-only
JAVM_CORE_EXE=build/native/linux-core/bin/javm_database_core \
JAVM_CORE_TRANSPORT=curl \
node --disable-warning=ExperimentalWarning --test scripts/core-extension.test.mjs
```

手动 Actions 矩阵已接入上述核心构建、同一套模拟宿主用例和真实官方宿主用例；Windows 额外覆盖 curl 后端。它只验证开发产物，不发布平台组件或桌面安装包。

本轮本机验证：两个核心 EXE 经 MSVC 编译；完整 Windows 入口目标文件编译通过。新用例共通过 32 项执行：构建入口 4 项、WinHTTP 核心 12 项、curl 核心 14 项、真实 Neutralino 宿主两种通信各 1 项。覆盖认证、非法信封、分帧及大消息、中文数据库迁移备份、多实例锁、HTTP 并发/取消/超时、正常关闭、异常断连、失去心跳和 SQLite 忙等待期间退出；curl 空闲 Pong 修复后响应在 2 秒测试期限内完成。类型与 lint 检查只针对新增脚本。

尚未运行 macOS / Linux 真机或远端 Actions，没有进行完整应用构建、桌面界面验证、全量测试、提交、推送或发布。因此第二阶段完成的是核心实现与 Windows 上的协议验证，POSIX 文件锁、目标 TLS 后端和目标宿主仍需在各系统验收。下一阶段可继续移植媒体平台接口及进程生命周期，正式业务入口继续保留能力限制。

## 第三阶段已完成部分：媒体工具路径与 POSIX 进程监督

### 工具查找与调用边界

`toolPaths.ts` 统一区分 Windows `.exe` 与 macOS / Linux 无后缀程序，已接入下载器、播放请求传输及 MetaTube 内置路径。显式配置优先且无效时直接失败；没有配置才依次查找随包工具和系统 PATH。POSIX 检查绝对路径、普通文件及实际 `X_OK` 权限，保留大小写、空格、Unicode、反斜线和可执行文件符号链接；跳过 PATH 中空项、相对目录及不可执行候选，最多检查 256 个目录。随包文件不可执行直接报告包权限问题，不静默换用系统工具。

MetaTube 的工具名称与权限检查已适配，但非 Windows 启动仍明确拒绝：其本地端口分配、系统凭据和平台组件尚未接通。MediaInfo 动态库及隔离探测见下方后续实现；工具路径可解析不代表完整媒体业务已完成。正式业务的 Windows 能力限制和发布矩阵继续保留。

### 监督器与生命周期

- `native/process` 在 Unix 核心构建中输出 `build/native/<preset>/bin/javm_process`。开发产物不复制到正式应用；后续完整包部署位置为 `bin/javm_process`。它仅承担进程生命周期，工具 stdout / stderr 和退出码仍经官方 `os.spawnProcess` / `spawnedProcess` 传递，不增加业务通信协议或服务器。
- Neutralino 的 Unix 启动经过 `/bin/sh -c`，适配器使用 `exec` 让监督器直接成为宿主子进程。监督器持续比较 `getppid()` 与启动时的宿主 PID，避免把复用的 PID 当作原宿主。工具由 `posix_spawn` 接收原样 argv，位于独立进程组；环境仅覆盖指定项，保留其他继承值，工具 stdin 指向 `/dev/null`。额外继承的文件描述符在启动工具前关闭。
- 参数通过随机私有目录传入：目录先设置 `0700`，再写入 `0600` JSON。原生端检查所有者、目录 / 文件权限、文件类型及硬链接数，拒绝最终路径符号链接，并在打开后立即删除参数文件。参数最多 1024 项、环境覆盖最多 64 项，字符串总量 128 KiB、文件 256 KiB；拒绝 NUL、非法 UTF-8、相对程序路径和非法环境名称。诊断不回显参数、令牌或解析上下文。
- 取消使用官方 `stdInEnd`；宿主退出、TERM / INT / HUP 及可选原生超时也进入相同回收流程。先向所拥有的组发送 TERM，1 秒后 KILL；在组回收前通过 `waitid(..., WNOWAIT)` 保留 leader 身份，防止 PID / PGID 复用。正常 leader 退出也清理同组残留后代，保留原始退出码；Linux 使用 subreaper 回收被接管的同组后代。输出背压不阻塞监督器的监护循环。
- 前端当前会话同时最多 16 个 POSIX 监督器，不增加等待队列。恢复与取消先匹配官方进程的 id 和 pid，避免误操作其他进程；停止 5 秒仍无法确认时保留可重试错误及并发名额。若内核不可中断 I/O 使进程无法退出，监督器继续等待，不能假报已停止。

监督范围为以前台方式运行并留在所建进程组内的工具，不能承诺回收自行 `setsid` 脱离的守护进程，也不能在监督器自身被 SIGKILL 后执行用户态清理。当前 curl / FFmpeg / MetaTube 按前台启动契约使用；不按名称全局杀进程。

实现依据：[锁定版本的 Neutralino Unix 进程启动](https://github.com/neutralinojs/neutralinojs/blob/v6.10.0/lib/tinyprocess/process_unix.cpp)、[官方执行权限与 chmod 实现](https://github.com/neutralinojs/neutralinojs/blob/v6.10.0/api/fs/fs.cpp)、[POSIX spawn 属性](https://man7.org/linux/man-pages/man3/posix_spawn.3.html)、[waitid / WNOWAIT](https://man7.org/linux/man-pages/man2/waitpid.2.html)。

### 本轮验证与下一步

本机 Windows 已通过 19 个新增前端用例，覆盖两个 POSIX 平台的工具名称、内置 / 配置 / PATH 顺序、权限、特殊字符、私有参数、官方进程事件、取消 / 恢复、PID 不匹配、失败清理、停止重试、16 并发上限及 Windows 既有监督器格式。独立核心经 MSVC 编译；新增参数解析 CTest 通过，含 20 个有效 / 无效边界检查。修改的 TS 与新增 Node 脚本定向类型 / lint 检查通过。既有下载适配测试只补齐 Windows 平台 mock，没有运行既有测试或全量测试。

新增 8 个原生进程用例和 1 个真实官方 POSIX 宿主用例，已接入手动矩阵。覆盖字面参数 / 环境 / 双流、自然退出、忽略 TERM 的后代、EOF / 信号 / 超时、宿主异常退出、输出背压、无关进程隔离、私有目录、符号链接及实际官方权限 / 进程 API。本机均按平台跳过，尚未在 macOS / Linux 编译或执行；这些用例不能计入已通过的目标平台验证。

```powershell
pnpm exec vp test run tests/tool-paths-platform.test.ts tests/posix-process-adapter.test.ts
pnpm native:build --core-only
ctest --test-dir build/native/windows-core -R '^javm_process_spec$' --output-on-failure
```

```sh
# 目标系统开发验证；macOS 将 linux-core 换为 macos-core，并选择对应宿主文件。
pnpm native:build --core-only
JAVM_PROCESS_EXE=build/native/linux-core/bin/javm_process node --test scripts/posix-process.test.mjs
pnpm desktop:setup
JAVM_PROCESS_EXE=build/native/linux-core/bin/javm_process \
JAVM_NEUTRALINO_EXE=bin/neutralino-linux_x64 node --test scripts/posix-neutralino.test.mjs
```

以上工具监督阶段未进行完整应用构建、桌面运行、提交、推送或发布，未触发远端 Actions。后续独立探测实现如下，文件身份 / 原子替换 / NFO 编码仍待推进。

## 第三阶段后续：MediaInfo 动态加载与隔离探测

### 模块与兼容性

`native/probe` 将 MediaInfo C API、系统路径、结果校验与进程捕获独立出来。现有 `media::probeDirect` / `media::probe` 改为薄适配，保留 `--media-probe` 内部工作进程入口及原有 JSON 字段。前端仍通过官方 Extension 调用；没有另建业务协议或服务。独立核心同时构建探测库与开发夹具，核心 Extension 的 `media` 能力仍为 false，不接入尚未移植的扫描器。

动态库只从程序同目录的固定绝对路径加载：Windows `MediaInfo.dll`，Linux `libmediainfo.so.0`，macOS `libmediainfo.0.dylib`。Windows 保留受限 DLL 搜索标志；Unix 使用 `RTLD_NOW | RTLD_LOCAL`。缺库或缺少必需 API 明确失败，库句柄晚于 MediaInfo 对象释放。C API 声明复用组件清单中锁定版本及 SHA-256 的源码，不改现有 Windows 组件配方与指纹；Unix 的正式组件构建与依赖装载仍属后续分发阶段。

所有平台继续调用官方宽字符 C API。`native/common/unicode.hpp` 显式处理 Windows UTF-16 与 POSIX UTF-32，路径与返回字段不依赖全局 locale；拒绝非法编码和孤立代理项。原生 `ProbeService` 已接入该路径转换。数值解析使用固定小数点，过滤 NaN / 无穷大、负值和溢出，保留视频 → 容器 → 音频的时长回退与毫秒四舍五入。

### 子进程与结果限制

- Windows 保留显式继承句柄、挂起启动、Job Object 和低优先级。结果在运行时持续排空，解决旧代码等退出后才读取而导致管道填满的问题；取消、超时、输出过长或异常退出均先回收工作进程。调用者异常退出由 Job Object 关闭回收。
- POSIX 原生调用者用 `posix_spawn` 直接启动上一阶段 `javm_process`，原样传递参数，私有参数目录由 `mkdtemp` 原子创建。控制管道 EOF 触发取消，监督器还监护其实际父进程（本场景为原生 Extension）。不直接杀监督器来代替回收工具组。
- Linux 使用 `posix_spawn_file_actions_addclosefrom_np`，CMake 检测缺失即失败；当前开发实现需要 glibc 2.34+。macOS 使用 `POSIX_SPAWN_CLOEXEC_DEFAULT`；标准流显式复制，其他句柄不继承。这是开发实现的要求，最终产品系统基线仍待分发验收。
- 默认 15 秒超时，输出上限 16 KiB。解析前校验 UTF-8、结构和字段类型；异常结果不会当作成功媒体信息写入。扫描与单独探测共享 `max(1, min(逻辑处理器数 - 2, 16))` 名额，等待可取消；队列仍由既有原生服务限制。不可中断的内核 I/O 仍可能推迟实际回收，不能据超时请求假报已停止。

实现依据：[MediaInfo 26.10 官方 C API](https://github.com/MediaArea/MediaInfoLib/blob/v26.10/Source/MediaInfoDLL/MediaInfoDLL_Static.h)、[官方宽字符实现](https://github.com/MediaArea/MediaInfoLib/blob/v26.10/Source/MediaInfoDLL/MediaInfoDLL.cpp)、[glibc 2.34 spawn 声明](https://github.com/bminor/glibc/blob/release/2.34/master/posix/spawn.h)、[Apple spawn 标志](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/spawn.h)。

### 本轮验证

Windows 独立构建经 MSVC 通过，包含探测库、生产适配层目标文件、完整 Windows 入口目标文件和两种安全模拟 DLL。新增 CTest 通过 35 个边界检查，覆盖 UTF-16 / UTF-32、Unicode 路径、并发上下限、无效及超大结果。

新增 Node 用例 15 项全部通过：动态库加载与缺符号、原有结果字段、Unicode 路径和大于 4 KiB 的结果、数值异常、空指针、异常轨道数、打开失败、工作进程退出、过量输出、超时、取消、调用者异常退出及并行任务隔离。其中 1 项复制本机既有真实 MediaInfo DLL 到隔离目录，只读取代码生成的 1 秒静音 WAV；没有使用用户媒体或数据库。定向 Node lint / 类型检查通过。

```powershell
pnpm native:build --core-only
ctest --test-dir build/native/windows-core -R '^javm_probe_boundaries$' --output-on-failure
$env:JAVM_PROBE_BUILD = 'build/native/windows-core'
$env:JAVM_MEDIAINFO_LIBRARY = 'bin/MediaInfo.dll'
node --test scripts/media-probe-platform.test.mjs
```

macOS / Linux 使用同一新增用例，将 `JAVM_PROBE_BUILD` 指向 `build/native/macos-core` 或 `build/native/linux-core`。手动矩阵已接入构建、边界 CTest 与 14 项模拟库运行用例；未提供真实平台库时，静音 WAV 用例显式跳过。模拟 DLL / dylib / so 和探测夹具只留在 `build/native/<preset>`，不复制到应用目录或安装包。

本轮没有运行已有测试、全量测试、完整应用构建或桌面 UI，也未提交、推送、触发 Actions 或发布。POSIX 源码和用例已经准备，但未在 macOS / Linux 编译运行，不能据 Windows 结果宣布支持。下一步是文件身份、符号链接、原子替换和 NFO 编码，随后才是完整扫描模块及业务能力启用。

## 第三阶段：文件语义与完整媒体服务

完整扫描、整理、备份和 NFO 已接入平台文件层。隔离构建新增 `javm_library_fixture`，链接完整媒体服务并使用官方 Extension 协议；生产宿主配置暂不开放 POSIX 业务。

- 所有媒体路径显式从 UTF-8 转换，POSIX 反斜杠和冒号保持字面含义。Windows 保留原有不区分大小写键；Linux 保留大小写；macOS 查询卷的大小写规则。根目录边界比较修正为支持 POSIX 根目录。
- 文件身份使用 Windows 原有卷/文件索引格式或 POSIX device/inode。新建使用独占创建，整理和备份使用不覆盖的原子移动；覆盖 NFO 前检查签名并保留备份。POSIX 同步文件和目录，失败保留恢复记录。
- 主实例在 POSIX 使用保留 inode 的 flock。损坏库归档使用 POSIX 字节范围锁与 Win32 文件共享锁。POSIX 旧库迁移使用 SQLite 一致快照并保留原库及侧车，不宣称能用 flock 阻止其他 SQLite 写入。
- NFO 的 UTF-16 / UTF-32 解码不再依赖 wchar_t 宽度，旧编码在 POSIX 使用 iconv。中文自然排序与大小写查询在 POSIX 使用 ICU；Windows 保持原 API。开发构建需要 ICU 与 iconv，macOS 自动发现已安装的 Homebrew SDK。

本机 Windows 已编译完整媒体服务与隔离扩展；新增 CTest 通过 35 项边界检查，新增 Extension 集成通过 7 项，另 2 项仅 POSIX/Linux 适用而跳过。包含合成媒体扫描、NFO、双实例、改名冲突与重启恢复、分段复制核对、有效/损坏库恢复、链接循环和取消回收。未读取用户库或媒体、未运行全量测试。

手动矩阵已添加相同验证。已有 Alpha 工作流在非标签手动运行时调用跨平台检查，便于默认分支尚未注册新工作流时验证开发分支；原标签发布路径不变，不因推送或 PR 自动触发工程检查。

依据：[Apple 文件系统大小写查询常量](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/unistd.h)、[Linux 原子重命名](https://man7.org/linux/man-pages/man2/rename.2.html)、[文件和目录同步](https://man7.org/linux/man-pages/man2/fsync.2.html)、[ICU 排序属性](https://unicode-org.github.io/icu/userguide/collation/customization/)。

## 需要后续确定的产品与环境条件

以下事项影响后续交付，当前基础工作不依赖其答案：

| 事项                   | 建议与需确认内容                                                                     | 确定前可继续做的工作                                               |
| ---------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 系统基线               | macOS 最低版本、Intel 的支持期限；Linux 首个发行版及桌面环境、glibc / WebKitGTK 下限 | 纯 C++ / TS 改造与开发机构建，不承诺安装兼容范围                   |
| 安装形式               | macOS 默认 APP + DMG；Linux 先确定 AppImage / DEB 的首发组合，RPM 按实际目标再决定   | 分离运行目录和打包步骤、验证组件清单，不发布占位下载入口           |
| 凭据存储               | macOS 优先 Keychain；Linux 优先 Secret Service，需定义无密钥环或密钥环锁定时的交互   | 抽出凭据接口，保留 Windows DPAPI；未可用时明确失败，不能回退到明文 |
| macOS / Linux 关窗行为 | 是否完整延续关窗驻托盘；Linux 无托盘环境的后台任务与退出入口                         | 维持任务生命周期与窗口生命周期分离，提供可验证的退出清理           |
| 签名、公证与验收设备   | macOS 开发者证书 / 公证账号、各目标系统的真机或虚拟机；Windows 签名沿用单独安排      | 本地开发、无签名构建与结构检查；不能据此承诺正式分发体验           |

这些是产品或环境输入，纯技术取舍、常规代码修复与安全夹具实现不需要逐项等待审批。下一实现重点是目标平台验证、桌面能力与分发。

## 第一阶段验证记录与后续验收

第一阶段本机 Windows：新增目录与缓存适配用例 27 项、宿主选择和复制用例 5 项通过；独立 C++ UTF-8 夹具经 MSVC 编译，覆盖 1,112,064 个 Unicode 标量及截断形式、32 个边界样例，CTest 通过。修改文件的类型与 lint 检查通过。既有三个图片 / 头像缓存测试文件仅补齐 `NL_OS` mock，不扩大运行到既有测试集。第二阶段没有重复运行这些既有用例。

可重复执行的针对性命令：

```powershell
pnpm exec vp test run tests/application-paths.test.ts tests/cache-platform-paths.test.ts
node --test scripts/desktop-host.test.mjs
pnpm native:build -PortabilityChecks
ctest --test-dir build/native/portability-checks --output-on-failure
```

macOS / Linux 原生夹具使用 `cmake -S tests/native -B build/native/portability-checks` 和 `cmake --build build/native/portability-checks`；其余命令一致。

本轮没有运行全量测试、完整应用构建、桌面运行或 macOS / Linux 设备验证，没有提交、推送或触发远端 Actions。宿主文件名及路径分支的 Windows mock 验证不能替代其他系统的真实运行结果。

完整平台验收仍须覆盖：冷启动与二次启动、临时数据库升级、扫描取消、下载中关窗与显式退出、异常宿主退出、代理与证书、无密钥环、离线启动、HLS / MP4 与 Range、大小写冲突、Unicode 文件名、符号链接循环、慢 I/O、大目录、DPI / 多显示器，以及安装后执行权限和运行库装载。只用隔离的安全样例，不读取用户媒体或旧数据库。
