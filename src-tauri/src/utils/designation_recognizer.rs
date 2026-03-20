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

/// 识别结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecognitionResult {
    pub success: bool,
    pub designation: Option<String>,
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

impl DesignationRecognizer {
    /// 创建新的番号识别器实例
    /// 
    /// 初始化常见的番号格式正则表达式，按优先级排序：
    /// 1. FC2-PPV 格式 (最高优先级 100)
    /// 2. 标准格式带连字符 ABC-123 (优先级 90)
    /// 3. 字母+数字混合前缀 T28-123 (优先级 85)
    /// 4. 无连字符格式 ABC123 (优先级 80)
    /// 5. 纯数字格式 123456-789 (最低优先级 70)
    pub fn new() -> Self {
        let regex_patterns = vec![
            // FC2-PPV-123456 格式 (最高优先级)
            (Regex::new(r"(?i)(FC2)-?PPV-?(\d{6,8})").unwrap(), 100),
            
            // ABC-123 格式 (纯字母前缀带连字符，高优先级)
            (Regex::new(r"(?i)([A-Z]{2,6})-(\d{3,5})").unwrap(), 90),
            
            // T28-123 格式 (字母+数字混合前缀，中高优先级)
            (Regex::new(r"(?i)([A-Z]+\d+)-(\d{3,5})").unwrap(), 85),
            
            // ABC123 格式 (无连字符，中优先级)
            (Regex::new(r"(?i)([A-Z]{2,6})(\d{3,5})(?:[^A-Z0-9]|$)").unwrap(), 80),
            
            // 123456-789 格式 (纯数字，低优先级)
            (Regex::new(r"(?i)(\d{6})[_-](\d{3,5})").unwrap(), 70),
        ];

        DesignationRecognizer {
            regex_patterns,
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

    /// 使用正则表达式识别番号
    /// 
    /// # 参数
    /// * `title` - 视频文件名或标题
    /// 
    /// # 返回值
    /// * `Some(String)` - 识别成功，返回番号（大写格式）
    /// * `None` - 识别失败
    /// 
    /// # 识别策略
    /// 1. 使用多个正则表达式模式匹配标题
    /// 2. 收集所有可能的候选番号
    /// 3. 按优先级和位置排序（优先级高的优先，位置靠后的优先）
    /// 4. 过滤掉不合理的结果
    /// 5. 返回最佳匹配
    /// 
    /// # 示例
    /// ```
    /// let recognizer = DesignationRecognizer::new();
    /// 
    /// // 标准格式
    /// assert_eq!(recognizer.recognize_with_regex("ABC-123.mp4"), Some("ABC-123".to_string()));
    /// 
    /// // 无连字符格式
    /// assert_eq!(recognizer.recognize_with_regex("ABC123.mp4"), Some("ABC-123".to_string()));
    /// 
    /// // FC2 格式
    /// assert_eq!(recognizer.recognize_with_regex("FC2-PPV-1234567.mp4"), Some("FC2-1234567".to_string()));
    /// ```
    pub fn recognize_with_regex(&self, title: &str) -> Option<String> {
        let mut candidates: Vec<(String, i32, usize)> = Vec::new();

        // 遍历所有正则表达式模式
        for (pattern, priority) in &self.regex_patterns {
            for captures in pattern.captures_iter(title) {
                // 提取番号
                let designation = if captures.len() >= 3 {
                    // 有多个捕获组，组合成 "前缀-数字" 格式
                    format!("{}-{}", &captures[1], &captures[2])
                } else {
                    // 只有一个捕获组，直接使用
                    captures[0].to_string()
                };
                
                // 记录匹配位置（越靠后越可能是真实番号）
                let position = captures.get(0).map(|m| m.start()).unwrap_or(0);
                
                #[cfg(test)]
                println!("Found candidate: {} (priority: {}, position: {})", designation, priority, position);
                
                candidates.push((designation, *priority, position));
            }
        }

        // 按优先级和位置排序（优先级高的优先，位置靠后的优先）
        candidates.sort_by(|a, b| {
            b.1.cmp(&a.1).then(b.2.cmp(&a.2))
        });

        // 过滤掉明显不合理的结果
        candidates.retain(|(designation, _, _)| {
            let is_valid = self.is_valid_designation(designation);
            
            #[cfg(test)]
            println!("Validating {}: {}", designation, is_valid);
            
            is_valid
        });

        // 返回最佳匹配
        candidates.first().map(|(designation, _, _)| designation.to_uppercase())
    }

    /// 验证番号是否合理
    /// 
    /// # 参数
    /// * `designation` - 待验证的番号
    /// 
    /// # 返回值
    /// * `true` - 番号格式合理
    /// * `false` - 番号格式不合理
    /// 
    /// # 验证规则
    /// 1. 前缀部分长度应该在 2-6 之间
    /// 2. 数字部分应该是 3-8 位（支持 FC2 的长数字）
    /// 3. 排除常见的非番号数字（如 800, 1080, 720 等分辨率）
    fn is_valid_designation(&self, designation: &str) -> bool {
        let parts: Vec<&str> = designation.split('-').collect();
        
        if parts.len() != 2 {
            return false;
        }

        let prefix_part = parts[0];
        let number_part = parts[1];
        
        // 验证前缀部分长度（可以包含字母和数字）
        let prefix_len = prefix_part.len();
        if prefix_len < 2 || prefix_len > 6 {
            return false;
        }
        
        // 验证数字部分长度（支持 FC2 的 6-8 位数字）
        let number_len = number_part.len();
        if number_len < 3 || number_len > 8 {
            return false;
        }
        
        // 排除常见的非番号数字（分辨率等）
        if ["800", "1080", "720", "480", "360"].contains(&number_part) {
            return false;
        }
        
        true
    }

    /// 使用 AI 识别番号
    /// 
    /// # 参数
    /// * `title` - 视频文件名或标题
    /// 
    /// # 返回值
    /// * `Ok(String)` - 识别成功，返回番号
    /// * `Err(String)` - 识别失败，返回错误信息
    /// 
    /// # 示例
    /// ```
    /// let recognizer = DesignationRecognizer::with_ai_provider(ai_provider);
    /// let result = recognizer.recognize_with_ai("some_video_file.mp4").await;
    /// ```
    pub async fn recognize_with_ai(&self, title: &str) -> Result<String, String> {
        let provider = self.ai_provider.as_ref()
            .ok_or_else(|| "No AI provider configured".to_string())?;

        let client = crate::utils::proxy::apply_proxy_auto(
            reqwest::Client::builder()
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

请只返回识别出的番号，不要有任何其他解释。如果无法识别，请回复"未找到"。"#,
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
        client: &reqwest::Client,
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
            let designation = content.trim();
            if designation.to_lowercase().contains("未找到")
                || designation.to_lowercase().contains("not found")
            {
                return Err("AI could not identify designation".to_string());
            }
            return Ok(designation.to_uppercase());
        }

        Err("Invalid Claude API response format".to_string())
    }

    /// 调用 OpenAI 兼容 API
    async fn call_openai_compatible_api(
        &self,
        client: &reqwest::Client,
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
            let designation = content.trim();
            if designation.to_lowercase().contains("未找到")
                || designation.to_lowercase().contains("not found")
            {
                return Err("AI could not identify designation".to_string());
            }
            return Ok(designation.to_uppercase());
        }

        Err("Invalid OpenAI API response format".to_string())
    }

    /// 组合识别方法（先正则后 AI）
    /// 
    /// # 参数
    /// * `title` - 视频文件名或标题
    /// * `force_ai` - 是否强制使用 AI（跳过正则识别）
    /// 
    /// # 返回值
    /// * `Ok(RecognitionResult)` - 识别结果
    /// * `Err(String)` - 识别过程中的错误
    /// 
    /// # 识别策略
    /// 1. 如果 force_ai 为 false，先尝试正则表达式识别
    /// 2. 如果正则识别失败且配置了 AI，尝试 AI 识别
    /// 3. 如果都失败，返回失败结果
    /// 
    /// # 示例
    /// ```
    /// let recognizer = DesignationRecognizer::with_ai_provider(ai_provider);
    /// let result = recognizer.recognize("ABC-123.mp4", false).await?;
    /// assert_eq!(result.method, RecognitionMethod::Regex);
    /// ```
    pub async fn recognize(&self, title: &str, force_ai: bool) -> Result<RecognitionResult, String> {
        // 1. 如果不强制使用 AI，先尝试正则表达式识别
        if !force_ai {
            if let Some(designation) = self.recognize_with_regex(title) {
                return Ok(RecognitionResult {
                    success: true,
                    designation: Some(designation),
                    method: RecognitionMethod::Regex,
                    message: "识别成功（正则匹配）".to_string(),
                });
            }
        }

        // 2. 如果正则识别失败或强制使用 AI，尝试 AI 识别
        if self.ai_provider.is_some() {
            match self.recognize_with_ai(title).await {
                Ok(designation) => {
                    return Ok(RecognitionResult {
                        success: true,
                        designation: Some(designation),
                        method: RecognitionMethod::AI,
                        message: "识别成功（AI）".to_string(),
                    });
                }
                Err(e) => {
                    // AI 识别失败，继续到下一步
                    eprintln!("AI recognition failed: {}", e);
                }
            }
        }

        // 3. 所有方法都失败
        Ok(RecognitionResult {
            success: false,
            designation: None,
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

    #[test]
    fn test_recognize_standard_format() {
        let recognizer = DesignationRecognizer::new();
        
        // 标准格式 ABC-123
        assert_eq!(
            recognizer.recognize_with_regex("ABC-123.mp4"),
            Some("ABC-123".to_string())
        );
        
        // 标准格式带前缀
        assert_eq!(
            recognizer.recognize_with_regex("[JAV] ABC-123 [1080p].mp4"),
            Some("ABC-123".to_string())
        );
    }

    #[test]
    fn test_recognize_no_hyphen_format() {
        let recognizer = DesignationRecognizer::new();
        
        // 无连字符格式
        assert_eq!(
            recognizer.recognize_with_regex("ABC123.mp4"),
            Some("ABC-123".to_string())
        );
        
        // 无连字符格式带前缀
        assert_eq!(
            recognizer.recognize_with_regex("[JAV] ABC123 [1080p].mp4"),
            Some("ABC-123".to_string())
        );
    }

    #[test]
    fn test_recognize_fc2_format() {
        let recognizer = DesignationRecognizer::new();
        
        // FC2-PPV 格式
        assert_eq!(
            recognizer.recognize_with_regex("FC2-PPV-1234567.mp4"),
            Some("FC2-1234567".to_string())
        );
        
        // FC2PPV 格式（无连字符）
        assert_eq!(
            recognizer.recognize_with_regex("FC2PPV1234567.mp4"),
            Some("FC2-1234567".to_string())
        );
    }

    #[test]
    fn test_recognize_special_format() {
        let recognizer = DesignationRecognizer::new();
        
        // T28 格式
        assert_eq!(
            recognizer.recognize_with_regex("T28-123.mp4"),
            Some("T28-123".to_string())
        );
        
        // SSIS 格式
        assert_eq!(
            recognizer.recognize_with_regex("SSIS-456.mp4"),
            Some("SSIS-456".to_string())
        );
    }

    #[test]
    fn test_recognize_failure() {
        let recognizer = DesignationRecognizer::new();
        
        // 无法识别的格式
        assert_eq!(
            recognizer.recognize_with_regex("random_video.mp4"),
            None
        );
        
        // 只有数字
        assert_eq!(
            recognizer.recognize_with_regex("123456.mp4"),
            None
        );
    }

    #[test]
    fn test_filter_resolution_numbers() {
        let recognizer = DesignationRecognizer::new();
        
        // 应该过滤掉分辨率数字
        let result = recognizer.recognize_with_regex("ABC-1080.mp4");
        assert_eq!(result, None);
        
        let result = recognizer.recognize_with_regex("XYZ-720.mp4");
        assert_eq!(result, None);
    }

    #[test]
    fn test_priority_selection() {
        let recognizer = DesignationRecognizer::new();
        
        // 当有多个匹配时，应该选择优先级最高的
        // FC2 格式优先级最高
        let result = recognizer.recognize_with_regex("ABC-123 FC2-PPV-1234567.mp4");
        assert_eq!(result, Some("FC2-1234567".to_string()));
    }

    #[test]
    fn test_position_preference() {
        let recognizer = DesignationRecognizer::new();
        
        // 当优先级相同时，应该选择位置靠后的
        let result = recognizer.recognize_with_regex("ABC-123 DEF-456.mp4");
        // DEF-456 位置靠后，应该被选中
        assert_eq!(result, Some("DEF-456".to_string()));
    }
}
