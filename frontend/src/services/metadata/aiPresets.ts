export type AiProtocol = "openai" | "anthropic";

export const MINIMAX_MODELS = ["MiniMax-M3.1-Flash", "MiniMax-M3"];
export const MINIMAX_PRESETS = [
  { id: "minimax", name: "MiniMax", endpoint: "https://api.minimax.io/v1", protocol: "openai" },
  {
    id: "minimax-cn",
    name: "MiniMax CN",
    endpoint: "https://api.minimaxi.com/v1",
    protocol: "openai",
  },
  {
    id: "minimax-anthropic",
    name: "MiniMax Anthropic",
    endpoint: "https://api.minimax.io/anthropic/v1",
    protocol: "anthropic",
  },
  {
    id: "minimax-cn-anthropic",
    name: "MiniMax CN Anthropic",
    endpoint: "https://api.minimaxi.com/anthropic/v1",
    protocol: "anthropic",
  },
] satisfies { id: string; name: string; endpoint: string; protocol: AiProtocol }[];

export function minimaxPreset(endpoint: string) {
  return MINIMAX_PRESETS.find((preset) => preset.endpoint === endpoint.replace(/\/+$/, ""));
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
