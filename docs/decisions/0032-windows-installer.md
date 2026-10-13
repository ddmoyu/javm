# ADR 0032：Windows 安装包与精简发布说明

- 日期：2026-10-13
- 依据：用户要求精简 Release 更新日志、在末尾提供下载表格，并同时提供安装包和便携包。

## 发布形式

Windows x64 使用 Inno Setup 6 生成 `JAVM-版本-windows-x64-setup.exe`，保留原有 `JAVM-版本-windows-x64.zip`。不更换既有 ZIP 名称；下载徽章标为 Setup x64 和 Portable x64。

安装器默认安装到当前用户的 `%LOCALAPPDATA%\Programs\JAVM`，无需管理员权限，创建开始菜单入口，可选桌面快捷方式，注册卸载入口。固定 AppId 支持后续覆盖安装。卸载只移除安装器登记的文件，不删除数据库、缓存和用户自行加入的文件，也不迁移或卸载旧 Tauri 版本。

安装版与便携版继续使用同一套当前用户数据路径。Portable 表示免安装，不表示用户数据也随目录移动。两者仍依赖系统已安装的 Evergreen WebView2；此变更不内置或静默下载 WebView2，不修改其系统安装。

## 构建与校验

1. 原流程构建便携 ZIP 并完成安全样例验证。
2. `pnpm desktop:installer` 读取 `dist/offline/latest.json`，校验版本和清单哈希，仅将清单内的文件复制到独立暂存目录，逐个核对大小与哈希。Inno Setup 从该目录打包，并附带第三方许可证。
3. `scripts/verify-installer.ps1` 在独立临时目录静默安装、验证文件与快捷方式、覆盖修复改动过的运行文件，再卸载并确认保留用户文件。全程不启动应用；存在相同 AppId 或开始菜单入口时拒绝验证。
4. `release-alpha.mjs prepare` 将安装验证记录、便携包验证记录及组件来源关联到同一源码提交和文件哈希，缺少任一验证即停止。
5. 发布仍先上传草稿，回读所有附件并核对 SHA-256 后公开。Setup 同样进入 `SHA256SUMS` 和附件清单。

本机和 Windows Actions 镜像的默认 Inno Setup 路径优先使用；其他安装位置通过 `JAVM_ISCC` 指定。构建记录保留编译器哈希及输出。当前不新增签名证书配置，安装器签名尚未纳入发布验收。

只有已经生成并列入发布清单的附件才能出现在下载表格中。未完成适配的平台不生成下载入口。重跑未公开草稿时重新生成说明，已公开版本仍拒绝覆盖。

## 更新日志

`CHANGELOG.md` 只保留用户可见的新功能、改进、修复与必要兼容提示，相关项合并为少量短句。构建身份、组件配方、源码提交和测试细节放在附件或开发文档，不重复放入 Release 正文。

Release 正文依次为更新内容、简短使用前提和下载表格；版本标题由 GitHub Release 自身提供。发布前必须将 `Unreleased` 整理为对应版本条目。

本地预览：`node scripts/release-alpha.mjs notes --unreleased`，输出 `build/alpha-release/notes-preview.md`。其中的目标下载地址是未来版本的预览，命令不会创建 Release。

## 实现阶段验证与发布门槛

新增的更新日志生成专项用例，以及 `node scripts/test-installer.mjs` 的安全文本占位文件安装器专项。后者使用独立 AppId、开始菜单组和临时安装路径，确认静默安装、覆盖修复、卸载与用户文件保留，不启动应用。

实现阶段未运行完整工程检查、完整测试、应用重建或远端 Actions。正式 Alpha 发布必须由 CI 执行工程检查、默认测试集、应用构建、便携包与真实安装包验证，再回读附件；最终结果以对应 Actions 运行及 Release 中的 `verification.json` 为准。macOS、Linux 和 Windows 原生 ARM64 不属于本次实现范围，见 [跨平台核对](../CROSS_PLATFORM_STATUS.md)。

## 官方参考

- [Inno Setup 当前用户安装](https://jrsoftware.org/ishelp/topic_setup_privilegesrequired.htm)
- [Inno Setup AppId 与覆盖安装](https://jrsoftware.org/ishelp/topic_setup_appid.htm)
- [Inno Setup 架构限制](https://jrsoftware.org/ishelp/topic_setup_architecturesallowed.htm)
- [GitHub Windows 2025 镜像工具清单](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md)
