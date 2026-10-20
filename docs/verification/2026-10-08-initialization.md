# 工程初始化验证

日期：2026-10-08。环境：Windows x64、Node.js 24.13.0、pnpm 12.10.1、Visual Studio Insiders / MSVC 19.51。

## 已完成

| 验证             | 结果                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| 上游与分支       | 已拉取 `ddmoyu/javm` 历史，当前 `dev` 基于 `dd0e6b62b263258b6e78106c72017b3b470b4097`                               |
| 原计划保留       | `docs/REFACTOR_PLAN.md` SHA-256 在初始化前后均为 `62E084908EADCA6F26DF6120A1FE54DF9903CEC5737F81E151CFA439490CF0E2` |
| 锁定安装         | `pnpm install --frozen-lockfile` 通过                                                                               |
| 静态检查         | `pnpm check` 通过，格式、lint 和类型检查无错误                                                                      |
| 类型检查反向验证 | 临时加入 string 赋值给 number 的文件，`pnpm typecheck` 报 TS2322 并返回非零；删除临时文件后恢复通过                 |
| 前端与桌面打包   | `pnpm desktop:build` 通过，生成 `dist/frontend` 与 `dist/desktop/javm`                                              |
| C++ 与 SQLite    | `pnpm native:build` 通过；`javm_database --version` 输出 `0.6.0-dev.0` 和 SQLite `3.53.4`                           |
| Ninja 依赖扫描   | 修正中文前缀后，`ninja -t deps` 确认 `main.cpp.obj` 记录了 `sqlite3.h` 依赖                                         |
| 开发桌面窗口     | `pnpm desktop:dev` 成功启动，实际窗口显示初始化页及“桌面宿主”标识                                                   |
| 浏览器预览       | `http://127.0.0.1:5173` 显示初始化页及“浏览器预览”标识                                                              |
| 测试入口         | `pnpm test` 可运行，报告没有测试文件；当前没有业务测试用例                                                          |
| 差异空白检查     | `git diff --check` 通过                                                                                             |

## 验证边界

用户中断了后续界面自动操作，已停止使用桌面和浏览器交互工具。主题切换与打包后桌面运行未完成交互验证，不据此宣称完整 UI 验收通过。

CI 工作流已配置，尚未推送、触发或获得远端运行结果。非 Windows 平台虽有官方宿主产物，但未验证运行。

数据库程序只验证编译和 SQLite 链接，不是可用数据库服务。没有验证或实施官方 Extension、旧库迁移、托盘调度、进程回收、媒体播放或其他业务流程，P0/P1 均未整体验收。
