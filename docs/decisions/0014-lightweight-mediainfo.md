# 精简 MediaInfo 附加功能

2026-10-10，按用户要求先裁剪优先级高的未使用功能，保留现有容器、视频、音频、字幕及其他格式解析器。

## 范围

使用 MediaInfoLib 26.10 官方 AllInclusive 源码包，包含 ZenLib 0.4.41 和 zlib 1.3.2。不修改上游源文件，不启用 `MEDIAINFO_MINIMAL`，不删除解析器。

| 关闭选项                                | 原因                                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `MEDIAINFO_LIBCURL`、`MEDIAINFO_LIBMMS` | 当前探测入口只接受本地普通文件；网络下载由独立工具承担                                                                                 |
| `MEDIAINFO_EXPORT`                      | JAVM 通过 `MediaInfo_Get` / `MediaInfo_Count_Get` 读取字段，自行生成业务 JSON，不使用 MediaInfo 的文本、HTML、JSON、XML 和行业报告导出 |
| `MEDIAINFO_GRAPHVIZ`                    | 不使用解析关系图输出                                                                                                                   |
| `MEDIAINFO_TRACE`                       | 不使用逐元素详细跟踪输出；应用自身错误、超时和取消反馈继续保留                                                                         |

保留 `MEDIAINFO_CONFORMANCE`：26.10 在关闭该选项而保留 `ADVANCED` 时，`MediaInfo_Config.cpp` 仍初始化被移除的 `Conformance_Limit`，导致编译失败。本轮保留上游默认功能，避免扩大裁剪范围或维护上游补丁。其他高级分析、读取策略、解复用、事件及哈希选项也保持默认。

## 构建和交付

- `scripts/offline-dependencies.json` 统一锁定来源、SHA-256、附属库版本及关闭的功能，profile 为 `javm-lite-1`。
- `native/media/mediainfo/CMakeLists.txt` 在独立目录作用域中使用上游 CMake；每次配置将其他 MediaInfo 选项恢复到默认，避免旧缓存意外关闭解析器。
- `pnpm native:build --Release` 使用 MSVC 静态运行库、体积优化和链接时优化，输出 `bin/MediaInfo.dll` 与 `bin/mediainfo-lite.json`。Debug 仍使用相同功能配置，Release 打包拒绝 Debug 构建凭据。
- 维持独立 DLL 和现有 C ABI；媒体探测仍位于可取消、有并发上限的后台子进程中。
- 打包核对来源、功能配置、Release 标记、DLL 大小及 SHA-256，并确认来自当前 Release 原生产物，防止混入旧官方 DLL。
- 随包保留 MediaInfo、ZenLib、zlib 的许可证、裁剪构建脚本与来源信息。

## 验证方式

`tests/mediainfo-lite.integration.test.ts` 用独立的完整 FFmpeg 生成合成媒体，调用实际原生探测入口。覆盖 MP4、MKV、WebM、AVI、MOV、M2TS、MPEG、WMV、FLV、Ogg、RealMedia、3GP 和独立音频，包括 H.264、HEVC、AV1、VP9 及常见音频编码。可通过环境变量对比官方 DLL，逐项比较时长、尺寸、编码、轨道数量、声道与语言。

```powershell
$env:JAVM_MEDIAINFO_INTEGRATION = '1'
$env:JAVM_FIXTURE_FFMPEG = '完整 FFmpeg 的绝对路径'
# 可选：含官方原版 MediaInfo.dll 的隔离目录中的同版探测程序。
$env:JAVM_MEDIAINFO_REFERENCE_EXE = '原版对照目录\javm_database.exe'
pnpm exec vp test run '../tests/mediainfo-lite.integration.test.ts'
```

原版在当前 `ParseSpeed=0.5` 下，对测试中的裸 AAC/ADTS 不返回时长，精简版保留该行为。测试不把未知时长推断为完整性或可播放性证明。性能、真实 NAS 和所有格式组合不属于本次样本验证范围。

来源：[官方源码下载](https://mediaarea.net/en/MediaInfo/Download/Source)、[26.10 构建选项](https://github.com/MediaArea/MediaInfoLib/blob/v26.10/Project/CMake/MediaInfoSetupOptions.cmake)、[功能开关](https://github.com/MediaArea/MediaInfoLib/blob/v26.10/Source/MediaInfo/Setup.h)。
