# 0031：启动窗口位置恢复

状态：已采纳

## 背景

主窗口由 Neutralino `useSavedState` 保存并还原位置、尺寸；旧启动逻辑仅检查尺寸，完全离屏的窗口可能仍出现在任务栏中，但无法点击显示。多显示器还可能存在负坐标、不同缩放和屏幕之间的空白区域，不能仅按主屏尺寸或虚拟桌面的外接矩形判定位置有效。

## 决策

- 保留官方状态保存机制。启动后只检查主窗口一次，异步执行，不随 React 重复挂载。
- 窗口与任一显示器存在正面积交集时保留原位置，包括副屏、负坐标和部分跨屏；完全离屏、坐标非法，或缩小超大窗口后完全离屏时，恢复至主屏工作区中央。
- 保留旧默认尺寸的一次迁移和超大尺寸限制，缩放尺寸不再无条件居中。最大化、全屏和最小化状态保持不变。
- 启动尺寸意外缩至最小值时，只读当前 Neutralino 6.10 保存的 `.tmp/window_state.config.json` 中的宽高，优先恢复原有有效尺寸；记录不可用或离屏记录本身已缩至最小时，使用 `1440×900` 并限制到工作区。位置正常、保存尺寸也是最小值时保留用户选择。既不另存第二份尺寸状态，也不直接改写宿主文件。
- 通过已有官方 Extension 协议增加只读 `window.displays`，返回显示器物理像素边界、工作区及主屏标记；不访问数据库、媒体目录或网络。Windows 使用 `EnumDisplayMonitors` 与 `GetMonitorInfoW`，仅为查询线程临时设置 DPI 上下文并在退出时恢复。
- 定位与尺寸策略留在 TypeScript，使用官方 `window.getPosition`、`getSize`、`setSize` 和 `move`。主屏工作区居中避开任务栏，移动后按实际尺寸再核对一次；不再按浏览器当前屏幕 DPI 换算其他显示器坐标。
- 读取迁移标记失败不阻止位置恢复；显示器查询或窗口操作失败记录日志，不删除或重置已有状态。

## 验证

仅运行本次新增用例：

```powershell
pnpm test tests/main-window-position.test.ts
$env:JAVM_WINDOW_INTEGRATION = '1'
pnpm test tests/window-displays-native.integration.test.ts
node scripts/verify-window-position.mjs
node scripts/verify-window-position.mjs --sizes
```

前两项分别验证定位规则和原生查询契约。最后一项使用独立数据目录、独立 WebView2 配置与安全文字页面，验证实际宿主的离屏恢复、主副屏位置保留、尺寸收缩及退出后的位置保存，不打开真实数据库。正常启动后页面立即隐藏；不使用 `hidden: true`，因为该模式会让当前 Windows 宿主跳过启动位置还原。报告保存在 `.tmp/window-position-safe-*/verification.json`。

`--sizes` 仅运行尺寸场景，在真实安全宿主中模拟运行尺寸意外缩小、保存尺寸仍然正常的情况，核验恢复宽高、默认值回退、用户主动选择的最小尺寸以及退出后的持久化。该验证不证明宿主最初缩小窗口的触发原因。
