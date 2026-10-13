# 跨平台支持核对

更新：2026-10-13。基础模块四平台验证已通过，完整桌面和安装包的目标系统验收正在推进；尚未发布 macOS / Linux 的 JAVM Alpha。

| 范围 | 实现 | 验证证据 |
| --- | --- | --- |
| Windows x64 Alpha 4 | Setup、Portable、简洁更新日志和下载表格 | [已发布版本](https://github.com/ddmoyu/javm/releases/tag/v1.0.5-alpha.4) |
| 原生基础、官方 Extension、媒体文件层 | Windows、macOS 双架构、Linux x64 | [四平台核心 CI 全部通过](https://github.com/ddmoyu/javm/actions/runs/38375841919) |
| POSIX 组件 | 精确配方、独立 Release、下载回读校验 | [组件与完整构建验证](https://github.com/ddmoyu/javm/actions/runs/38385520758)；该轮完整构建发现的 curl 导入作用域问题已修复，不能视为桌面成功 |
| 系统凭据、网络与链接 | Keychain、Secret Service、系统协议关联及 macOS Apple Event 桥接 | 新增目标系统集成夹具，待完整 CI 验收 |
| 桌面业务 | 工具下载、播放传输、隐藏取流、更新附件、托盘与退出 | 新增安全 GUI 夹具，待目标 WebKit 实际运行 |
| 安装和发布汇总 | APP/DMG、AppImage/DEB、便携包及跨平台下载表格 | 附件合并边界用例通过；实际安装与桌面验证未全部完成 |

## 已消除的主要平台限制

- 数据和缓存使用各系统用户目录；Windows 保留原 LocalAppData 布局。POSIX 路径保留大小写、反斜线、Unicode 与空格。
- 原生通信、数据库拥有者锁、文件身份、排序、NFO 编码、原子替换和 MediaInfo 动态库加载已提供平台实现。
- 媒体工具使用对应架构的无后缀程序，检查执行权限；POSIX 子进程通过已有官方进程 API 启动受管监督器。
- 下载、资料、刮削和 HTTP 解析入口已接入桌面能力判断；外部播放器支持 POSIX 程序与 macOS APP；更新服务按操作系统和架构选择安装包或便携包。
- 官方 Neutralino 6.10.0 的 POSIX 构建修复特殊路径的全局变量转义，并增加隐藏取流专用的临时 WebKit 会话。版本、源码 SHA、补丁和附件哈希均进入组件记录。

## 仍须通过的交付门槛

1. 三个 POSIX 目标完整编译，并通过系统密钥库、证书与代理、系统 URL 关联验证。
2. 真实 WebKit 运行安全界面、下载与合并、MP4/HLS、Range、隐藏取流及取消；关窗继续下载，显式退出不遗留受管任务。
3. 安装包、便携包启动及覆盖安装成功，卸载保留用户数据；所有验证绑定同一源码提交和附件哈希。
4. 后续已授权版本的发布流程同时得到四架构结果，下载表格只包含真实附件。

## 平台边界

- 首发最低系统：macOS 13、Ubuntu 24.04；macOS CI 实际运行在 15，Linux CI 使用 X11。未进行 macOS 13 真机、所有 Linux 桌面环境及不同 GPU 的验证。
- macOS 开发包只有 ad-hoc 签名，没有 Developer ID 或公证。
- macOS 13 的隐藏 WebKit 无独立代理接口；目前 POSIX 隐藏取流遇到应用代理或自定义请求头会明确失败。普通 HTTP 解析、播放传输及下载保留代理支持。
- macOS 系统链接声明随 APP 管理；应用内不能使用私有 API 强制注销。Linux 仅删除当前用户由 JAVM 创建的关联，不覆盖其他应用或删除系统安装的 desktop entry。
- AppImage 和便携包不捆绑整套桌面系统库，需要与 DEB 相同的 Ubuntu 24.04 运行依赖。
- 不包含 Android、Windows ARM64、Linux ARM64、RPM、字幕和音轨选择。

详细实施与命令见[适配计划](CROSS_PLATFORM_PLAN.md)。
