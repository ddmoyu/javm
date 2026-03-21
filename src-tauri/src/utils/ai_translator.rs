use crate::resource_scrape::types::{ScrapeMetadata, SearchResult};
use crate::settings::{self, AIProvider as SettingsAIProvider};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Serialize)]
struct TranslationInput {
	title: String,
	plot: String,
	outline: String,
	tagline: String,
	studio: String,
	director: String,
	tags: Vec<String>,
	genres: Vec<String>,
	set_name: String,
	maker: String,
	publisher: String,
	label: String,
}

#[derive(Debug, Deserialize, Default)]
struct TranslationOutput {
	#[serde(default)]
	title: String,
	#[serde(default)]
	plot: String,
	#[serde(default)]
	outline: String,
	#[serde(default)]
	tagline: String,
	#[serde(default)]
	studio: String,
	#[serde(default)]
	director: String,
	#[serde(default)]
	tags: Vec<String>,
	#[serde(default)]
	genres: Vec<String>,
	#[serde(default)]
	set_name: String,
	#[serde(default)]
	maker: String,
	#[serde(default)]
	publisher: String,
	#[serde(default)]
	label: String,
}

pub async fn translate_scrape_metadata(
	app: &AppHandle,
	metadata: &ScrapeMetadata,
) -> Result<ScrapeMetadata, String> {
	let settings = settings::get_settings(app.clone()).await?;
	if !settings.ai.translate_scrape_result {
		return Ok(metadata.clone());
	}

	let provider = settings
		.ai
		.providers
		.iter()
		.filter(|provider| provider.active)
		.min_by_key(|provider| provider.priority)
		.ok_or_else(|| "已启用刮削翻译，但未找到可用的 AI 提供商".to_string())?;

	let target_language = map_target_language(&settings.theme.language);
	let input = TranslationInput {
		title: metadata.title.clone(),
		plot: metadata.plot.clone(),
		outline: metadata.outline.clone(),
		tagline: metadata.tagline.clone(),
		studio: metadata.studio.clone(),
		director: metadata.director.clone(),
		tags: metadata.tags.clone(),
		genres: metadata.genres.clone(),
		set_name: metadata.set_name.clone(),
		maker: metadata.maker.clone(),
		publisher: metadata.publisher.clone(),
		label: metadata.label.clone(),
	};

	let input_json = serde_json::to_string(&input).map_err(|e| format!("构建翻译请求失败: {}", e))?;
	let prompt = format!(
		"你是一个视频元数据翻译器。\n请将输入 JSON 中的文本翻译成目标语言：{}。\n仅翻译明显是日语或英语的内容；其他语言保持原样。\n保留专有名词、番号、人名、组织名，不要音译、不增加解释。\n必须严格返回 JSON，对象字段与输入完全一致，不能新增字段，不能输出 markdown。\n\n输入 JSON:\n{}",
		target_language, input_json
	);

	let content = call_provider(provider, &prompt).await?;
	let json_payload = extract_json_object(&content).ok_or_else(|| "翻译响应不是有效 JSON".to_string())?;
	let translated: TranslationOutput =
		serde_json::from_str(&json_payload).map_err(|e| format!("解析翻译结果失败: {}", e))?;

	Ok(apply_translation(metadata, translated))
}

/// 翻译搜索结果（SearchResult），用于刮削搜索后、展示给用户前
pub async fn translate_search_result(
	app: &AppHandle,
	result: &SearchResult,
) -> Result<SearchResult, String> {
	let settings = settings::get_settings(app.clone()).await?;
	if !settings.ai.translate_scrape_result {
		return Ok(result.clone());
	}

	let provider = settings
		.ai
		.providers
		.iter()
		.filter(|provider| provider.active)
		.min_by_key(|provider| provider.priority)
		.ok_or_else(|| "已启用刮削翻译，但未找到可用的 AI 提供商".to_string())?;

	let target_language = map_target_language(&settings.theme.language);

	// SearchResult 的 tags/genres 是逗号分隔字符串，先拆成 Vec
	let tags_vec: Vec<String> = result
		.tags
		.split(',')
		.map(|s| s.trim().to_string())
		.filter(|s| !s.is_empty())
		.collect();
	let genres_vec: Vec<String> = result
		.genres
		.split(',')
		.map(|s| s.trim().to_string())
		.filter(|s| !s.is_empty())
		.collect();

	let input = TranslationInput {
		title: result.title.clone(),
		plot: result.plot.clone(),
		outline: result.outline.clone(),
		tagline: result.tagline.clone(),
		studio: result.studio.clone(),
		director: result.director.clone(),
		tags: tags_vec,
		genres: genres_vec,
		set_name: result.set_name.clone(),
		maker: result.maker.clone(),
		publisher: result.publisher.clone(),
		label: result.label.clone(),
	};

	let input_json = serde_json::to_string(&input).map_err(|e| format!("构建翻译请求失败: {}", e))?;
	let prompt = format!(
		"你是一个视频元数据翻译器。\n请将输入 JSON 中的文本翻译成目标语言：{}。\n仅翻译明显是日语或英语的内容；其他语言保持原样。\n保留专有名词、番号、人名、组织名，不要音译、不增加解释。\n必须严格返回 JSON，对象字段与输入完全一致，不能新增字段，不能输出 markdown。\n\n输入 JSON:\n{}",
		target_language, input_json
	);

	let content = call_provider(provider, &prompt).await?;
	let json_payload = extract_json_object(&content).ok_or_else(|| "翻译响应不是有效 JSON".to_string())?;
	let translated: TranslationOutput =
		serde_json::from_str(&json_payload).map_err(|e| format!("解析翻译结果失败: {}", e))?;

	Ok(apply_search_result_translation(result, translated))
}

fn apply_search_result_translation(result: &SearchResult, translated: TranslationOutput) -> SearchResult {
	let mut out = result.clone();

	apply_non_empty(&mut out.title, translated.title);
	apply_non_empty(&mut out.plot, translated.plot);
	apply_non_empty(&mut out.outline, translated.outline);
	apply_non_empty(&mut out.tagline, translated.tagline);
	apply_non_empty(&mut out.studio, translated.studio);
	apply_non_empty(&mut out.director, translated.director);
	apply_non_empty(&mut out.set_name, translated.set_name);
	apply_non_empty(&mut out.maker, translated.maker);
	apply_non_empty(&mut out.publisher, translated.publisher);
	apply_non_empty(&mut out.label, translated.label);

	// tags/genres 翻译后重新拼回逗号分隔字符串
	if !translated.tags.is_empty() {
		out.tags = translated
			.tags
			.into_iter()
			.map(|item| item.trim().to_string())
			.filter(|item| !item.is_empty())
			.collect::<Vec<_>>()
			.join(", ");
	}

	if !translated.genres.is_empty() {
		out.genres = translated
			.genres
			.into_iter()
			.map(|item| item.trim().to_string())
			.filter(|item| !item.is_empty())
			.collect::<Vec<_>>()
			.join(", ");
	}

	out
}

fn apply_translation(metadata: &ScrapeMetadata, translated: TranslationOutput) -> ScrapeMetadata {
	let mut result = metadata.clone();

	apply_non_empty(&mut result.title, translated.title);
	apply_non_empty(&mut result.plot, translated.plot);
	apply_non_empty(&mut result.outline, translated.outline);
	apply_non_empty(&mut result.tagline, translated.tagline);
	apply_non_empty(&mut result.studio, translated.studio);
	apply_non_empty(&mut result.director, translated.director);
	apply_non_empty(&mut result.set_name, translated.set_name);
	apply_non_empty(&mut result.maker, translated.maker);
	apply_non_empty(&mut result.publisher, translated.publisher);
	apply_non_empty(&mut result.label, translated.label);

	if !translated.tags.is_empty() {
		result.tags = translated
			.tags
			.into_iter()
			.map(|item| item.trim().to_string())
			.filter(|item| !item.is_empty())
			.collect();
	}

	if !translated.genres.is_empty() {
		result.genres = translated
			.genres
			.into_iter()
			.map(|item| item.trim().to_string())
			.filter(|item| !item.is_empty())
			.collect();
	}

	result
}

fn apply_non_empty(target: &mut String, candidate: String) {
	let value = candidate.trim();
	if !value.is_empty() {
		*target = value.to_string();
	}
}

fn map_target_language(language: &str) -> &'static str {
	match language.trim().to_lowercase().as_str() {
		"zh-cn" => "简体中文",
		"zh-tw" => "繁體中文",
		"en" | "en-us" | "en-gb" => "English",
		"ja" | "ja-jp" => "日本語",
		_ => "简体中文",
	}
}

async fn call_provider(provider: &SettingsAIProvider, prompt: &str) -> Result<String, String> {
	let client = crate::utils::proxy::apply_proxy_auto(
		reqwest::Client::builder().timeout(std::time::Duration::from_secs(40)),
	)
	.map_err(|e| e.to_string())?
	.build()
	.map_err(|e| e.to_string())?;

	let default_endpoint = match provider.provider.as_str() {
		"openai" => Some("https://api.openai.com/v1".to_string()),
		"deepseek" => Some("https://api.deepseek.com/v1".to_string()),
		"claude" => Some("https://api.anthropic.com/v1".to_string()),
		"custom" => None, // custom 类型必须由用户提供 endpoint
		_ => return Err(format!("不支持的 AI 提供商: {}", provider.provider)),
	};

	let base_url = match (provider.endpoint.as_deref(), default_endpoint.as_deref()) {
		(Some(ep), _) if !ep.is_empty() => ep,
		(_, Some(def)) => def,
		_ => return Err("自定义 AI 提供商未配置 endpoint".to_string()),
	};

	if provider.provider == "claude" {
		call_claude_api(&client, base_url, &provider.api_key, &provider.model, prompt).await
	} else {
		// openai / deepseek / custom 均走 OpenAI 兼容接口
		call_openai_compatible_api(&client, base_url, &provider.api_key, &provider.model, prompt).await
	}
}

async fn call_claude_api(
	client: &reqwest::Client,
	base_url: &str,
	api_key: &str,
	model: &str,
	prompt: &str,
) -> Result<String, String> {
	let endpoint = format!("{}/messages", base_url.trim_end_matches('/'));

	let payload = serde_json::json!({
		"model": model,
		"max_tokens": 1400,
		"temperature": 0.2,
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
		.map_err(|e| format!("Claude 请求失败: {}", e))?;

	if !response.status().is_success() {
		let error_text = response.text().await.unwrap_or_else(|_| "未知错误".to_string());
		return Err(format!("Claude 响应错误: {}", error_text));
	}

	let result: serde_json::Value = response
		.json()
		.await
		.map_err(|e| format!("解析 Claude 响应失败: {}", e))?;

	result["content"][0]["text"]
		.as_str()
		.map(|value| value.trim().to_string())
		.filter(|value| !value.is_empty())
		.ok_or_else(|| "Claude 返回内容为空".to_string())
}

async fn call_openai_compatible_api(
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
		"max_tokens": 1400,
		"temperature": 0.2,
		"response_format": { "type": "json_object" }
	});

	let response = client
		.post(&endpoint)
		.header("Authorization", format!("Bearer {}", api_key))
		.header("content-type", "application/json")
		.json(&payload)
		.send()
		.await
		.map_err(|e| format!("OpenAI 兼容请求失败: {}", e))?;

	if !response.status().is_success() {
		let error_text = response.text().await.unwrap_or_else(|_| "未知错误".to_string());
		return Err(format!("OpenAI 兼容响应错误: {}", error_text));
	}

	let result: serde_json::Value = response
		.json()
		.await
		.map_err(|e| format!("解析 OpenAI 兼容响应失败: {}", e))?;

	result["choices"][0]["message"]["content"]
		.as_str()
		.map(|value| value.trim().to_string())
		.filter(|value| !value.is_empty())
		.ok_or_else(|| "OpenAI 兼容返回内容为空".to_string())
}

fn extract_json_object(raw: &str) -> Option<String> {
	let trimmed = raw.trim();
	if trimmed.starts_with('{') && trimmed.ends_with('}') {
		return Some(trimmed.to_string());
	}

	let start = trimmed.find('{')?;
	let end = trimmed.rfind('}')?;
	if end <= start {
		return None;
	}

	Some(trimmed[start..=end].to_string())
}
