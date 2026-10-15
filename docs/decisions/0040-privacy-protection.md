# 隐私保护与老板键

日期：2026-10-15。

## 用户确认的交互

- 入口为「设置 → 隐私保护」。应用内默认 **F1**，Windows 全局默认 **F9**，各自可以关闭或修改。Esc 继续用于关闭弹框，不作为老板键。
- 快捷键最多两个按键：单个功能键，或一个 Ctrl / Alt / Shift 加功能键、字母或数字。拒绝应用、文本编辑及常用系统保留组合；Windows 实际注册新全局热键检查占用，成功后才释放旧热键。不能统一查询其他软件的窗口内快捷键。
- 老板键立即遮挡主界面及浮层，暂停、静音内置播放，隐藏主窗口和独立播放器。恢复通过托盘「显示 JAVM」或再次启动应用；恢复主界面不会自动显示播放器、继续播放或解除静音。外部播放器不归 JAVM 接管。
- 设置密码后，可分别开启「启动时需要密码」和「老板键恢复时需要密码」，也可立即锁定；两项默认关闭。锁定时下载、扫描等后台任务继续运行，链接启动动作延后至解锁。
- 封面模糊默认关闭，启用后覆盖封面、截图、裁剪预览及图箱，仅悬停的图片清晰，离开或窗口失焦立即恢复模糊。
- Windows「不写入系统最近文件」默认开启。JAVM 内部播放记录仍保留；本次不清除用户已有的系统记录。

## 实现与边界

应用级 `PrivacyService` 在 React 之外初始化，状态通过统一 session 同步至独立播放器。内容在读取设置前先遮挡；设置缺失使用默认值，已有设置无法读取或损坏则保持锁定并提供重试，不删除设置或数据库。窗口恢复和异步播放带修订检查，防止老板键之后迟到的回调重新显示内容或启动播放。播放器先隐藏创建，再接受主窗口的隐私状态。

密码仅保存随机盐及 Web Crypto 异步 PBKDF2-HMAC-SHA256 派生结果（600,000 次），不保存明文，不写日志；设置或修改密码需 6 至 256 个字符，支持粘贴。修改与移除已有密码需验证当前密码；连续五次验证失败冷却 30 秒。该功能保护应用界面，不加密媒体、数据库，也不抵御能直接修改应用数据的本机账户。

Windows 功能复用官方 Neutralino Extension 协议，原生 STA 线程负责热键、文件选择和窗口隐藏，前端和原生待处理请求各限制为 8 条。全局使用 `RegisterHotKey` / `MOD_NOREPEAT`，F12 不开放选择。退出时注销热键并关闭文件对话框、回收线程。普通界面键盘监听使用捕获阶段；原生文件选择窗口在自己的线程监听应用内老板键。文件选择期间触发老板键会取消选择。

Windows 文件与目录选择使用 `IFileOpenDialog`；开启最近文件保护时添加 `FOS_DONTADDTORECENT`。选择超时仅取消对应对话框。外部播放启用保护时直接 `CreateProcessW` 启动已指定或解析到的 EXE，避开 Shell 的文件打开记录；不支持解析到可执行文件的关联会提示改用指定播放器或内置播放器。外部播放器、资源管理器、浏览器仍可能自行保存历史，JAVM 不修改它们的设置。macOS / Linux 暂不提供全局热键或系统最近文件保护；应用锁、应用内老板键和图片模糊沿用前端实现。

浏览器预览使用临时内存设置，不保存密码，不注册系统热键。开发及后续验收只允许安全虚构素材、独立测试数据，不加载真实媒体库或内容源。

## 验证范围

本轮仅执行 TypeScript 类型检查与 Windows x64 原生 Debug 构建，不运行测试、完整前端构建或真实媒体库。系统热键占用、托盘恢复、文件对话框与多播放器的完整桌面交互仍需使用隔离安全样例进行运行验收。

参考：[Windows 热键注册](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey)、[文件对话框选项](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/ne-shobjidl_core-_fileopendialogoptions)、[Shell 最近文档记录](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shaddtorecentdocs)、[OWASP 密码存储建议](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。
