#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AIProviderProtocol {
    OpenAICompatible,
    AnthropicCompatible,
}

#[derive(Debug, Clone, Copy)]
pub struct AIProviderDefaults {
    pub endpoint: Option<&'static str>,
    pub protocol: AIProviderProtocol,
}

pub fn resolve_provider_defaults(provider: &str) -> Option<AIProviderDefaults> {
    let defaults = match provider {
        "openai" => AIProviderDefaults {
            endpoint: Some("https://api.openai.com/v1"),
            protocol: AIProviderProtocol::OpenAICompatible,
        },
        "deepseek" => AIProviderDefaults {
            endpoint: Some("https://api.deepseek.com/v1"),
            protocol: AIProviderProtocol::OpenAICompatible,
        },
        "claude" => AIProviderDefaults {
            endpoint: Some("https://api.anthropic.com/v1"),
            protocol: AIProviderProtocol::AnthropicCompatible,
        },
        "minimax" => AIProviderDefaults {
            endpoint: Some("https://api.minimax.io/v1"),
            protocol: AIProviderProtocol::OpenAICompatible,
        },
        "minimax-cn" => AIProviderDefaults {
            endpoint: Some("https://api.minimaxi.com/v1"),
            protocol: AIProviderProtocol::OpenAICompatible,
        },
        "minimax-anthropic" => AIProviderDefaults {
            endpoint: Some("https://api.minimax.io/anthropic"),
            protocol: AIProviderProtocol::AnthropicCompatible,
        },
        "minimax-cn-anthropic" => AIProviderDefaults {
            endpoint: Some("https://api.minimaxi.com/anthropic"),
            protocol: AIProviderProtocol::AnthropicCompatible,
        },
        "custom" => AIProviderDefaults {
            endpoint: None,
            protocol: AIProviderProtocol::OpenAICompatible,
        },
        _ => return None,
    };

    Some(defaults)
}

pub fn resolve_base_url<'a>(
    configured_endpoint: Option<&'a str>,
    defaults: AIProviderDefaults,
) -> Option<&'a str> {
    match configured_endpoint {
        Some(endpoint) if !endpoint.trim().is_empty() => Some(endpoint),
        _ => defaults.endpoint,
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_base_url, resolve_provider_defaults, AIProviderProtocol};

    #[test]
    fn resolves_minimax_global_openai_defaults() {
        let defaults = resolve_provider_defaults("minimax").expect("provider defaults");

        assert_eq!(defaults.endpoint, Some("https://api.minimax.io/v1"));
        assert_eq!(defaults.protocol, AIProviderProtocol::OpenAICompatible);
    }

    #[test]
    fn resolves_minimax_cn_anthropic_defaults() {
        let defaults =
            resolve_provider_defaults("minimax-cn-anthropic").expect("provider defaults");

        assert_eq!(
            defaults.endpoint,
            Some("https://api.minimaxi.com/anthropic")
        );
        assert_eq!(defaults.protocol, AIProviderProtocol::AnthropicCompatible);
    }

    #[test]
    fn configured_endpoint_overrides_provider_default() {
        let defaults = resolve_provider_defaults("minimax").expect("provider defaults");

        assert_eq!(
            resolve_base_url(Some("https://example.test/v1"), defaults),
            Some("https://example.test/v1")
        );
    }
}
