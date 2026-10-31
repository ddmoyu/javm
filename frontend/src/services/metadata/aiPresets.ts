export type AiProtocol = "openai" | "anthropic";

export const MINIMAX_MODELS = ["MiniMax-M3.1-Flash", "MiniMax-M3"];
export const MINIMAX_PRESETS = [
  {
    id: "minimax",
    name: "MiniMax 国际版",
    endpoint: "https://api.minimax.io/v1",
    protocol: "openai",
  },
  {
    id: "minimax-cn",
    name: "MiniMax 中国版",
    endpoint: "https://api.minimaxi.com/v1",
    protocol: "openai",
  },
  {
    id: "minimax-anthropic",
    name: "MiniMax 国际版",
    endpoint: "https://api.minimax.io/anthropic/v1",
    protocol: "anthropic",
  },
  {
    id: "minimax-cn-anthropic",
    name: "MiniMax 中国版",
    endpoint: "https://api.minimaxi.com/anthropic/v1",
    protocol: "anthropic",
  },
] satisfies { id: string; name: string; endpoint: string; protocol: AiProtocol }[];

export function minimaxPreset(endpoint: string) {
  return MINIMAX_PRESETS.find((preset) => preset.endpoint === endpoint.trim().replace(/\/+$/, ""));
}

export function applyAiProtocol(endpoint: string, protocol: AiProtocol) {
  const current = minimaxPreset(endpoint);
  const next = current
    ? MINIMAX_PRESETS.find(
        (preset) =>
          preset.protocol === protocol &&
          new URL(preset.endpoint).origin === new URL(current.endpoint).origin,
      )
    : undefined;
  // 只切换已知预设的同地区地址，不猜测或改写自定义网关路径。
  return { protocol, endpoint: next?.endpoint ?? endpoint };
}

export function applyAiPreset(id: string) {
  const preset = MINIMAX_PRESETS.find((item) => item.id === id);
  return preset
    ? {
        name: preset.name,
        endpoint: preset.endpoint,
        protocol: preset.protocol,
        model: MINIMAX_MODELS[0]!,
      }
    : {};
}
