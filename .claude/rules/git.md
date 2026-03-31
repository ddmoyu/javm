# Git 提交规则

## Commit Message 格式
- 使用中文
- 格式：`<类型>: <简要描述>`
- 类型：`feat`（新功能）、`fix`（修复）、`refactor`（重构）、`style`（样式）、`docs`（文档）、`chore`（杂项）、`test`（测试）、`perf`（性能）

## 提交纪律
- 只提交用户要求的变更，不夹带无关改动
- 一个 commit 做一件事，不要混合多个不相关改动
- 提交前确认编译通过（Rust: `cargo check`，前端: `bun run build`）
- 不要提交 `.env`、密钥、调试用的临时代码

## 版本发布
- 版本号变更必须使用 `bun run vb -- <patch|minor|major>`
- 禁止手动编辑 `package.json`、`tauri.conf.json`、`Cargo.toml` 中的版本号
