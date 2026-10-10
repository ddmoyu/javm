# 0001：重构工程初始化

日期：2026-10-08。状态：仅初始化，尚未进入业务重构。

## 本次范围

用户要求拉取上游、建立 `dev`、不保留旧工程文件，并进一步明确“目前主要希望初始化项目，不需要直接重构代码；界面先设计原型”。因此本次先建立工具链与空壳，不将 P0/P1 或数据库最小通信链路标记为完成。

已获取 `https://github.com/ddmoyu/javm.git` 的历史，`dev` 基于 `origin/main` 的 `dd0e6b62b263258b6e78106c72017b3b470b4097`。工作目录保留用户提供的 `docs/REFACTOR_PLAN.md` 和上游 MIT `LICENSE`，旧源码、旧配置、旧脚本、旧文档及截图均从新工程工作目录移除。

## 锁定的组合

| 项目                     | 版本                 | 原因                                             |
| ------------------------ | -------------------- | ------------------------------------------------ |
| Node.js                  | 24 LTS；本机 24.13.0 | 满足 Vite+ 1.1.0 的 Node 24.11+ 要求             |
| pnpm                     | 12.10.1              | 复用本机包管理器，统一一份锁文件                 |
| React / React DOM        | 19.3.0               | 与 Mantine 9.7.1 peer 范围匹配                   |
| TypeScript               | 7.0.2                | 显式严格配置；检查由 Vite+ 执行                  |
| Mantine core / hooks     | 9.7.1                | 已确定的 UI 基础库                               |
| Vite+                    | 1.1.0                | 统一开发、构建、格式、lint、类型检查和测试入口   |
| React Vite 插件          | 6.1.2                | JSX 与 Fast Refresh 集成                         |
| Neutralino 宿主 / 客户端 | 6.10.0 / 6.10.0      | 使用官方同版本组合                               |
| Neutralino CLI           | 11.8.0               | 本地开发依赖，不安装全局 CLI                     |
| C++                      | C++20                | 建立数据库扩展构建入口                           |
| SQLite                   | 3.53.4               | 官方 amalgamation，CMake 按 URL 和 SHA3-256 固定 |

Vite 的间接引用统一映射到 `@voidzero-dev/vite-plus-core@1.1.0`；Vitest 固定到 Vite+ 附带的 5.0.3。使用 `pnpm-workspace.yaml` overrides，避免重复加载不同工具链实例。`lint.options.typeAware` 和 `typeCheck` 均显式开启。

没有引入状态库、路由、额外 CSS 工具链或图标库。初始化页使用 Mantine 默认控件与系统字体，临时主题不视为正式产品原型。CSS Modules 当前只用标准 CSS，无需提前安装 PostCSS 扩展。

Neutralino CLI 的可选 WebSocket 原生加速器使用 JS 回退，`es5-ext` 的安装提示无需执行；在 pnpm 中逐项声明不执行其安装脚本。Vite 别名版本的 peer 例外仅覆盖锁定的 React 插件与 Vitest 组合。

Windows 脚本优先选取发现到的 Visual Studio 自带 CMake/Ninja，以避开 PATH 中其他工具链的 TLS 证书库差异；不关闭下载证书校验。子构建进程使用 UTF-8 代码页，CMake 对已确认的中文 MSVC 前缀误解码做窄范围修正，避免 Ninja 漏掉头文件依赖。

## 数据库和桌面边界

- C++ 可执行文件仅有 `--version` 构建检查，链接真实 SQLite，但不打开数据库。
- JSON/WebSocket 库尚未选定；官方 Extension 连接、DTO、超时、重连与退出协议在 P0 选择和验证。
- `enableExtensions` 暂为 `false`，避免启动没有协议实现的占位程序。
- 开发应用标识采用 `net.ddmoyu.javm.dev`，宿主运行数据采用系统数据目录，不接触旧版数据。
- 初始化阶段关闭窗口直接退出。正式版本仍须实现计划规定的“关闭到托盘、主动退出收尾”，此项并未取消。
- 浏览器预览不会调用 Neutralino 客户端初始化；桌面环境由宿主注入全局变量，客户端初始化在 React 树外执行。
- 当前未加入业务单元测试；保留测试命令与目录，避免把空用例输出当成业务通过。

## 后续顺序

1. 先设计主界面、下载页、刮削页和设置页原型，确认导航、密度、主题及窗口尺寸。
2. 按计划完成 P0，验证官方 Extension、托盘调度、进程回收、动态站点与媒体服务。
3. 在原型和关键能力确认后，逐步实施正式界面与业务迁移。

## 官方参考

- [Vite+ 本地 CLI 与依赖 overrides](https://viteplus.dev/guide/local-cli)
- [Vite+ check 和类型检查](https://viteplus.dev/guide/check)
- [Mantine Vite 接入](https://mantine.dev/guides/vite/)
- [Neutralino 前端框架接入](https://neutralino.js.org/docs/getting-started/using-frontend-libraries/)
- [Neutralino 6.10.0](https://github.com/neutralinojs/neutralinojs/releases/tag/v6.10.0)
- [SQLite 官方下载与校验值](https://sqlite.org/download.html)
