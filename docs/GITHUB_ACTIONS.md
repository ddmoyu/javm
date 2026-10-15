# GitHub Actions

工作流以 `main` 为开发基础。普通检查只接受手动触发；组件配方变更和应用版本标签各自触发已有的发布流程，详见 [ADR 0037](decisions/0037-main-development.md)。

## 入口与用途

| 工作流                                                            | 触发方式                     | 用途                                                       |
| ----------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| [工程检查](../.github/workflows/check.yml)                        | 手动，选择全部 / 前端 / 原生 | 前端静态检查与构建、Windows Debug 构建                     |
| [跨平台基础检查](../.github/workflows/portability-checks.yml)     | 手动或被复用                 | Windows x64、Linux x64、macOS ARM64 / x64 的基础与核心验证 |
| [macOS 与 Linux 桌面构建](../.github/workflows/desktop-posix.yml) | 手动或被发布流程复用         | 三个 POSIX 目标的组件、桌面与安装验证                      |
| [应用发布与跨平台验收](../.github/workflows/release-alpha.yml)    | 应用标签或手动               | 标签生成正式 / Beta / Alpha 发布；分支手动运行只做指定验收 |
| [第三方精简组件](../.github/workflows/third-party.yml)            | `main` 配方路径变更或手动    | 按指纹复用或构建 Windows 组件，发布 `deps-` 附件           |
| [自动更新隔离验收](../.github/workflows/update-validation.yml)    | 手动，选择平台               | 旧版升级、实际安装与失败回退                               |
| [自动更新签名密钥](../.github/workflows/update-signing-key.yml)   | 手动                         | 初始化或核对现有更新签名配置                               |

手动入口位于仓库 [Actions](https://github.com/ddmoyu/javm/actions)。日常检查选择 `main`；应用发布工作流的 `core`、`desktop`、`all` 分别表示基础核心、POSIX 桌面或两者。选择应用版本标签运行时，会进入发布流程。

POSIX 桌面构建可能通过 `--publish-missing` 发布尚未存在的精确配方组件，因此需要 `contents: write`。更新隔离验收只读复用已有组件。没有授权进行发布时，不应将桌面工作流当作普通前端检查使用。

## 环境与执行控制

- [.github/actions/setup-project](../.github/actions/setup-project/action.yml) 统一 Node.js、pnpm、锁文件缓存与依赖安装。Node.js 读取 `.node-version`，pnpm 读取 `package.json`。
- 发布前需要先核对源码时，使用 `install: "false"`，核对后再安装依赖。纯发布与密钥任务额外设置 `cache: "false"`，避免缓存无关依赖。
- 第三方 Actions 固定到已经核对的完整提交 SHA，旁注原版本号；升级时同步核对上游版本、输入参数和所需 runner。
- 使用明确的 Ubuntu 24.04、Windows 2025 与 macOS 15 runner，任务设置超时。重复的普通检查可以取消旧运行；涉及发布的流程继续排队，不中断正在上传或核验的产物。
- 已压缩的安装包和组件附件上传时使用 `compression-level: 0`，避免再次压缩；小型 JSON 验证记录保留默认压缩。构建附件保留 14 天，密钥维护记录保留 7 天。
- 检出源码不保存 Git 凭据。普通任务只读，组件发布和最终应用发布按任务授予写权限。

共享准备使用 GitHub 的[组合 Action](https://docs.github.com/en/actions/tutorials/create-actions/create-a-composite-action)；并发组分别命名，避免被复用工作流与调用者相互取消，参见[并发控制](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)。

## 组件复用

Windows 组件流程先计算指纹：已有完整发布则跳过构建；变化的组件独立构建、验证和上传。POSIX 桌面流程同样按精确配方解析组件。组件标签不占用仓库 Latest。

共享前端准备和 README 改动不属于组件构建配方，不应导致媒体组件重新编译。修改来源、裁剪参数、补丁或构建工具链时，必须按[组件发布约定](decisions/0029-third-party-releases.md)同步指纹输入。

## 应用发布

1. 明确获得发布授权后，同步应用版本与更新日志，完成该次发布要求的检查与测试。
2. 将相关提交推送到 `main`；如配方变化，等待所需组件发布完成。
3. 创建并推送唯一的 `v版本号` 标签。正式版用 `vX.Y.Z`，预发布追加 `-beta.N` 或 `-alpha.N`。脚本核对标签、源码版本和 `origin/main` 祖先关系。
4. Windows 与三个 POSIX 目标完成构建、安装包 / 便携包验证，以及更新助手的实际安装和失败回退。正式版与 Beta 还必须通过 0.5.3 原更新插件的签名下载、安装交接和新宿主启动；任一失败均阻止发布。全部通过后，发布任务合并同一提交的附件与签名。
5. 上传草稿，下载附件逐项核对 SHA-256，再公开对应通道 Release。只有正式应用版本成为 Latest。

保留历史文件名 `release-alpha.yml` 和脚本约定的 artifact 名称，避免破坏附件收集及既有链接；这些名称不限制实际发布通道。公开标签和附件不覆盖，失败草稿可重跑同一标签恢复。Actions 成功、Release 下载回读和目标系统实际运行是不同的验证范围。

升级验收只使用安全夹具与隔离数据：前端覆盖真实 HTTP 参数校验、分页、跳转及 1.0.7 → 1.0.8 的检查和下载；原生夹具覆盖同一稳定版本跨度的安装与回退。0.5.3 验收使用原更新插件及实际新安装包，不启动旧版业务；验证记录上传为 `javm-upgrade-*`，不混入面向用户的发布附件。后续发布继续执行这些检查。
