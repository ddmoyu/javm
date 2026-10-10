# 内置 MetaTube 离线包验证

后续运行包已移除 ffprobe 并复用 MediaInfo，最新交付见 [移除 ffprobe 验证](2026-10-09-remove-ffprobe.md)。下文保留内置 MetaTube 调整完成时的历史结果。

2026-10-09，按用户要求，MetaTube 改为构建时准备并随 JAVM 运行包提供。运行时不再下载安装组件或选择程序路径；组件随 JAVM 更新。实现边界见 [ADR 0012](../decisions/0012-metatube-ai.md)，此前的安装流程记录见 [历史验证](2026-10-09-metatube-ai.md)。

## 交付与行为

- ZIP：`dist/offline/JAVM-1.0.0-windows-x64-offline-20261009T152707Z.zip`。
- 大小：39,992,011 字节（38.14 MiB），清单包含 70 个文件，清单本身另计。
- SHA-256：`695e7a7126c06d41e21779bb7bad2f557e264e7b563adee9c0f9af940888ef23`。
- 完整解压后双击 `JAVM.exe`；“设置 → 刮削与资料”显示内置版本，直接启动服务。随应用启动仍由原有开关控制，默认关闭。
- MetaTube v1.4.0 位于 `bin/tools/metatube/metatube-server.exe`，47,316,992 字节，SHA-256 为 `e306bf62252886e2861679d770d986153e4be66b3403b003ce95edd328dc179d`。
- 内置组件的官方来源包、版本及 SHA-256 由 `scripts/offline-dependencies.json` 锁定。构建阶段校验下载来源，打包阶段复核版本、来源摘要、EXE 大小及哈希，缺失或不匹配时拒绝出包。
- 运行时只使用包内程序。旧设置中的 `binaryPath` 和用户数据目录内旧安装记录不再影响程序选择；旧文件与数据库保留。已有服务模式继续可用。
- 设置页移除程序路径、选择程序、下载、安装、更新入口。组件缺失时提示完整解压或重新获取 JAVM 运行包，恢复组件后可直接重试。

本包继续使用系统 WebView2，不附带 WebView2 Runtime。精简 FFmpeg、ffprobe 和 N_m3u8DL-RE 的职责保持不变；相关验证见 [精简 FFmpeg](2026-10-09-lightweight-ffmpeg.md)。

## 检查、构建与测试

- `pnpm check`：258 个文件格式通过，200 个文件无 lint／类型错误或警告。
- `pnpm test`：162 项通过，71 项需要显式集成环境的用例跳过。新增覆盖旧程序路径被忽略、内置组件缺失与恢复重试。
- `pnpm offline:setup --Offline`：使用已校验的构建缓存准备全部依赖，无需重新下载。
- `pnpm desktop:build`：Release 原生构建、前端构建及 Neutralino 嵌入通过；仍有既有的分块体积和 React Compiler 指令提示。
- `node scripts/package-offline.mjs`：内置组件校验通过，生成上述 ZIP，并更新 `dist/offline/latest.json`，旧包保留。

构建日志为 `.tmp/metatube-bundled-setup.log`、`.tmp/metatube-bundled-desktop-build.log`、`.tmp/metatube-bundled-package.log`。常规测试为 `.tmp/metatube-bundled-tests.log`，最终静态检查为 `.tmp/metatube-bundled-final-check.log`。

### 隔离桌面服务

设置 `JAVM_OFFLINE_PACKAGE` 为上述运行包目录后执行 `pnpm test:metadata`，使用包内程序和系统 PATH。测试隔离 application ID、storage、应用数据及 WebView2 测试缓存，禁用媒体数据库扩展；AI 与已有资料服务使用本机虚构数据和测试密钥。

| 验证项                                                       | 结果 |
| ------------------------------------------------------------ | ---- |
| AI 配置经当前用户 DPAPI 加密持久化并跨实例读取               | 通过 |
| 本机 OpenAI 兼容接口的连接测试、编号识别与翻译               | 通过 |
| 错误密钥反馈，不覆盖原配置                                   | 通过 |
| 取消慢请求并回收 curl 进程                                   | 通过 |
| 响应大小限制，回环请求绕过错误代理                           | 通过 |
| 已有 MetaTube 服务鉴权、查询与资料映射                       | 通过 |
| 真实包内 MetaTube 忽略旧安装记录，启动、重启、健康检查与停止 | 通过 |
| 组件缺失时反馈修复运行包，恢复后重试成功                     | 通过 |

最终记录：`.tmp/metadata-desktop-1tNYxR/result.json`，**8/8 通过**，无未处理异常。日志为 `.tmp/metatube-bundled-isolated-metadata.log`。

### 最终 ZIP 与系统运行环境

`pnpm test:offline` 解压上述 ZIP，70 个文件大小和 SHA-256 均匹配。仅系统 PATH 下，精简 FFmpeg／ffprobe 校验、中文和空格路径启动、系统 WebView2 调用、隔离片库初始化、下载设置持久化，以及退出后两个数据库完整性检查均通过。系统为 Windows 11 专业版 10.0.26200，WebView2 为 154.0.4258.62。

首次与桌面服务测试并行时，离线测试在确认 WebView2 浏览器子进程的父进程关系处超时；单独重跑通过。两套测试原先可能共享默认 WebView2 用户数据目录，因而共享浏览器进程。随后只在测试子进程环境中设置各自独立的 `WEBVIEW2_USER_DATA_FOLDER`，再次并行运行两套测试均通过；生产启动器和系统环境未改动。该隔离依据 [WebView2 用户数据目录与共享会话](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder) 和 [环境变量覆盖说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/webview2-idl?view=webview2-1.0.3967.48)。

最终解压目录：`.tmp/离线 验证-089bfe40/JAVM-1.0.0-windows-x64-offline-20261009T152707Z`。记录为 `.tmp/offline-validation.json`、`.tmp/metatube-bundled-isolated-offline.log`；首次失败与串行重跑分别保留在 `.tmp/metatube-bundled-offline-test.log`、`.tmp/metatube-bundled-offline-retry.log`。

## 界面与验证边界

浏览器检查使用 `tests/fixtures/metadata-ui` 的真实设置组件及虚构服务。在 1280×720 浅色界面确认“内置服务”“已有服务”、内置版本 v1.4.0、随 JAVM 提供和更新的提示、随应用启动开关及启停控件；没有安装或程序选择入口。桌面测试也检查了这些入口及实际进程行为，浏览器截图不作为原生窗口视觉验收。

没有使用真实旧数据库、真实 AI 账号或密钥，没有请求公网影片来源，因此不宣称真实供应商模型质量或各来源站点实时可用。本机验证通过，不替代 Windows 10 或全新虚拟机验证。本轮没有提交、推送或创建 GitHub Release。
