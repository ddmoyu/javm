# 磁力复制的 Neutralino 官方 API 验证

2026-10-14。用户确认磁力只提供复制及外部下载器交接，要求复制使用 Neutralino 官方能力。

## 实现核对

- 桌面统一通过 `frontend/src/platform/neutralino/clipboard.ts` 调用 `@neutralinojs/lib` 的 `clipboard.writeText`。浏览器预览使用浏览器剪贴板，桌面端不在原生调用失败后改走浏览器。
- `neutralino.config.json` 已授权 `clipboard.writeText`；正式应用不需要读取剪贴板的权限。
- 磁力结果、在线资源链接、影片详情文本及设置页复制入口均复用上述函数。磁力交接继续通过 `os.open`，不创建内部 BT 下载任务或引入下载引擎。
- 官方 API 依据：[Neutralino.clipboard](https://neutralino.js.org/docs/api/clipboard/#clipboardwritetexttext)。

## Windows 桌面验证

使用现有 Neutralino Windows 宿主和正式 React 磁力组件，构建独立隐藏测试窗口；隔离配置、用户数据及 WebView 配置，禁用数据库 Extension，不请求真实站点。全部输入为安全虚构数据。

1. 通过正式 `copyText` 写入含中文和换行的安全文本，再用官方 `clipboard.readText` 逐字比较：一致。
2. 用安全 mock 结果渲染正式 `MagnetSearchPanel`，在测试页面内触发“复制磁力”按钮，读回结果与 `service.copyResult` 逐字比较：一致。
3. 读回磁力通过格式校验，成功提示为“已复制磁力链接。”。
4. 测试页面将浏览器 `navigator.clipboard.writeText` 替换为失败探针：未被调用，确认桌面实际走官方 API。
5. 读取权限仅添加到隔离测试配置；未读取原有剪贴板内容，未将剪贴板文本写入日志。测试宿主已退出。

本机运行命令为 `node .tmp/clipboard-native-check/run.mjs`；安全结果记录于 `.tmp/clipboard-native-run-9oMXIw/result.json`（临时文件不入库）。开始于 `2026-10-14T02:01:13.582Z`，结束于 `2026-10-14T02:01:16.360Z`，结果 `ok: true`。

统一复制模块及四处调用文件的定向 `vp lint --type-aware --type-check` 通过。未运行完整测试、重新打包、实际启动外部下载器；本次是隐藏桌面自动验证，不是鼠标手动操作验收。

此前真实安全关键词搜索中，BTDig 首页可解析 10 条，BT 目录返回 HTTP 403 验证页；与本次剪贴板验证分别记录，见 [ADR 0034](../decisions/0034-builtin-magnet-search.md)。
