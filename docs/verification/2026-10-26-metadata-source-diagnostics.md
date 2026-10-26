# Issue #11 来源错误与诊断验证

- 对应问题：[刮削失败 #11](https://github.com/ddmoyu/javm/issues/11)。本次修复错误传递并补充诊断，不宣称已恢复第三方来源的可用性。
- JavBus 的异步失败不再以空结果返回；HTTP 错误页不进入结果解析；另一个分支取得有效结果时保留该结果。所有请求通过内存 HTTP Transport 返回安全虚构数据，没有真实站点请求或图片加载。
- FANZA 区分挑战页面、区域限制、HTTP 拒绝/限流/服务错误、响应类型异常、页面数据缺失、脚本失败与解析失败。保留底层超时、DNS、TLS 和连接错误身份；报告只返回固定原因码与状态，不返回页面及原始异常。
- 前端按白名单接收新增字段，按原因和状态区分重试分组；日志保留任务与查询关联、次数和耗时；故障报告及历史恢复保留阶段、原因和 HTTP 状态。

## 本次执行

1. Go 1.27.3：在隔离的已裁剪源码副本中，从本地缓存回读锁定来源并校验 Git blob 哈希，应用最终补丁后仅运行 `go test -mod=readonly -tags=nomsgpack -count=1 -run '^TestJAVMDiagnosticsIssue11' ./engine`。5 组新增用例、23 个场景通过；没有执行上游或既有回归用例。
2. `pnpm exec vp test run tests/metadata-source-diagnostics.test.ts`：6 个新增用例通过，使用模拟数据。
3. 对本次修改的 6 个 TypeScript/JavaScript 文件运行定向 Vite+ 检查：没有警告、lint 错误或类型错误；差异空白检查通过。
4. 比较修改前后的 19 组组件/平台指纹：仅 Windows x64、Linux x64、macOS x64/arm64 的 MetaTube 改变，其他 15 组不变。未修改固定迁移记录或应用版本。

## 验证边界

未运行完整测试、完整应用构建或桌面 UI；未使用真实来源、用户数据库或媒体目录；未在 macOS/Linux 上运行。尚未构建、安装或发布新的 MetaTube 组件。后续分发需要按独立组件流程生成并验证四个平台的产物。
