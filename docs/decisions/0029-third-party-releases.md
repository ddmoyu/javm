# ADR 0029：第三方精简组件独立发布

- 日期：2026-10-12
- 依据：用户要求在 JAVM 仓库内通过 GitHub Actions 独立构建与发布第三方组件，应用打包直接使用已有组件。

## 组件与版本

首轮发布 Windows x64 的 FFmpeg、MetaTube、MediaInfo 和 curl。每个 Release 只包含一个组件。平台矩阵集中在 scripts/third-party/components.mjs，其他平台完成构建脚本适配和目标运行验证后再加入，不声明尚未验证的平台。

组件标签为 deps-组件-上游版本-构建指纹前12位。指纹包含该组件的来源、裁剪配置、补丁、构建及验证脚本、目标平台和受控工具链配置；不包含 JAVM 版本和仓库整体提交号。共同构建基础设施改变会使相关组件失效，单个组件的来源配置改变只影响该组件。

.github/workflows/third-party.yml 在 dev 的相关路径变化时检查指纹，也保留手动入口。已有相同标签且附件完整则跳过；所有声明平台构建成功后汇总发布。公开产物不覆盖，未完成的草稿允许同一配方继续上传。组件 Release 不标记为 Latest，避免干扰 JAVM 更新检查。

## 产物与使用

每个平台附件包含 runtime、必要的 sdk、licenses、构建记录和逐文件清单。汇总的 component-manifest.json 记录来源、工具链配置、真实提交、Actions 运行号、平台、大小及 SHA-256。上传后下载回读比对哈希。

pnpm offline:setup 查询当前源码配方对应的最新可用组件产物，下载并逐文件验证。已验证的相同指纹使用本地缓存；--offline 只使用完整缓存。没有匹配发布时明确失败，不自动回退到旧版或现场源码编译。

解析结果保存在开发侧 build/dependencies/resolved.json，记录每个组件的不可变标签与附件哈希。MediaInfo 的运行库和头文件、curl 的运行程序和静态库由独立组件提供。JAVM Release 原生构建只引用这些产物；Debug 源码构建保留。

构建顺序：pnpm offline:setup → pnpm desktop:build → node scripts/package-offline.mjs。

完整便携 ZIP 保持单个根入口 JAVM.exe。构建脚本、开发头文件和发布清单不加入日常运行目录。

## 验证

组件发布核对文件集合、Windows x64 PE、构建配置及哈希。FFmpeg 验证裁剪能力；MetaTube 使用现有安全模拟专项验证；MediaInfo 读取合成的一秒静音 WAV；curl 验证 Unicode 路径和 Schannel 能力标识。所有测试不访问真实内容源或用户数据库。

应用 Alpha 发布执行工程检查、默认测试集、Release 构建与隔离运行包验证，再发布预发布版本。跨平台、真实站点和真实用户数据不属于此轮验证范围。
