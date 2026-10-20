# 403 修复离线包交付验证

日期：2026-10-11，北京时间。文件名采用 UTC 构建时间。

- 文件：`dist/offline/JAVM-1.0.0-windows-x64-offline-20261010T171021Z.zip`
- 大小：37,424,198 字节，约 35.7 MiB。
- SHA-256：`1f1cc7a79f5304e1c6935adc72be963b46b0695f21ed993204cc555907ff1fe2`
- 日志标识：`adapterRevision: 5`。

## 内容

当前工作区的 Windows x64 Release 构建，包含隐藏验证动画帧与图片路径拦截修复，以及常驻 libcurl HTTP 模块。普通 HTTP 继续使用官方 Neutralino Extension；隐藏读取仍使用 Neutralino 和系统 WebView2。

包内包含 JAVM 启动器、内嵌前端的 Neutralino 宿主、SQLite／媒体／HTTP Extension、MediaInfo 26.10 精简 DLL、FFmpeg 8.0.1 精简工具、curl 8.22.0、N_m3u8DL-RE 0.6.0-beta、MetaTube v1.4.0、许可证、安装／卸载脚本和完整性检查脚本。WebView2 Runtime 沿用系统安装版本，没有放入压缩包。

## 实际检查

- `pnpm offline:setup -Offline`：使用本地校验过的缓存准备工具，没有下载新依赖。
- `pnpm desktop:build`：MSVC Release 原生构建、前端构建与 Neutralino 资源内嵌成功。
- `node scripts/package-offline.mjs`：产生新时间戳目录及 ZIP，未覆盖旧包。
- 包目录与 ZIP 内的 76 个清单文件分别核对长度与 SHA-256，全部一致；ZIP 整体哈希一致。
- 8 个 EXE／DLL 的 PE 导入检查没有发现缺失依赖或 Debug CRT；FFmpeg、curl、下载器和原生 Extension 在仅含系统目录的 PATH 下执行版本命令成功。
- 内嵌宿主中的 69 个 JavaScript 文件与本次前端构建逐字节一致，并确认包含 `adapterRevision:5`、页面运行状态设置、URLPattern 和 `http.request`。
- 使用包内 `javm-win_x64.exe` 和 `bin/javm_database.exe` 执行本次新增的两个定向测试文件：17 项安全检查通过。包括隐藏 403→200、窗口零显示、媒体拦截、失败退出、libcurl 连接复用与取消。
- 定向测试后没有遗留包内宿主或 Extension 进程；测试使用隔离数据和回环 mock，没有启动用户片库页面或访问真实内容来源。

验证命令设置 `JAVM_WEBVIEW_EXE`、`JAVM_DATABASE_EXE` 指向本次包内文件，并设置 `JAVM_WEBVIEW_INTEGRATION=1`、`JAVM_HTTP_INTEGRATION=1`，执行：

```text
pnpm test tests/http-native.integration.test.ts tests/avwiki-challenge-runtime.integration.test.ts
```

前端构建仍提示部分分块超过 500 kB，以及第三方 `use no memo` 指令提示；未阻止构建。未运行完整回归、真实站点验证、安装或签名发布。真实 403 是否放行仍需用户重试确认。

使用时先通过托盘彻底退出旧版，再完整解压新包并运行 `JAVM.exe`；程序继续使用原有用户数据目录。
