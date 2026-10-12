# Windows 版本发布

发布入口是 [JAVM Actions](https://github.com/ddmoyu/javm/actions/workflows/release.yml)。所有流程只允许手动触发；普通提交、推送、PR 和版本标签不会自动发布。

## 更新精简依赖

1. 修改 `scripts/offline-dependencies.json` 或对应构建配方，提交并推送完整源码。
2. 在 [精简依赖工作流](https://github.com/ddmoyu/javm-dependencies/actions/workflows/build.yml) 填入该源码的完整 40 位提交号。
3. 构建成功后，从依赖 Release 取得运行包和源码包的精确资产名及 SHA-256，更新 `scripts/dependency-bundle.json` 并提交。不要使用 `latest` 或覆盖已有资产。
4. 执行 `pnpm dependencies:restore` 验证 SHA-256、配方、完整文件清单和二进制构建记录。依赖配方发生变化但锁定包未更新时，恢复会失败。

FFmpeg、MediaInfo、curl 在依赖仓库的 Windows runner 上源码构建。主程序发布复用这些工具；原生扩展链接的静态 libcurl、SQLite、pugixml 仍由主程序构建。依赖工作流的源文件保存在 `ci/dependencies.yml`，修改后需同步到依赖仓库的 `.github/workflows/build.yml`。

## 验证和发布应用

1. 同步 `package.json`、`neutralino.config.json`、`CHANGELOG.md` 和 `docs/releases/v版本.md`。预发布使用 `1.0.0-alpha.1` 这类版本格式。
2. 提交并推送后，手动运行应用发布工作流：`tag` 填目标版本（例如 `v1.0.0-alpha.1`），`publish` 保持关闭，`source_commit` 填完整提交号。
3. 工作流检查类型、完整单元测试、原生 HTTP 和备份恢复，构建 Release，并验证便携包、安装、重复安装升级、协议和卸载保留数据。通过后可从 Actions artifact 下载验证产物。
4. 在通过验证的提交创建并推送对应版本标签。再次手动运行工作流，填写同一 `tag` 并开启 `publish`；此时源码严格取自标签，重复所有验收后创建 GitHub Release。已有同名 Release 时拒绝覆盖。

默认分支必须保留应用工作流入口。它会检出输入的源码提交或版本标签，不会使用默认分支的旧应用源码打包。首次发布的源码位于 `codex/javm-alpha-release`。

## 交付文件

- 便携 ZIP：完整解压后运行根目录 `JAVM.exe`，电脑需有 Evergreen WebView2 Runtime。
- Inno Setup EXE：当前用户安装，缺少 WebView2 时通过微软 bootstrapper 联网安装；支持开始菜单、可选桌面快捷方式和协议注册。
- `SHA256SUMS`：运行包、安装包和说明文件的校验值。
- 构建清单与第三方许可 HTML：版本、来源提交、依赖包和源码链接。开发脚本、构建记录和许可说明不放入便携运行目录。

alpha、beta 和 rc 标记为 GitHub prerelease，不替换稳定版 latest。当前没有 Windows Authenticode 证书，程序和安装包未签名。验收仅使用安全虚构素材、隔离数据库与无业务内容的页面，不访问真实内容来源。
