use regex::Regex;
use serde::{Deserialize, Serialize};

/// 识别方法枚举
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum RecognitionMethod {
    Regex,
    AI,
    Failed,
}

/// 番号语义标记：从文件名中识别并保留，不当作番号的一部分。
/// 番号归一（去标记得纯番号供刮削），标记单独保留（展示/筛选/版本维度）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignationMarkers {
    /// 多碟/分片标记（如 "A"、"B"、"CD1"），同片多文件 → 可关联
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part: Option<String>,
    /// 中文字幕版（-C / -ch / 中文字幕）
    pub chinese_subtitle: bool,
    /// 无码破解（UC / 无修正 / 破解）
    pub uncensored: bool,
    /// 流出（LEAK / 流出 / 泄露）
    pub leaked: bool,
    /// VR 影片
    pub vr: bool,
    /// 分辨率/规格标记（4K / 8K / UHD）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
}

impl DesignationMarkers {
    /// 是否无任何标记
    pub fn is_empty(&self) -> bool {
        self.part.is_none()
            && !self.chinese_subtitle
            && !self.uncensored
            && !self.leaked
            && !self.vr
            && self.resolution.is_none()
    }

    /// 转为标签字符串集合（供复用 tags 入库/筛选）。
    pub fn to_tags(&self) -> Vec<String> {
        let mut tags = Vec::new();
        if self.chinese_subtitle {
            tags.push("中文字幕".to_string());
        }
        if self.uncensored {
            tags.push("无码破解".to_string());
        }
        if self.leaked {
            tags.push("流出".to_string());
        }
        if self.vr {
            tags.push("VR".to_string());
        }
        if let Some(res) = &self.resolution {
            tags.push(res.clone());
        }
        if let Some(part) = &self.part {
            tags.push(format!("分片{}", part));
        }
        tags
    }
}

/// 完整识别结果：纯番号 + 语义标记
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignationInfo {
    pub designation: String,
    pub markers: DesignationMarkers,
    /// 番号本身是否为无码作品（按格式/厂牌判定，区别于 markers.uncensored 的"有码作品无码流出版"）
    #[serde(default)]
    pub is_uncensored: bool,
}

/// 识别结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecognitionResult {
    pub success: bool,
    pub designation: Option<String>,
    #[serde(default)]
    pub markers: DesignationMarkers,
    /// 番号本身是否为无码作品（按格式/厂牌判定）
    #[serde(default)]
    pub is_uncensored: bool,
    pub method: RecognitionMethod,
    pub message: String,
}

/// AI 提供商配置
#[derive(Debug, Clone)]
pub struct AIProvider {
    pub provider: String,
    pub model: String,
    pub api_key: String,
    pub endpoint: Option<String>,
}

/// 番号识别器
///
/// 负责从视频文件名或标题中识别番号（JAV designation）
/// 支持多种常见格式的正则表达式匹配和 AI 识别
pub struct DesignationRecognizer {
    /// 正则表达式模式列表，每个模式包含正则表达式和优先级
    regex_patterns: Vec<(Regex, i32)>,
    /// AI 客户端（可选）
    ai_provider: Option<AIProvider>,
}

/// 番号识别正则（按优先级），进程内只编译一次。
///
/// 多捕获组的模式：组 1 = 前缀，组 2 = 数字（番号归一为「前缀-数字」）。
static REGEX_PATTERNS: std::sync::LazyLock<Vec<(Regex, i32)>> = std::sync::LazyLock::new(|| {
    vec![
        // FC2-PPV（最高）
        (Regex::new(r"(?i)(FC2)-?PPV-?(\d{6,8})").unwrap(), 100),
        // 素人：数字前缀 + 字母 + 连字符 + 数字（390JAC-132 / 300MAAN-783）。
        // 须高于标准格式，否则会被截成 "JAC-132"。左侧加非字母数字边界，
        // 避免把更长数字串（如日期戳 20231231SSIS-001）吞进前缀。
        (Regex::new(r"(?i)(?:^|[^0-9A-Z])(\d{2,4}[A-Z]{2,6})-(\d{3,5})").unwrap(), 95),
        // 标准带连字符 ABC-123
        (Regex::new(r"(?i)([A-Z]{2,6})-(\d{3,5})").unwrap(), 90),
        // 字母+数字混合前缀 T28-123 / KIN8-1675
        (Regex::new(r"(?i)([A-Z]+\d+)-(\d{3,5})").unwrap(), 85),
        // 无连字符 ABC123
        (Regex::new(r"(?i)([A-Z]{2,6})(\d{3,5})(?:[^A-Z0-9]|$)").unwrap(), 80),
        // 纯数字下划线/连字符 123456-789 / 123456_999（无码/素人）
        (Regex::new(r"(?i)(\d{6})[_-](\d{3,5})").unwrap(), 70),
        // 空格分隔 ABC 123（最低；易误匹配标题词，仅作兜底）
        (Regex::new(r"(?i)([A-Z]{2,6})\s+(\d{3,5})").unwrap(), 60),
    ]
});

/// 已知 VR 番号前缀（命中即判 VR）
static VR_PREFIXES: &[&str] = &[
    "SIVR", "DSVR", "VRKM", "EXVR", "KMVR", "MDVR", "CRVR", "WPVR", "TMAVR", "DOVR", "AJVR",
    "MAXVR", "KAVR", "HUNVR", "SAVR", "TPVR", "FSVR", "CBIKMV", "VOVS",
];

/// VR 文件标记：vr 词、180/3D、mkx200 等投影标记
static VR_RE: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"(?i)(?:^|[^a-z])vr(?:[^a-z]|$)|_180_|_3dh|mkx-?200|lr_180").unwrap());
/// 分辨率/规格：4K / 8K / UHD
static RES_RE: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"(?i)(?:^|[^a-z0-9])([48]k|uhd)(?:[^a-z0-9]|$)").unwrap());
/// 无码破解（英文 token）
static UC_RE: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"(?i)(?:^|[^a-z])(?:uncensored|uc)(?:[^a-z]|$)").unwrap());
/// 流出（英文 token）
static LEAK_RE: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"(?i)(?:^|[^a-z])(?:leaked|leak)(?:[^a-z]|$)").unwrap());
/// 多碟标记 CD1 / DISC2
static CD_RE: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"(?i)^(?:cd|disc)(\d{1,2})$").unwrap());

/// 已知无码厂牌前缀（番号本身即无码作品）。纯数字前缀（加勒比/一本道/天然むすめ/帕高等）
/// 另行按"前缀全为数字"判定，不在此列。
static UNCENSORED_PREFIXES: &[&str] = &[
    "FC2", "HEYZO", "KIN8", "MYWIFE", "CARIB", "CARIBBEANCOM", "CARIBBEANCOMPR", "PACO",
    "PACOPACOMAMA", "HEYDOUGA", "GACHINCO", "GACHI", "1PONDO", "10MU", "10MUSUME", "TOKYOHOT",
];

/// 判定番号本身是否为无码作品（按格式/厂牌）。
///
/// - 纯数字前缀（`010120-001` / `123456_789`：加勒比 / 一本道 / 天然むすめ / 帕高等）→ 无码
/// - 已知无码厂牌前缀（FC2 / HEYZO / KIN8 / MYWIFE 等）→ 无码
/// - 素人数字+字母前缀（`300MIUM-700` / `390JAC-132`）含字母 → 有码，不误判
///
/// 注意：这判定"作品天生无码"，与 [`DesignationMarkers::uncensored`]（有码作品的无码破解流出版）
/// 是不同维度。入参应为归一后的纯番号（`PREFIX-NUMBER`）。
pub fn is_uncensored_designation(designation: &str) -> bool {
    let upper = designation.to_uppercase();
    let prefix = upper.split('-').next().unwrap_or("");
    if prefix.is_empty() {
        return false;
    }
    // 纯数字前缀 → 无码（加勒比/一本道等）
    if prefix.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    UNCENSORED_PREFIXES.contains(&prefix)
}

/// 提取语义标记。
///
/// - 全局标记（VR / 4K / 无码 / 流出 / 中文字幕）：扫描整个文件名。
/// - 位置标记（分片 / 字幕后缀）：仅看番号之后紧邻的前 3 个 token，保守避免误判。
fn extract_markers(title: &str, suffix_start: Option<usize>, designation: &str) -> DesignationMarkers {
    let mut m = DesignationMarkers::default();
    let lower = title.to_lowercase();

    // ===== 全局标记 =====
    if VR_RE.is_match(&lower) {
        m.vr = true;
    }
    if let Some(cap) = RES_RE.captures(&lower) {
        m.resolution = Some(cap[1].to_uppercase());
    }
    if UC_RE.is_match(&lower) || lower.contains("无修正") || lower.contains("无码破解") || lower.contains("破解") {
        m.uncensored = true;
    }
    if LEAK_RE.is_match(&lower) || lower.contains("流出") || lower.contains("泄露") {
        m.leaked = true;
    }
    if lower.contains("中文字幕") || lower.contains("中字") {
        m.chinese_subtitle = true;
    }

    // VR：番号前缀属于已知 VR 厂牌
    if let Some(prefix) = designation.split('-').next() {
        if VR_PREFIXES.contains(&prefix.to_uppercase().as_str()) {
            m.vr = true;
        }
    }

    // ===== 位置标记（番号紧邻后缀）=====
    if let Some(start) = suffix_start {
        if start <= title.len() {
            let suffix = &title[start..];
            // 只看番号紧邻的连续片段（首个空白之前），避免把空格后的描述词/冠词（如 "a movie"
            // 的 "a"）误判为分片。VR/4K/无码 等全局标记仍扫全名，不受此限制。
            let region = suffix.split(char::is_whitespace).next().unwrap_or(suffix);
            for token in region
                .split(|c: char| matches!(c, '-' | '_' | '.' | '[' | ']' | '(' | ')'))
                .filter(|t| !t.is_empty())
                .take(3)
            {
                let tl = token.to_lowercase();
                match tl.as_str() {
                    "c" | "ch" | "chinese" => m.chinese_subtitle = true,
                    "a" | "b" | "d" => {
                        if m.part.is_none() {
                            m.part = Some(token.to_uppercase());
                        }
                    }
                    "uc" => m.uncensored = true,
                    "leak" | "leaked" => m.leaked = true,
                    _ => {
                        if let Some(cap) = CD_RE.captures(&tl) {
                            m.part = Some(format!("CD{}", &cap[1]));
                        }
                    }
                }
            }
        }
    }

    m
}

impl DesignationRecognizer {
    /// 创建新的番号识别器实例
    pub fn new() -> Self {
        DesignationRecognizer {
            // 复用进程内只编译一次的正则（Regex 内部 Arc，clone 廉价）
            regex_patterns: REGEX_PATTERNS.clone(),
            ai_provider: None,
        }
    }

    /// 创建带 AI 提供商的识别器实例
    pub fn with_ai_provider(ai_provider: AIProvider) -> Self {
        let mut recognizer = Self::new();
        recognizer.ai_provider = Some(ai_provider);
        recognizer
    }

    /// 检查是否配置了 AI 提供商
    pub fn has_ai_provider(&self) -> bool {
        self.ai_provider.is_some()
    }

    /// 选出最佳番号候选，返回（大写番号, 番号数字末尾在原串中的字节位置）。
    /// 位置用于界定「番号之后的后缀」以提取分片/字幕标记。
    fn best_candidate(&self, title: &str) -> Option<(String, usize)> {
        // (番号, 优先级, 起始位置, 数字末尾位置)
        let mut candidates: Vec<(String, i32, usize, usize)> = Vec::new();

        for (pattern, priority) in &self.regex_patterns {
            for captures in pattern.captures_iter(title) {
                let Some(whole) = captures.get(0) else {
                    continue;
                };
                let designation = if captures.len() >= 3 {
                    format!("{}-{}", &captures[1], &captures[2])
                } else {
                    captures[0].to_string()
                };
                // 番号「之后」从数字捕获组末尾算起（无该组则用整体匹配末尾）
                let end = captures.get(2).map(|m| m.end()).unwrap_or_else(|| whole.end());
                candidates.push((designation, *priority, whole.start(), end));
            }
        }

        // 优先级高的优先；同优先级位置靠后的优先
        candidates.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)));
        candidates.retain(|(designation, _, _, _)| self.is_valid_designation(designation));

        candidates
            .first()
            .map(|(designation, _, _, end)| (designation.to_uppercase(), *end))
    }

    /// 使用正则识别番号（返回归一后的纯番号，大写）。
    pub fn recognize_with_regex(&self, title: &str) -> Option<String> {
        self.best_candidate(title).map(|(designation, _)| designation)
    }

    /// 使用正则识别番号 + 语义标记（纯番号 + 分片/字幕/版本/VR）。
    pub fn recognize_detailed(&self, title: &str) -> Option<DesignationInfo> {
        let (designation, end) = self.best_candidate(title)?;
        let markers = extract_markers(title, Some(end), &designation);
        let is_uncensored = is_uncensored_designation(&designation);
        Some(DesignationInfo { designation, markers, is_uncensored })
    }

    /// 验证番号是否合理
    ///
    /// 1. 前缀部分长度 2-8（含素人数字+字母前缀，如 300MAAN）
    /// 2. 数字部分 3-8 位（含 FC2 长数字）
    /// 3. 排除常见非番号数字（分辨率等）
    fn is_valid_designation(&self, designation: &str) -> bool {
        let parts: Vec<&str> = designation.split('-').collect();

        if parts.len() != 2 {
            return false;
        }

        let prefix_part = parts[0];
        let number_part = parts[1];

        // 前缀长度 2-8（素人 300MAAN 等数字+字母前缀可达 7）
        let prefix_len = prefix_part.chars().count();
        if prefix_len < 2 || prefix_len > 8 {
            return false;
        }

        // 数字部分长度 3-8（支持 FC2 的 6-8 位）
        let number_len = number_part.chars().count();
        if number_len < 3 || number_len > 8 {
            return false;
        }

        // 排除常见非番号数字（分辨率等）
        if ["800", "1080", "720", "480", "360", "1440", "2160"].contains(&number_part) {
            return false;
        }

        true
    }

    /// 使用 AI 识别番号
    pub async fn recognize_with_ai(&self, title: &str) -> Result<String, String> {
        let provider = self.ai_provider.as_ref()
            .ok_or_else(|| "No AI provider configured".to_string())?;

        let client = crate::utils::proxy::apply_proxy_auto(
            wreq::Client::builder()
                .timeout(std::time::Duration::from_secs(15)),
        )
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;

        // 构建提示词
        let prompt = format!(
            r#"请从以下视频文件名中识别出JAV番号（日本成人影片的编号）。

文件名: {}

JAV番号的常见格式包括：
- ABC-123 (字母-数字)
- ABC123 (字母数字)
- FC2-PPV-123456
- 123456-789
- 390JAC-132 (素人，数字+字母前缀)

请只返回识别出的番号，去掉画质/字幕/分片等后缀（如 -C、-CD1、4K）。如果无法识别，请回复"未找到"。"#,
            title
        );

        // 根据provider类型发送不同的请求
        let default_endpoint = match provider.provider.as_str() {
            "openai" => "https://api.openai.com/v1".to_string(),
            "deepseek" => "https://api.deepseek.com/v1".to_string(),
            "claude" => "https://api.anthropic.com/v1".to_string(),
            _ => return Err("Unsupported AI provider".to_string()),
        };

        let base_url = provider.endpoint.as_ref().unwrap_or(&default_endpoint);

        if provider.provider == "claude" {
            self.call_claude_api(&client, base_url, &provider.api_key, &provider.model, &prompt).await
        } else {
            self.call_openai_compatible_api(&client, base_url, &provider.api_key, &provider.model, &prompt).await
        }
    }

    /// 调用 Claude API
    async fn call_claude_api(
        &self,
        client: &wreq::Client,
        base_url: &str,
        api_key: &str,
        model: &str,
        prompt: &str,
    ) -> Result<String, String> {
        let endpoint = format!("{}/messages", base_url.trim_end_matches('/'));

        let payload = serde_json::json!({
            "model": model,
            "max_tokens": 50,
            "messages": [{
                "role": "user",
                "content": prompt
            }]
        });

        let response = client
            .post(&endpoint)
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("Claude API request failed: {}", e))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("Claude API error: {}", error_text));
        }

        let result: serde_json::Value = response.json().await
            .map_err(|e| format!("Failed to parse Claude response: {}", e))?;

        if let Some(content) = result["content"][0]["text"].as_str() {
            return self.normalize_ai_designation(content);
        }

        Err("Invalid Claude API response format".to_string())
    }

    /// 调用 OpenAI 兼容 API
    async fn call_openai_compatible_api(
        &self,
        client: &wreq::Client,
        base_url: &str,
        api_key: &str,
        model: &str,
        prompt: &str,
    ) -> Result<String, String> {
        let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));

        let payload = serde_json::json!({
            "model": model,
            "messages": [{
                "role": "user",
                "content": prompt
            }],
            "max_tokens": 50,
            "temperature": 0.3
        });

        let response = client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("content-type", "application/json")
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("OpenAI API request failed: {}", e))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("OpenAI API error: {}", error_text));
        }

        let result: serde_json::Value = response.json().await
            .map_err(|e| format!("Failed to parse OpenAI response: {}", e))?;

        if let Some(content) = result["choices"][0]["message"]["content"].as_str() {
            return self.normalize_ai_designation(content);
        }

        Err("Invalid OpenAI API response format".to_string())
    }

    /// 校验并规范化 AI 返回的番号
    fn normalize_ai_designation(&self, content: &str) -> Result<String, String> {
        let designation = content.trim();

        if designation.to_lowercase().contains("未找到")
            || designation.to_lowercase().contains("not found")
        {
            return Err("AI could not identify designation".to_string());
        }

        // 直接校验 AI 返回的整段内容
        let upper = designation.to_uppercase();
        if self.is_valid_designation(&upper) {
            return Ok(upper);
        }

        // 校验不通过，尝试用正则从 AI 回复里再抽取一次番号
        if let Some(extracted) = self.recognize_with_regex(designation) {
            return Ok(extracted);
        }

        Err("AI could not identify designation".to_string())
    }

    /// 组合识别方法（先正则后 AI），结果含语义标记。
    ///
    /// 标记从原始文件名中提取：正则路径用番号位置精确取后缀标记；
    /// AI 路径仅取全局标记（VR/4K/无码/流出/中文字幕）。
    pub async fn recognize(&self, title: &str, force_ai: bool) -> Result<RecognitionResult, String> {
        // 1. 如果不强制使用 AI，先尝试正则表达式识别
        if !force_ai {
            if let Some(info) = self.recognize_detailed(title) {
                return Ok(RecognitionResult {
                    success: true,
                    designation: Some(info.designation),
                    markers: info.markers,
                    is_uncensored: info.is_uncensored,
                    method: RecognitionMethod::Regex,
                    message: "识别成功（正则匹配）".to_string(),
                });
            }
        }

        // 2. 如果正则识别失败或强制使用 AI，尝试 AI 识别
        if self.ai_provider.is_some() {
            match self.recognize_with_ai(title).await {
                Ok(designation) => {
                    let markers = extract_markers(title, None, &designation);
                    let is_uncensored = is_uncensored_designation(&designation);
                    return Ok(RecognitionResult {
                        success: true,
                        designation: Some(designation),
                        markers,
                        is_uncensored,
                        method: RecognitionMethod::AI,
                        message: "识别成功（AI）".to_string(),
                    });
                }
                Err(e) => {
                    log::warn!(
                        "[designation] event=ai_recognition_failed title={} error={}",
                        title,
                        e
                    );
                }
            }
        }

        // 3. 所有方法都失败
        Ok(RecognitionResult {
            success: false,
            designation: None,
            markers: DesignationMarkers::default(),
            is_uncensored: false,
            method: RecognitionMethod::Failed,
            message: "无法识别番号".to_string(),
        })
    }
}

impl Default for DesignationRecognizer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ============ 覆盖面：基础格式 ============

    #[test]
    fn recognizes_standard_and_no_hyphen() {
        let r = DesignationRecognizer::new();
        assert_eq!(r.recognize_with_regex("ABC-123.mp4"), Some("ABC-123".into()));
        assert_eq!(r.recognize_with_regex("[JAV] ABC-123 [1080p].mp4"), Some("ABC-123".into()));
        assert_eq!(r.recognize_with_regex("ABC123.mp4"), Some("ABC-123".into()));
        assert_eq!(r.recognize_with_regex("SSIS-456.mp4"), Some("SSIS-456".into()));
        assert_eq!(r.recognize_with_regex("T28-123.mp4"), Some("T28-123".into()));
    }

    #[test]
    fn recognizes_fc2() {
        let r = DesignationRecognizer::new();
        assert_eq!(r.recognize_with_regex("FC2-PPV-1234567.mp4"), Some("FC2-1234567".into()));
        assert_eq!(r.recognize_with_regex("FC2PPV1234567.mp4"), Some("FC2-1234567".into()));
    }

    // ============ 覆盖面：新增格式 ============

    #[test]
    fn recognizes_amateur_digit_prefix() {
        let r = DesignationRecognizer::new();
        // 素人：数字前缀不能被截掉
        assert_eq!(r.recognize_with_regex("390JAC-132.mp4"), Some("390JAC-132".into()));
        assert_eq!(r.recognize_with_regex("300MAAN-783.mp4"), Some("300MAAN-783".into()));
    }

    #[test]
    fn recognizes_uncensored_underscore_and_brands() {
        let r = DesignationRecognizer::new();
        assert_eq!(r.recognize_with_regex("123456_999.mp4"), Some("123456-999".into()));
        assert_eq!(r.recognize_with_regex("HEYZO-1234.mp4"), Some("HEYZO-1234".into()));
        assert_eq!(r.recognize_with_regex("KIN8-1675.mp4"), Some("KIN8-1675".into()));
        assert_eq!(r.recognize_with_regex("MYWIFE-1394.mp4"), Some("MYWIFE-1394".into()));
    }

    #[test]
    fn recognizes_space_separator() {
        let r = DesignationRecognizer::new();
        assert_eq!(r.recognize_with_regex("ABC 123.mp4"), Some("ABC-123".into()));
    }

    #[test]
    fn classifies_uncensored_designation() {
        // 无码：纯数字前缀（加勒比/一本道等）+ 已知无码厂牌
        assert!(is_uncensored_designation("123456-999"));
        assert!(is_uncensored_designation("010120-001"));
        assert!(is_uncensored_designation("FC2-1234567"));
        assert!(is_uncensored_designation("HEYZO-1234"));
        assert!(is_uncensored_designation("KIN8-1675"));
        assert!(is_uncensored_designation("heyzo-1234")); // 大小写不敏感
        // 有码：标准番号 + 素人（数字+字母前缀，含字母不误判）
        assert!(!is_uncensored_designation("SSIS-001"));
        assert!(!is_uncensored_designation("300MIUM-700"));
        assert!(!is_uncensored_designation("390JAC-132"));
        assert!(!is_uncensored_designation(""));
    }

    #[test]
    fn recognize_detailed_sets_is_uncensored() {
        let r = DesignationRecognizer::new();
        assert!(r.recognize_detailed("FC2-PPV-1234567.mp4").unwrap().is_uncensored);
        assert!(r.recognize_detailed("123456_999.mp4").unwrap().is_uncensored);
        assert!(!r.recognize_detailed("SSIS-001.mp4").unwrap().is_uncensored);
    }

    #[test]
    fn suffix_letter_does_not_break_designation() {
        let r = DesignationRecognizer::new();
        // 后缀字母不并入番号
        assert_eq!(r.recognize_with_regex("SSIS-001A.mp4"), Some("SSIS-001".into()));
    }

    #[test]
    fn filters_resolution_numbers() {
        let r = DesignationRecognizer::new();
        assert_eq!(r.recognize_with_regex("ABC-1080.mp4"), None);
        assert_eq!(r.recognize_with_regex("XYZ-720.mp4"), None);
        assert_eq!(r.recognize_with_regex("ABC-2160.mp4"), None);
    }

    #[test]
    fn recognize_failure() {
        let r = DesignationRecognizer::new();
        assert_eq!(r.recognize_with_regex("random_video.mp4"), None);
        assert_eq!(r.recognize_with_regex("123456.mp4"), None);
    }

    #[test]
    fn priority_and_position() {
        let r = DesignationRecognizer::new();
        // FC2 优先级最高
        assert_eq!(
            r.recognize_with_regex("ABC-123 FC2-PPV-1234567.mp4"),
            Some("FC2-1234567".into())
        );
        // 同优先级取位置靠后
        assert_eq!(r.recognize_with_regex("ABC-123 DEF-456.mp4"), Some("DEF-456".into()));
    }

    // ============ 语义标记 ============

    #[test]
    fn marker_part_suffix_letter() {
        let r = DesignationRecognizer::new();
        let info = r.recognize_detailed("SSIS-001A.mp4").unwrap();
        assert_eq!(info.designation, "SSIS-001");
        assert_eq!(info.markers.part.as_deref(), Some("A"));
    }

    #[test]
    fn marker_part_cd() {
        let r = DesignationRecognizer::new();
        let info = r.recognize_detailed("MIDE-123-CD2.mp4").unwrap();
        assert_eq!(info.designation, "MIDE-123");
        assert_eq!(info.markers.part.as_deref(), Some("CD2"));
    }

    #[test]
    fn marker_chinese_subtitle() {
        let r = DesignationRecognizer::new();
        assert!(r.recognize_detailed("SSIS-001-C.mp4").unwrap().markers.chinese_subtitle);
        assert!(r.recognize_detailed("SSIS-001-ch.mp4").unwrap().markers.chinese_subtitle);
        assert!(r.recognize_detailed("ABC-123中文字幕.mp4").unwrap().markers.chinese_subtitle);
        // 纯番号不应误判
        assert!(!r.recognize_detailed("SSIS-001.mp4").unwrap().markers.chinese_subtitle);
    }

    #[test]
    fn marker_version_and_vr() {
        let r = DesignationRecognizer::new();
        assert_eq!(
            r.recognize_detailed("SSIS-001-4K.mp4").unwrap().markers.resolution.as_deref(),
            Some("4K")
        );
        assert!(r.recognize_detailed("SSIS-001-UC.mp4").unwrap().markers.uncensored);
        assert!(r.recognize_detailed("SSIS-001-LEAK.mp4").unwrap().markers.leaked);
        // VR：厂牌前缀
        assert!(r.recognize_detailed("SIVR-00123.mp4").unwrap().markers.vr);
        // VR：文件标记
        assert!(r.recognize_detailed("[VR] ABC-123.mp4").unwrap().markers.vr);
    }

    #[test]
    fn markers_to_tags() {
        let r = DesignationRecognizer::new();
        let info = r.recognize_detailed("SSIS-001-C-CD1.mp4").unwrap();
        assert_eq!(info.designation, "SSIS-001");
        let tags = info.markers.to_tags();
        assert!(tags.contains(&"中文字幕".to_string()));
        assert!(tags.contains(&"分片CD1".to_string()));
    }

    #[test]
    fn clean_designation_has_no_markers() {
        let r = DesignationRecognizer::new();
        let info = r.recognize_detailed("ABC-123.mp4").unwrap();
        assert!(info.markers.is_empty());
    }

    #[test]
    fn amateur_prefix_not_eaten_by_longer_digit_run() {
        let r = DesignationRecognizer::new();
        // 日期戳直接拼番号：不应把日期数字吞进素人前缀
        assert_eq!(r.recognize_with_regex("20231231SSIS-001.mp4"), Some("SSIS-001".into()));
        // 正常素人仍识别
        assert_eq!(r.recognize_with_regex("390JAC-132.mp4"), Some("390JAC-132".into()));
    }

    #[test]
    fn article_after_space_not_treated_as_part() {
        let r = DesignationRecognizer::new();
        let info = r.recognize_detailed("ABC-123 a movie.mp4").unwrap();
        assert_eq!(info.designation, "ABC-123");
        assert!(info.markers.part.is_none(), "空格后的冠词 a 不应被当成分片");
        // 紧邻后缀字母仍正确
        assert_eq!(r.recognize_detailed("SSIS-001A.mp4").unwrap().markers.part.as_deref(), Some("A"));
    }
}
