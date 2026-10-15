# 离线包文件精简

## 调整

- 原包含校验清单共 77 个文件；新包为 21 个文件。58 个分散的许可证及构建资料文件改为两份汇总文档和清单中的前端依赖记录。
- `THIRD-PARTY-NOTICES.txt` 保留许可证原文；内容完全相同的文本只存一次，并列出对应组件。
- `THIRD-PARTY-BUILD-INFO.txt` 保留 FFmpeg、MediaInfo 和 curl 的原始构建记录。前端 39 个依赖的版本及来源移入 `package-manifest.json`。
- Neutralino 内嵌资源不再包含 Vite 公共目录中的安装脚本、分发说明、重复许可证、`.gitkeep` 和未使用的公共根目录 `icon.png`。窗口与托盘图标、界面 Logo、播放 Worker 以及离线名单继续保留。
- FFmpeg、curl、N_m3u8DL-RE、MetaTube、MediaInfo、原生 Extension、启动器与 Neutralino 宿主全部保留。MetaTube 的运行时版本记录、两份精简组件收据、安装／卸载／完整性校验入口继续保留。
- 新包包含当前源码中的详情预览截图解析和“资料来源”行移除。

## 验证范围

- 两份打包脚本通过语法、格式与差异空白检查；原生 Release、前端构建、Neutralino 资源嵌入和离线打包成功。
- 校验解包目录的 20 个清单文件，并用独立 ZIP 流读取逐项核对大小与 SHA-256；归档自身 SHA-256 一致。
- 检查 8 个 EXE／DLL 的 PE 导入，未发现缺失依赖或 Debug CRT。
- 逐份比对原包 57 份许可证／构建文本，均完整保留于两份汇总文档；原前端依赖记录与新清单完全一致。
- 从新旧 EXE 读取实际内嵌 ASAR，确认分发文档和重复图标已排除，必需静态资源仍在；6 份 CSV／JSON 名单资产逐字节相同。
- 未运行测试套件，未启动生产界面，未联网加载图片或访问个人媒体库。此轮为构建与包结构验证。

## 交付

- 包：`dist/offline/JAVM-1.0.0-windows-x64-offline-20261011T032859Z.zip`
- 大小：37,159,814 字节；上一包 37,443,992 字节，减少 284,178 字节。主要减少零散文件，运行二进制完整保留。
- SHA-256：`97dcab10a82936473d09b5565c2aad33b8239a90ffcc6941fbbc3d144e5f8740`
- 本地校验记录：`.tmp/offline-cleanup-verification.json`、`.tmp/offline-cleanup-resources-verification.json`。
- 原包未覆盖，源码未自动提交或推送。

## 后续：移除独立许可证文件

- 按用户要求，从包目录移除 `LICENSE`、`THIRD-PARTY-NOTICES.txt` 和 `THIRD-PARTY-BUILD-INFO.txt`；许可原文和构建记录分别归入现有清单的 `licenseNotices`、`buildInformation`，不再产生独立文件。
- 文件总数由 21 个降到 18 个（包含清单）；16 个运行及辅助文件与上一包的 SHA-256 完全一致，只更新说明与清单。
- 新包：`dist/offline/JAVM-1.0.0-windows-x64-offline-20261011T034453Z.zip`，37,159,425 字节。
- SHA-256：`4131683a97f42d116ed1fbf79960f1547d09efa245f85108cf39b3478beed30e`。
- 17 个清单文件、独立 ZIP 流、归档哈希及 8 个二进制依赖校验通过；安装脚本可读取并校验新清单，未执行安装。清单内 39 组原文及哈希核验通过。
- 本次只调整打包规则和说明，复用已验证的运行二进制；未重新构建应用、运行测试套件或启动生产界面。
- 校验记录：`.tmp/offline-notices-verification.json`、`.tmp/offline-notices-layout-verification.json`。

## 后续：仅分发运行文件

- 按用户要求，便携包不再携带安装／卸载／校验 PowerShell 脚本、`installer` 目录、`package-manifest.json` 和使用说明。
- 同时移出仅供构建校验使用的 `mediainfo-lite.json`、`ffmpeg-lite.json`。MetaTube 启动实际读取的 `installed.json` 继续保留。
- 根目录只有 `JAVM.exe`、`javm-win_x64.exe`、`bin`、`resources`，整个包共 10 个文件。程序入口与运行依赖均与上一包的 SHA-256 相同。
- 清单、许可文本及构建收据移到开发侧 `build/offline-manifests`，由 `dist/offline/latest.json` 记录路径及哈希，不进入 ZIP。开发侧校验和签名脚本已同步适配。
- 新包：`dist/offline/JAVM-1.0.0-windows-x64-offline-20261011T034837Z.zip`，37,084,994 字节。
- SHA-256：`434ce6c2846d40775c26e4f48d608db285df597b922cc6af17e38b82c45d3533`。
- 10 个目录文件、独立 ZIP 流、归档哈希、外部清单哈希和根目录内容核验通过；MediaInfo 与 FFmpeg 使用外部收据校验通过。没有运行测试套件或启动应用界面。
- 校验记录：`.tmp/offline-runtime-package-verification.json`。使用新目录解压可避免旧包已存在的说明及脚本残留。

## 后续：单一主程序入口

- 旧 `JAVM.exe` 是一个启动壳，只设置资源目录并启动 `javm-win_x64.exe`。便携包改为将官方嵌入资源的宿主直接命名为 `JAVM.exe`，不再携带启动壳或第二个根目录 EXE。
- [Neutralino 6.10.0 的路径初始化](https://github.com/neutralinojs/neutralinojs/blob/v6.10.0/settings.cpp#L175-L208) 默认采用程序路径，仍支持 `--path`。离线验证工具同步适配新的主程序名称，并兼容旧包。
- 新增 `scripts/verify-portable-entry.mjs`，仅在无窗口 cloud 模式运行：从另一个工作目录启动，覆盖含中文及空格的程序路径、内嵌资源、目录资源、显式 `--path` 三种情况；均成功读取配置和资源并正常退出。
- 验证关闭 Extension，使用独立临时数据目录；只请求回环地址，不执行正式前端，不创建 WebView、不显示图片、不访问个人数据库。三个进程均已退出。未运行现有测试套件。
- 根目录现仅 `JAVM.exe`、`bin`、`resources`，全包共 9 个文件，TXT／PS1／说明／校验清单均不在 ZIP 内。
- 新包：`dist/offline/JAVM-1.0.0-windows-x64-offline-20261011T035407Z.zip`，36,941,668 字节。
- SHA-256：`5b290532d8ca31047d83a3e6b630218117ffeb3f8409b3825adc6ffdc904c6fe`。
- 目录与独立 ZIP 流的 9 个文件哈希核验通过；新 `JAVM.exe` 与已构建的官方嵌入宿主逐字节一致。校验记录：`.tmp/offline-single-entry-verification.json`、`.tmp/portable-entry-amdKqw/result.json`。
