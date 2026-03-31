# 架构边界规则

## 前后端分层
- 前端代码在 `src/`，后端代码在 `src-tauri/src/`，两侧不能直接互相引用
- 前后端通信唯一通道：Tauri IPC（前端 `invoke` ↔ 后端 `#[tauri::command]`）
- 前端不能直接操作文件系统、数据库，必须通过后端 command

## 前端目录职责（src/）
- `views/` — 页面级组件，对应路由
- `components/` — 可复用 UI 组件，不包含业务逻辑副作用
- `components/ui/` — 基础 UI 原子组件（Reka UI 封装）
- `stores/` — Pinia 状态管理，负责调用 `invoke` 和管理前端状态
- `composables/` — 可复用逻辑组合函数
- `types/` — TypeScript 类型定义
- `utils/` — 纯工具函数，无副作用
- `lib/` — 第三方库封装（db、tauri、utils）

## 前端依赖方向
- `views/` → `components/`、`stores/`、`composables/`
- `stores/` → `lib/tauri`（invoke 调用）、`types/`
- `components/` → `composables/`、`types/`、`utils/`
- `utils/` 和 `types/` 不依赖其他模块

## 后端模块职责（src-tauri/src/）
- `db/` — 数据库访问层，rusqlite 操作
- `video/` — 视频管理业务逻辑
- `download/` — 下载功能
- `scanner/` — 文件扫描
- `media/` — 媒体文件处理
- `resource_scrape/` — 资源抓取
- `settings/` — 设置管理
- `error.rs` — 统一错误类型定义
- `utils/` — 通用工具函数

## 后端依赖方向
- 业务模块（video、download 等）→ `db/`、`utils/`、`error.rs`
- `db/` 不依赖业务模块
- 新增 Tauri command 必须在 `lib.rs` 中注册
