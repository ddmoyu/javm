//! 指纹（UA）轮换池
//!
//! 本项目用 wreq 模拟浏览器 TLS 指纹。单纯改写 UA 字符串而不改 TLS 指纹，会造成
//! 「UA 自称某浏览器、TLS 指纹却是另一浏览器」的矛盾信号，反而更易被反爬识别。
//! 因此「UA 轮换」在这里实现为：在多个**近期 Chrome 版本**的完整指纹之间轮换 ——
//! 每个版本的 UA、TLS、HTTP/2 指纹整体协调一致，制造「不同访客」的差异而不自相矛盾。

use wreq_util::Emulation;

/// 轮换用的 Chrome 指纹池（均为 wreq-util 支持的近期版本）。
pub const EMULATION_POOL: &[Emulation] = &[
    Emulation::Chrome131,
    Emulation::Chrome132,
    Emulation::Chrome133,
    Emulation::Chrome134,
    Emulation::Chrome135,
    Emulation::Chrome136,
    Emulation::Chrome137,
];

/// 不轮换时使用的默认指纹（与历史行为保持一致）。
pub const DEFAULT_EMULATION: Emulation = Emulation::Chrome137;
