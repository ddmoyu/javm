# ADR 0027：独立精简依赖与 Windows 发布

2026-10-12。用户授权实现独立 Actions 精简依赖、便携 ZIP、Inno Setup 安装包，并发布首个 alpha。

## 精简依赖

`ddmoyu/javm-dependencies` 的手动工作流以 JAVM 完整提交号为输入；仓库中的 `ci/dependencies.yml` 是该工作流的同步副本。使用 Windows x64、MSVC、固定 NASM 和锁定源码编译 FFmpeg、MediaInfo 与 curl，并包含固定版本的下载器、MetaTube。

每次依赖发布保存构建配方、来源提交、运行链接、逐文件哈希、头文件、许可和对应源码。依赖资产不覆盖旧版本。`scripts/dependency-bundle.json` 锁定仓库、标签、资产名和 SHA-256。主工程只接受匹配配方、清单及 Release 记录的包；MediaInfo 导入预编译 DLL，静态 libcurl、SQLite 和 pugixml 继续由主工程编译。

## 主程序发布

`.github/workflows/release.yml` 仅 `workflow_dispatch`。默认仅验证：填写目标版本和完整源码提交号，构建产物保存为 Actions artifact；通过后再创建版本标签，启用 `publish` 发布。正式发布接受已有 `vX.Y.Z` 或 `vX.Y.Z-alpha.N` 等版本标签，校验 tag、package.json 与 Neutralino 版本，执行类型、单元、隔离原生和交付验证。默认分支需保留相同的手动入口；提交、PR 与 tag 推送均不触发此流程。

以同一份已校验 Release 运行目录生成便携 ZIP 和安装 EXE，再附带 SHA256SUMS、构建清单及许可页面。版本资源在 Neutralino 嵌入资源前写入，避免损坏 EXE 尾部嵌入内容。alpha 使用 GitHub prerelease 且不标记 latest，稳定版检查不会推荐预发布。

## 安装与验证边界

Inno Setup 默认当前用户安装到 LocalAppData/Programs/JAVM，可选桌面快捷方式和 javm 协议。保留用户数据库、设置与媒体；卸载只撤销仍指向本安装的协议。WebView2 bootstrapper 在构建时验证 Microsoft Authenticode 签名，安装时仅在缺少运行时才执行，需要网络。

安装验收仅在隔离 GitHub runner 账户中执行，检查安装文件与便携包哈希相同、重复安装升级、协议和卸载保留数据。不会启动生产页面或使用真实数据库。CI 原生测试与运行入口验证仅使用安全虚构数据；不访问真实内容来源。

当前没有 Windows 代码签名证书，首个 alpha 明确标记为未签名。现有 Tauri 更新签名不等于 Windows Authenticode，不能复用冒充。
