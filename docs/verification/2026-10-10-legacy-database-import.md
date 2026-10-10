# 旧数据库启动引导与合并验证

2026-10-10。对应 [启动导入旧库](../decisions/0018-legacy-database-import.md)。

## 已执行

- `pnpm native:build`：Windows MSVC Debug 构建通过。
- `pnpm typecheck`：最终检查通过，共 241 个文件。
- 针对本轮前端、服务及新增测试文件执行 `vp lint`：通过；进度区域使用语义化 `output`。
- 设置 `JAVM_MEDIA_INTEGRATION=1`，仅运行 `pnpm exec vp test run tests/legacy-import-native.integration.test.ts tests/legacy-import.test.ts`：2 个新增文件，13 个用例通过。
- `git diff --check`：通过。

新增原生用例覆盖：启动只检测、不自动导入；无旧库不提示；路径去重与 ID 冲突重映射；新版资料、收藏、旧别名、维度收藏、历史任务和未知 BLOB 表保留；新旧备份可读；原生重启不再提醒；旧库占用与重试；无效关联导致事务回滚；备份阶段取消；已写入部分记录后取消回滚；异常退出遗留 WAL 中的数据完整导入；schema 5 升级备份；未来旧库版本拒绝；清理旧文件失败但导入完成记录持久化。

新增服务用例覆盖：初始化去重、稍后导入、浏览器预览不连接数据库、开始请求响应丢失时状态恢复、取消与开始的竞态、轮询失败重连、成功后刷新与关闭。

## 界面验证

使用 `tests/fixtures/legacy-import` 的 Vite 验证页，连接隔离的真实 C++ Extension，仅访问 `.tmp/legacy-ui-*` 合成库：

- 检查浅色和深色主题，旧路径能换行，备份与清理说明及主按钮可见。
- “稍后导入”关闭弹窗，再次检测仍可导入。
- 用键盘 Enter 开始导入，观察运行进度、取消入口、完成提示与备份位置。
- 完成后点击“进入片库”，再点击“重新检查旧库”，不再弹出引导。
- 最终截图保存于 `.tmp/legacy-import-guide.png` 和 `.tmp/legacy-import-completed.png`。这些是合成库验证截图，不代表真实用户数据已经迁移。

## 验证范围

未运行既有测试或全套回归，未重新打包发布，未执行真实用户旧库迁移，也未验证 NAS、机械硬盘或超大片库性能。既有三份集成测试只同步了 schema 6 的预期和降级夹具，没有执行。前一次类型检查曾被并行变更中的 `metatube-detail.test.ts` 错误阻断；本任务未改动该文件，最终检查已通过。
