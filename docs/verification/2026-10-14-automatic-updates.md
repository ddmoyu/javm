# 自动更新与旧 Tauri 兼容验证

日期：2026-10-14。工作区为 `dev`，实施时版本 `1.0.5-alpha.12`；未发布应用版本。范围见 [ADR 0035](../decisions/0035-automatic-updates.md)。本次保留工作区内磁力搜索、设置、窗口等其他任务的修改。

## 首轮本机结果

仅运行本次新增的定向用例，没有运行完整测试集、完整 `pnpm check` 或前端应用构建。

| 验证                                                                                 | 结果      | 证据范围                                                                                |
| ------------------------------------------------------------------------------------ | --------- | --------------------------------------------------------------------------------------- |
| `pnpm native:build --update-tests`                                                   | 通过      | vswhere 发现 MSVC 19.51，Windows Debug 更新模块、正式公钥助手及独立测试公钥夹具成功编译 |
| `pnpm exec vp test run tests/automatic-updates.test.ts tests/update-startup.test.ts` | 13 项通过 | 版本/通道、Release 过滤、自动检查、手动安装、取消、设置持久化与业务启动门闩，均为 mock  |
| `node --disable-warning=ExperimentalWarning --test scripts/update-native.test.mjs`   | 8 项通过  | 真实 Windows 更新助手进程，虚构程序及两份合成 SQLite 数据库                             |
| `node --test scripts/legacy-update.test.mjs`                                         | 4 项通过  | minisign 预哈希及可信注释、拒绝错误密钥/篡改、平台映射和缺包发布拦截                    |
| `node --test scripts/legacy-installer.test.mjs`                                      | 1 项通过  | 实际 Inno 编译/安装/卸载，仅文本占位程序；独立随机 AppId、注册表键与开始菜单组          |
| 10 个更新/打包/发布脚本 `node --check`                                               | 通过      | JavaScript 语法，不等于打包或远端发布                                                   |
| `git diff --check`                                                                   | 通过      | 无补丁空白错误；现有文档有 Git 换行提示                                                 |

共 26 项新增定向用例通过。首次安装器用例因验证 AppId 太长被 Inno 缩写而失败，缩短随机验证 ID 后通过；安装交接和用户文件保留本身此前已成功。

原生夹具验证了：健康启动提交后不可再用恢复命令降级；新版失败恢复程序、片库、下载/刮削任务库和设置；提交标记写入失败仍监管/停止新版并回退；退出收尾取消不开始替换；中断恢复可重入；损坏快照保留证据；签名或包内容被修改时拒绝安装；即使签名正确也拒绝路径穿越。所有程序与数据均为临时目录内的安全样例，不含媒体或真实业务内容。

安装器夹具使用旧 Tauri 的 `/P /R /UPDATE /ARGS` 参数组合，验证原目录覆盖、忽略应用参数中的另一目录、用户文件保留及旧卸载入口清理；静默模式下不执行文本占位的 `JAVM.exe`。这不等于已运行真实 0.5.3 客户端下载和启动新版。

后续按用户要求修复 `resource-search.test.ts`、`stream-resolution.test.ts` 和 `unified-resource-search.test.ts` 中共 4 处联合类型访问错误：测试解析器显式检查操作和输入字段，拒绝意外调用，不使用宽泛强制转换。`pnpm typecheck` 已通过（528 个文件），这 3 个测试文件的 48 项用例通过。

## 后续安装与故障验证

本次用户明确要求继续验证旧版交接、macOS/Linux 安装和失败回退；仍未运行无关全量测试或发布应用。新增 `update-validation.yml` 只在专用 `codex/update-validation` 分支或手动请求时运行，权限为 `contents: read`，组件仅下载复用，不创建组件或应用 Release。验收分支使用 `99.0.0-beta.2`，不改变本地应用版本，不提交其他任务的磁力、窗口或设置修改。

- Windows 本机再次构建成功。原生用例增加到 9 项；新增“失败版本记录无法写入”用例先复现失败，再验证修复：提示记录写入失败仍继续程序和数据恢复。
- 新增 3 项 Windows Setup 用例，实际编译、安装及卸载 Inno 包，随机 AppId 和临时目录隔离。正常更新成功；新版程序退出失败、无效安装器执行失败均自动重新安装可信旧包，并恢复两份 SQLite 数据库和设置，用户额外文件保持不变。
- 更新服务与启动门闩的 13 项用例、旧签名的 4 项用例再次通过。JavaScript 语法及补丁空白检查通过。
- 第一轮 macOS ARM64 打包暴露安装记录位置错误：`Contents/MacOS/update-installation.json` 被 codesign 当作未签名代码。记录改为 `Contents/Resources/update-installation.json`，普通启动和提权安装同时改读新位置。
- 旧版驱动锁定 Tauri 2.11.2、updater 2.10.1 和 0.5.3 的依赖版本，使用官方 MockRuntime，不包含旧业务或 WebView。下载并验证公开 0.5.3 包，执行原插件的下载、验签与安装实现；目标为本次实际构建的新包，安装后通过 Neutralino cloud 模式验证新宿主及 Extension。HTTP 清单仅在 runner 的回环地址提供，公钥和旧私钥不替换，不访问或改动公开 Latest。
- 单独的安装验证使用 `--installation-only`，报告明确 `gui: false`，不能替代发布要求的完整 GUI 验收。第一轮 Linux 完整桌面前置测试遇到 GLib 托盘退出崩溃，属于既有桌面场景，未修改其断言或据此宣称通过。

### 四个平台的实际结果

POSIX 的 3 个独立任务全部成功，验收提交为 `6242d9cf4b7db586d952654a11959c7066f12285`。该次 workflow 的整体状态为失败，原因是同一运行中的 Windows 签名命令转义错误。随后修复 Windows `cmd.exe` 的参数转义，提交 `4642b31b6d9ee4b895f5e4df1e8993a42139e531` 单独补跑 Windows，任务和 workflow 均成功；POSIX 实现未改变。四个平台的 JSON 报告均已下载回本机核对。

Windows x64 [补跑通过](https://github.com/ddmoyu/javm/actions/runs/38542247009)：Release 原生构建、9 项原生用例、3 项真实 Setup 安装/回退；安装公开 0.5.3 后，由原 updater 验签并交接新版 Inno 包，原目录安装、新宿主启动和 `update.configure` 均通过。

| 平台             | 结果及证据                                                                                                                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ubuntu 24.04 x64 | [任务通过](https://github.com/ddmoyu/javm/actions/runs/38540690142/job/115774437816)：9 项原生用例；AppImage 正常/启动失败、DEB 正常/启动失败/postinst 失败共 5 项实际安装回退；Portable、AppImage、DEB 安装与启动，DEB 覆盖安装和卸载保留数据；0.5.3 AppImage、DEB 经旧签名及原插件升级至新版 |
| macOS 15 ARM64   | [任务通过](https://github.com/ddmoyu/javm/actions/runs/38540690142/job/115774438422)：9 项原生用例；APP 正常更新、启动失败回退、root 私有快照抗篡改回退共 3 项；ZIP、DMG 安装/覆盖安装与 codesign 校验；0.5.3 APP 经原插件升级、新宿主启动                                                     |
| macOS 15 x64     | [任务通过](https://github.com/ddmoyu/javm/actions/runs/38540690142/job/115774438288)：与 ARM64 相同的原生、APP、root 私有快照、ZIP/DMG、旧版交接验证                                                                                                                                           |

旧版交接均先验证 0.5.3 公开附件的原签名，再由原私钥签名本次构建的新包；故意篡改包后原插件拒绝，原安装未改变。正常包安装后通过官方 Neutralino 协议验证 Extension 可用，并调用 `update.configure` 验证安装类型、公钥配置和安装记录可用。新宿主在 cloud 模式启动，不运行界面或业务来源。

最终回读公开 Latest 仍为 `v0.5.3`。仅推送隔离验收分支、保存 Actions 报告，没有创建应用 Release、更新版本标签或改写公开更新入口。

## GitHub 签名证据

| 项目                           | 结果 | 记录                                                                                                     |
| ------------------------------ | ---- | -------------------------------------------------------------------------------------------------------- |
| 新 P-256 密钥生成              | 成功 | [38500189863](https://github.com/ddmoyu/javm/actions/runs/38500189863)                                   |
| 新 GitHub secret 签名自检      | 成功 | [38500467889](https://github.com/ddmoyu/javm/actions/runs/38500467889)                                   |
| 原 Tauri 私钥与 0.5.3 公钥匹配 | 成功 | [38507101563](https://github.com/ddmoyu/javm/actions/runs/38507101563)；下载公开签名证明后在本机再次验证 |

新公钥指纹 SHA-256：`7b0ba1fa3691437a29caabf13da3e13ced6fe17ff9a233181b154b00a7b6f7fc`。旧 minisign key ID：`98F83826D5F5F573`。

密钥初始化与公钥记录使用独立远端分支 `codex/update-signing-key`，没有把其他工作区修改提交到该分支。新私钥在 runner 中产生并以 GitHub sealed box 密文写入仓库 secret；本地仅取得公钥、签名证明和密文。原 Tauri 密钥/密码 secret 没有覆盖或重新生成。完整功能源码尚未提交或发布。

## 本轮验证边界

- 旧版验证执行原更新插件和真实安装包，不等于操作未经修改的 0.5.3 完整 GUI。新版宿主和 Extension 已启动，完整 GUI、真实业务网络与实际用户库未加载。
- macOS 使用 macOS 15 双架构 runner，未验证 macOS 13 实机。root 私有安装/恢复实际执行；系统授权弹窗未做人工操作。Linux DEB 使用一次性 CI 的限定 polkit 规则，不代表人工授权取消场景已验收。
- 断网、低磁盘空间、断电、权限变化和文件占用的完整系统矩阵；本机有受控失败注入，不代表全部系统情形已通过。
- 第一份正式/Beta `JAVM-update.json`、旧格式 `latest.json` 与兼容附件的完整生产构建、上传和公开 Release 回读。

发布仍须按发行流程执行目标平台构建和完整验证，使用合成旧数据，不能读取真实旧库。Beta 不设 Latest；首个新版正式发布必须附带完整旧签名兼容包，否则会破坏 0.5.3 固定的 Latest 更新入口。首次旧版升级不具备新更新器的启动失败回退；新版回退从之后的更新生效。
