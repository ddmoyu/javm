# JAVM Velvet 原型

第二套界面原型，与 `../javm-ui` 并存，用于对比评审。

- **布局与交互对齐 `javm-ui` 的最新版本**：侧栏无品牌区、边缘折叠按钮、顶部计数页签加工具栏、整卡单击（播放或详情可设置）、右键对象菜单、5000 部影片虚拟列表、资源刮削“结果列表 → 影片资料与资源”两层结构、可拖动的多播放器窗口与底部窗口栏。
- **数据与查询逻辑直接复制自 `javm-ui`**（`data.ts`、`libraryQuery.ts`、`filmMetadata.ts`、`resourceSearch.ts`、`useResourceSearch.ts`），两套原型行为一致；第一版继续迭代时需要同步这几个文件。
- **界面层改用 Mantine 9 组件**：AppShell、NavLink、Tabs、Table、Drawer、Modal、DataList、EmptyState、Pill、Popover、Timeline 等。`global.css` 只保留虚拟列表几何、海报叠层、截图缩略图和浮动播放器等组件表达不了的部分。
- **Velvet 配色**（`theme.ts`）：丝绒黑紫底色，玫瑰霓虹主色 `rouge`，兰紫 `orchid` 辅色，香槟金 `champagne` 用于评分与 4K。支持深浅两套。
- 封面、截图、播放画面都由 `Cover.tsx` 程序生成抽象图案，演示数据全部虚构，不含任何敏感图像。

```bash
pnpm prototype:velvet
```

构建：`pnpm prototype:velvet:build`，输出到 `dist/prototype-mantine`。
