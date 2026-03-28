# Tauri 后端 Rust 代码深度 Code Review

> 审查日期：2026-03-28
> 审查范围：`src-tauri/src/` 全部 55 个 `.rs` 文件

---

## 推荐的代码规范与指南

1. **错误处理一致性** — Tauri command 应返回 `Result<T, E>` 且 `E: serde::Serialize`；用自定义 `Error` 枚举替代无处不在的 `.map_err(|e| e.to_string())`
2. **永不在 command 中 panic** — `unwrap()` / `expect()` 仅限于编译期可证明安全的场景（如硬编码正则、`OnceLock`）；运行时 path 操作必须用 `?`
3. **阻塞操作离开主线程** — 同步 rusqlite + 文件 I/O 必须包裹在 `spawn_blocking` 中，避免饿死 Tokio runtime
4. **SQL 参数化** — 永远不要用 `format!()` 拼接表名/列名进 SQL，防止注入
5. **单一职责** — `lib.rs` 仅负责 command 注册和 `run()` 入口，业务逻辑应下沉到对应模块
6. **状态管理** — 全局状态通过 `tauri::State<T>` 注入，避免每次请求 `Database::new()` 重新构建

---

## 发现的问题清单

### P0 — 必须修复

#### ~~P0-1. `lib.rs` 承载过多职责（2172 行）~~ [已修复 2026-03-28]

> **修复内容：** 将 lib.rs 从 2172 行拆分为 240 行，创建 `commands/` 模块：
> - `commands/video.rs` (1471行) — 9 个视频相关 command + 业务辅助函数 + 测试
> - `commands/directory.rs` (126行) — 3 个目录管理 command
> - `commands/media.rs` (285行) — 8 个截图/封面/预览图 command
> - `commands/system.rs` (49行) — 6 个系统操作 command
> - `lib.rs` (240行) — 仅保留 mod 声明 + `run()` 入口 + `invoke_handler` 注册

#### ~~P0-2. 同步 DB 操作阻塞 async runtime~~ [已修复 2026-03-28]

> **修复内容：** `db.rs` 新增 `run_blocking()` 辅助方法，15 个 async 方法全部重构为使用该方法，消除了重复的 `spawn_blocking` 样板代码和错误的 `ToSqlConversionFailure` 错误转换。`Database::new()` 改为返回 `Result`，55 处调用点均已适配。
>
> **未完成部分：** `lib.rs` 中的 command 函数（如 `get_videos`、`get_directories` 等）仍然直接在 async 上下文中执行同步 DB 操作，需要后续拆分 lib.rs 时一并包裹 `spawn_blocking`。

#### ~~P0-3. 生产代码 `unwrap()` / `expect()` 可导致 crash~~ [已修复 2026-03-28]

> **修复内容：**
> - `Database::new()` 改为返回 `Result`，消除 `expect("Failed to get app data dir")` 和 `expect("Failed to create app data dir")`
> - `settings.rs` 中 `get_settings_path()` 改为返回 `Result`，`save_settings` 中 `path.parent().unwrap()` 改为 `.ok_or_else()`
> - `lib.rs` 中 `capture_video_frames` 的 `token_guard.as_ref().unwrap()` 通过合并作用域消除
> - `lib.rs` 中 `db.init().expect()` 改为 `.map_err()?` 优雅传播

---

### P1 — 应该修复

#### ~~P1-1. `.map_err(|e| e.to_string())` 出现 219 次，错误上下文全丢~~ [已部分修复 2026-03-28]

> **修复内容：** 创建了 `error.rs`，定义了 `AppError` 枚举 + `AppResult<T>` 类型别名，添加了 `thiserror` 依赖。`db.rs` 中的 async 方法已全部迁移到 `AppResult`。
>
> **未完成部分：** `lib.rs` 中的 command 函数和 `download/commands.rs` 等模块仍使用 `Result<T, String>` + `.map_err(|e| e.to_string())`，需要后续逐步迁移到 `AppResult`。

#### ~~P1-2. SQL 注入风险：`format!()` 拼接表名~~ [已修复 2026-03-28]

> **修复内容：** 新增 `MetadataTable` 枚举（`Actors`/`Tags`/`Genres`），`get_or_create_metadata` 的 `table` 参数从 `&str` 改为 `MetadataTable`，编译期保证只接受合法表名。`scanner/service.rs` 中的调用点同步更新。

#### ~~P1-3. Database 无状态注入、无连接复用~~ [已部分修复 2026-03-28]

> **修复内容：** `Database::new()` 已改为返回 `Result`，所有 55 处调用点均已适配。`db` 模块已改为 `pub mod` 以供 `commands/` 子模块引用。
>
> **未完成部分：** 将 `Database` 注册为 `tauri::State` 单例注入（当前每个 command 仍然各自 `Database::new(&app)?`）。这需要将 `Database` 实例在 `setup` 中 `app.manage(db)` 并修改所有 command 签名接收 `State<'_, Database>`，可作为后续独立优化。

#### P1-4. XOR 加密 API Key 等价于明文

settings.rs:10:
```rust
const ENCRYPTION_KEY: &[u8] = b"javm_secure_key_2024";
```
硬编码密钥 + XOR cipher = 零安全。密钥直接编译进二进制，任何人可逆向提取。

**修复方案：** 使用操作系统提供的凭据存储 API：
- Windows: Windows Credential Manager (`windows-credentials` crate)
- macOS: Keychain (`security-framework` crate)
- Linux: `libsecret` / `keyring` crate

或最低限度使用 AES-256-GCM (`aes-gcm` crate) + 机器唯一派生密钥。

#### P1-5. `get_directories` 中内联 `CREATE TABLE IF NOT EXISTS`

lib.rs:220-230 — 查询命令里包含建表语句，说明对 `db.init()` 不信任。应移除此处防御性建表，统一在 `db.init()` 中完成。

---

### P2 — 建议修复

#### ~~P2-1. `proxy::refresh()` 使用已弃用的 `set_var` / `remove_var`~~ [已修复 2026-03-28]

> **修复内容：** `proxy.rs` 中 `OnceLock` + `env::set_var` workaround 替换为 `RwLock`，`init()` 和 `refresh()` 均通过 `RwLock::write()` 安全更新，消除了多线程 UB 风险。

#### P2-2. 路径穿越未防御

lib.rs:873 `move_video_file` 中 `target_dir` 直接来自前端传入，没有验证是否在允许的目录范围内。`delete_thumb` 命令同理。

**修复方案：**
```rust
fn validate_path_within_allowed_dirs(
    target: &Path,
    allowed_roots: &[&Path],
) -> Result<(), AppError> {
    let canonical = target.canonicalize()
        .map_err(|_| AppError::Business("目标路径无效".into()))?;

    if !allowed_roots.iter().any(|root| canonical.starts_with(root)) {
        return Err(AppError::Business("目标路径不在允许的目录范围内".into()));
    }
    Ok(())
}
```

#### ~~P2-3. `spawn_blocking` 样板代码重复 15+ 次~~ [已修复 2026-03-28]

> **修复内容：** 与 P0-2 一并修复。`db.rs` 新增 `run_blocking()` 辅助方法，15 个 async 方法全部重构，消除了样板代码和语义错误的 `ToSqlConversionFailure` 转换。

#### P2-4. 路径规范化 + 目录视频计数查询重复 3 次

同一段路径规范化 + `REPLACE(dir_path, '\\', '/') LIKE ?` 查询在以下三处重复：
- lib.rs:374-393 (`delete_directory`)
- lib.rs:763-800 (`update_all_directories_count`)
- scanner/commands.rs:35-50 (`scan_directory`)

**修复方案：** 提取到 `Database` 的方法中：
```rust
impl Database {
    pub fn count_videos_in_directory(conn: &Connection, path: &str) -> Result<i64> {
        let normalized = Path::new(path).to_string_lossy().replace('\\', "/");
        let pattern = if normalized.ends_with('/') {
            format!("{}%", normalized)
        } else {
            format!("{}/%", normalized)
        };
        conn.query_row(
            "SELECT COUNT(*) FROM videos WHERE
                dir_path = ?1 OR dir_path = ?2 OR
                REPLACE(dir_path, '\\', '/') LIKE ?3 OR
                REPLACE(dir_path, '\\', '/') = ?2",
            rusqlite::params![path, normalized, pattern],
            |row| row.get(0),
        )
    }
}
```

#### P2-5. 窗口位置可见性检测代码重复

system_commands.rs:131-151 和 lib.rs:2017-2034 中完全相同的 monitor 可见性检测逻辑。

**修复方案：** 提取到 `utils` 模块中的公共函数。

---

## 修复优先级总览

| 优先级 | 编号 | 问题 | 状态 |
|--------|------|------|------|
| **P0** | P0-1 | `lib.rs` 2172行单文件 | **已修复** — 按领域拆分为 `video/`、`media/`、`db/`、`settings/` 模块，lib.rs 降至 276 行 |
| **P0** | P0-2 | 同步 DB 操作阻塞 async runtime | **已修复** — db.rs 用 `run_blocking`；`video/commands.rs`、`media/commands.rs` 全部 `spawn_blocking` 包裹 |
| **P0** | P0-3 | 生产代码 `unwrap()`/`expect()` | **已修复** |
| **P1** | P1-1 | 219 次 `map_err(\|e\| e.to_string())` | **已修复** — `video/commands.rs`、`media/commands.rs` 全部迁移到 `AppResult<T>` |
| **P1** | P1-2 | `format!()` 拼接 SQL 表名 | **已修复** |
| **P1** | P1-3 | Database 无状态注入、无连接复用 | **已修复** — `setup` 中 `app.manage(db)`，`video/commands.rs`、`media/commands.rs` 改为 `State<'_, Database>` |
| **P1** | P1-4 | XOR 加密 API Key | **待修复** |
| **P1** | P1-5 | 查询命令中内联建表语句 | **已修复** |
| **P2** | P2-1 | `env::set_var` 多线程不安全 | **已修复** |
| **P2** | P2-2 | 路径穿越未防御 | **已修复** — `validate_path_within_managed_dirs` 校验目标路径在已注册目录内 |
| **P2** | P2-3 | spawn_blocking 样板重复 15 次 | **已修复** |
| **P2** | P2-4 | 路径规范化+计数查询重复 3 次 | **已修复** — 提取 `Database::count_videos_in_directory` / `delete_videos_in_directory` |
| **P2** | P2-5 | 窗口可见性检测代码重复 | **已修复** — 提取 `is_position_visible_on_monitors` 公共函数 |

### 待修复项

| 编号 | 问题 | 难度 | 说明 |
|------|------|------|------|
| P1-4 | XOR 加密 API Key | 中 | 需引入 `keyring` 或 `aes-gcm` crate 替换 XOR |
