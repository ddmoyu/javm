# JAVManager 项目指令

## 项目简介
JAVManager 是一个基于 Tauri 2.0 的桌面视频资源管理工具。

## 技术栈
- **前端**：Vite + Vue 3 + TypeScript + Tailwind CSS + Reka UI
- **后端**：Rust + Tauri 2.0 + rusqlite
- **包管理**：bun（禁止 npm/yarn/pnpm）

## 关键规则
- 编码规范、架构约束、Git 规则详见 `.claude/rules/` 目录
- 前后端通信唯一通道：Tauri IPC（`invoke` ↔ `#[tauri::command]`）
- 版本号变更：`bun run vb -- <patch|minor|major>`
- 编译验证：Rust 用 `cargo check`，前端用 `bun run build`
- 所有对话、注释、commit message 使用中文
