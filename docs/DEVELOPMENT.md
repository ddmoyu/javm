# 开发与构建

日常开发统一在 `main` 进行，完整约定见 [AGENTS.md](../AGENTS.md)，架构依据见[重构计划](REFACTOR_PLAN.md)及后续 ADR。

## 环境

- Node.js：以 [.node-version](../.node-version) 为准，满足 `package.json` 的 `engines`。
- pnpm：以 [package.json](../package.json) 的 `packageManager` 为准；只维护根目录的一份锁文件。
- Windows 原生构建：Visual Studio C++ 工具链、CMake 3.25+、Ninja。脚本通过 `vswhere -prerelease` 发现 MSVC 并初始化环境。
- Windows 桌面运行：系统 WebView2 Runtime；构建安装包另需 Inno Setup 6。
- 组件下载：GitHub CLI；首次安装依赖、准备宿主和组件需要联网。
- 维护组件源码时才需要 Go、Git Bash、NASM 等工具，具体版本以组件配方为准。

macOS / Linux 的依赖、构建入口与验证边界见[跨平台计划](CROSS_PLATFORM_PLAN.md)和[支持核对](CROSS_PLATFORM_STATUS.md)。

## 前端与桌面

```powershell
pnpm install --frozen-lockfile
pnpm dev                  # 浏览器预览，默认端口 5173
pnpm build                # 前端生产构建，输出 dist/frontend
pnpm preview              # 预览生产构建，默认端口 4173
```

浏览器模式不连接原生数据库，也不能扫描本地目录。桌面开发使用：

```powershell
pnpm desktop:setup        # 准备锁定版本的宿主
pnpm offline:setup        # 下载并校验匹配配方的运行组件
pnpm desktop:dev          # 构建原生扩展并启动桌面开发窗口
```

`pnpm dev` 和 `pnpm desktop:dev` 共用开发端口，不要同时运行。桌面调试必须使用隔离的数据目录与安全样例，不得读取真实用户片库。

## Windows 构建与打包

```powershell
pnpm native:build         # Debug 原生扩展
& .\build\native\windows-msvc\bin\javm_database.exe --version

pnpm desktop:offline      # 准备组件、Release 构建并生成完整便携 ZIP
pnpm desktop:installer    # 基于最新便携包生成 Windows 安装包
```

`--version` 只检查链接与版本输出，不创建数据库。`pnpm desktop:build` 生成的基础桌面目录不等同于完整运行包；本地分发使用 `desktop:offline` 的产物。

| 产物             | 位置                                                      |
| ---------------- | --------------------------------------------------------- |
| 前端构建         | `dist/frontend`                                           |
| 基础桌面目录     | `dist/desktop/javm`                                       |
| 完整便携包       | `dist/offline`，最新输出记录在 `dist/offline/latest.json` |
| Windows 安装包   | `build/installer`                                         |
| 组件解析记录     | `build/dependencies/resolved.json`                        |
| 逐文件清单与许可 | `build/offline-manifests`                                 |

完整 Windows 包保留一个根入口 `JAVM.exe`，媒体工具放在 `bin`。开发脚本、构建清单和验证记录不进入日常运行目录。组件来源、精简配置和 SHA-256 锁定在配方中；没有匹配的已验证发布时明确失败，不回退到旧组件。缓存完整时可用 `pnpm offline:setup --Offline` 复用 Windows 缓存。

详见[第三方组件发布](decisions/0029-third-party-releases.md)、[Windows 安装包](decisions/0032-windows-installer.md)和 [GitHub Actions](GITHUB_ACTIONS.md)。

## 按需验证

开发阶段默认不运行测试。按修改范围选择必要的静态检查或构建；确需新增用例验证时，只运行本次新增用例。完整测试仅在明确要求测试或发布时执行。

| 命令                  | 范围                                |
| --------------------- | ----------------------------------- |
| `pnpm check`          | Vite+ 格式、lint 与 TypeScript 检查 |
| `pnpm build`          | 前端构建                            |
| `pnpm test`           | 默认测试集                          |
| `pnpm test:downloads` | 下载工具与 SQLite 集成              |
| `pnpm test:playback`  | 合成素材的实际播放                  |
| `pnpm test:metadata`  | 模拟接口与隔离资料服务              |
| `pnpm test:offline`   | 最新便携包的解压与运行验证          |

这些命令各有用途，不应作为每次修改后的固定流水线。浏览器预览不证明桌面、数据库或发行包已通过验证。

## 截图维护

README 图片保存在 [images](images)，使用当前正式界面的浏览器模式拍摄。更新时：

1. 先确认目标页面、初始数据和素材安全。使用未使用过的本机预览端口，避免复用已有页面偏好。
2. 保持媒体库为空，仅打开媒体库和外观设置；不导入数据库，不进入发现页或执行搜索、刮削和播放。
3. 通过界面切换主题，保存 `library-dark.jpg`、`library-light.jpg` 和 `settings-light.jpg`；不修改 DOM 伪造内容。
4. 检查每张图片没有真实影片、封面、路径、账号或密钥，并在 README 中保留浏览器预览说明。

截图仅作为界面展示，不代表原生功能验收。现有图片为 1280 × 720 的原始页面截图。

## 代码入口

| 路径                               | 内容                               |
| ---------------------------------- | ---------------------------------- |
| `frontend/src/app`                 | 应用外框、状态与主题               |
| `frontend/src/features`            | 片库、发现、下载、刮削、目录与设置 |
| `frontend/src/services`            | 独立于页面生命周期的业务服务       |
| `frontend/src/platform/neutralino` | 官方 API、文件、进程与窗口适配     |
| `native/database`、`native/media`  | SQLite、扫描、探测、NFO 与后台传输 |
| `scripts`                          | 构建、组件、打包与隔离验证         |

图标从 `frontend/src/components/icons.tsx` 复用 Phosphor，升级图标库后用 `pnpm icons:generate` 更新导出资源。普通业务保持在 TypeScript，原生服务通过官方 Extension 协议通信。
