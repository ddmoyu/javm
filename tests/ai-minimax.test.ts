import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  AiService,
  defaultAiSettings,
  validateAiSettings,
} from "../frontend/src/services/metadata/AiService";
import type { AiProvider, AiSettings } from "../frontend/src/services/metadata/AiService";
import {
  applyAiPreset,
  MINIMAX_MODELS,
  MINIMAX_PRESETS,
} from "../frontend/src/services/metadata/aiPresets";
import { createMetadataHttp } from "../frontend/src/platform/neutralino/metadataHttp";
import type { NetworkSettingsService } from "../frontend/src/services/network/NetworkSettingsService";

const mock = vi.hoisted(() => ({
  response: "",
  request: vi.fn(
    async (_request: { url: string; body?: string; headers?: Record<string, string> }) => ({
      status: 200,
      exitCode: 0,
      elapsedMs: 1,
    }),
  ),
}));
vi.mock("@neutralinojs/lib", () => ({
  filesystem: {
    createDirectory: async () => {},
    remove: async () => {},
    getStats: async () => ({ isFile: true, size: mock.response.length }),
    readFile: async () => mock.response,
  },
  os: { getPath: async () => "C:/safe/temp" },
}));
vi.mock("../frontend/src/platform/neutralino/http", () => ({ requestHttp: mock.request }));
vi.mock("../frontend/src/platform/neutralino/process", () => ({ encodedPowerShell: () => "" }));
vi.mock("../frontend/src/platform/neutralino/playbackSettings", () => ({
  playbackStorage: () => ({}),
}));
vi.mock("../frontend/src/platform/neutralino/library", () => ({ NativeLibraryPort: class {} }));
vi.mock("../frontend/src/platform/neutralino/toolPaths", () => ({ toolPlatform: () => "Windows" }));

const provider = (
  preset: (typeof MINIMAX_PRESETS)[number],
  model = MINIMAX_MODELS[0]!,
): AiProvider => ({
  id: "fixture",
  name: preset.name,
  enabled: true,
  endpoint: preset.endpoint,
  protocol: preset.protocol,
  model,
  apiKey: "fixture-key",
});
const settings = (value: AiProvider): AiSettings => ({
  ...defaultAiSettings,
  enabled: true,
  providers: [value],
});
function service(value: AiSettings) {
  let saved = value;
  return new AiService(
    {
      read: async () => saved,
      write: async (next) => {
        saved = next;
      },
    },
    createMetadataHttp({ getProxy: async () => "" } as unknown as NetworkSettingsService),
    true,
  );
}
function reply(protocol: string | undefined, value: unknown, stop = "end_turn") {
  mock.response = JSON.stringify(
    protocol === "anthropic"
      ? {
          stop_reason: stop,
          content: [
            { type: "thinking", thinking: "fixture reasoning" },
            { type: "text", text: JSON.stringify(value) },
          ],
        }
      : { choices: [{ message: { content: JSON.stringify(value) } }] },
  );
}
beforeEach(() => {
  mock.request.mockClear();
  mock.response = "";
});

describe("MiniMax presets and serialized HTTP requests", () => {
  it("offers Flash first and M3 without rewriting saved or custom models", () => {
    expect(MINIMAX_MODELS).toEqual(["MiniMax-M3.1-Flash", "MiniMax-M3"]);
    for (const preset of MINIMAX_PRESETS) {
      expect(applyAiPreset(preset.id)).toEqual({
        name: preset.name,
        endpoint: preset.endpoint,
        protocol: preset.protocol,
        model: "MiniMax-M3.1-Flash",
      });
      for (const model of ["MiniMax-M2.7", "custom-model"]) {
        const saved = settings(provider(preset, model));
        expect(validateAiSettings(saved).providers).toEqual(saved.providers);
      }
    }
    expect(applyAiPreset("custom")).toEqual({});
  });

  for (const preset of MINIMAX_PRESETS) {
    for (const model of [...MINIMAX_MODELS, "MiniMax-M2.7", "custom-model"]) {
      it(`serializes ${preset.id} ${model} through the production HTTP adapter`, async () => {
        const saved = settings(provider(preset, model));
        const ai = service(saved);
        try {
          await ai.settings.save(saved);
          reply(preset.protocol, { ok: true });
          await ai.test(ai.settings.getSnapshot().value);
          const request = mock.request.mock.calls[0]![0];
          expect(request.url).toBe(
            `${preset.endpoint}/${preset.protocol === "anthropic" ? "messages" : "chat/completions"}`,
          );
          const body = JSON.parse(request.body!) as Record<string, unknown>;
          expect(body.model).toBe(model);
          expect(body.stream).toBe(false);
          expect(body).not.toHaveProperty("service_tier");
          expect(body).not.toHaveProperty("reasoning_split");
          expect(body).not.toHaveProperty("reasoning_effort");
          expect(body).not.toHaveProperty("thinking");
          expect(body).not.toHaveProperty("output_config");
          if (preset.protocol === "anthropic") {
            expect(body.system).toBe('Return exactly one JSON object: {"ok":true}.');
            expect(body.max_tokens).toBe(16384);
            expect(body.messages).toEqual([
              { role: "user", content: '{"message":"Connection test"}' },
            ]);
            expect(request.headers).toMatchObject({
              "x-api-key": "fixture-key",
              "anthropic-version": "2023-06-01",
            });
            expect(request.headers).not.toHaveProperty("Authorization");
          } else {
            expect(body).not.toHaveProperty("system");
            expect(body.messages).toEqual([
              { role: "system", content: 'Return exactly one JSON object: {"ok":true}.' },
              { role: "user", content: '{"message":"Connection test"}' },
            ]);
            expect(request.headers).toMatchObject({ Authorization: "Bearer fixture-key" });
            expect(request.headers).not.toHaveProperty("x-api-key");
          }
          reply(preset.protocol, { code: "SAFE-001" });
          expect(await ai.recognize("safe-documentary.mp4", "Safe documentary")).toEqual({
            code: "SAFE-001",
          });
          reply(preset.protocol, {
            title: "Safe translation",
            plot: "A fictional nature documentary.",
          });
          expect(await ai.translate({ title: "Safe title", plot: "Safe plot" })).toEqual({
            title: "Safe translation",
            plot: "A fictional nature documentary.",
          });
          expect(mock.request).toHaveBeenCalledTimes(3);
          for (const [sent] of mock.request.mock.calls) {
            expect(sent.url).toBe(request.url);
            expect(JSON.parse(sent.body!).model).toBe(model);
          }
        } finally {
          await ai.shutdown();
        }
      });
    }
  }

  it("preserves legacy single-provider and explicit custom endpoints", async () => {
    for (const saved of [
      {
        ...defaultAiSettings,
        enabled: true,
        endpoint: "https://safe.example.invalid/v1",
        model: "legacy-model",
      },
      settings({
        ...provider(MINIMAX_PRESETS[2]!, "custom-model"),
        endpoint: "https://safe.example.invalid/custom/v1/",
      }),
    ]) {
      const ai = service(saved);
      try {
        await ai.settings.save(saved);
        const current = ai.settings.getSnapshot().value;
        const selected = current.providers![0]!;
        reply(selected.protocol, { ok: true });
        await ai.test(current);
        const request = mock.request.mock.calls.at(-1)![0];
        expect(request.url).toBe(
          `${selected.endpoint}/${selected.protocol === "anthropic" ? "messages" : "chat/completions"}`,
        );
        expect(JSON.parse(request.body!).model).toBe(selected.model);
      } finally {
        await ai.shutdown();
      }
    }
  });

  it("rejects truncated Messages responses and stops on explicit refusal", async () => {
    const saved = settings(provider(MINIMAX_PRESETS[2]!));
    saved.providers!.push({ ...provider(MINIMAX_PRESETS[0]!), id: "second" });
    const ai = service(saved);
    try {
      reply("anthropic", { ok: true }, "max_tokens");
      await expect(ai.test(saved)).rejects.toThrow("truncated");
      mock.request.mockClear();
      reply("anthropic", { code: "SAFE-001" }, "refusal");
      await expect(ai.recognize("safe.mp4", "Safe documentary")).rejects.toThrow("refused");
      expect(mock.request).toHaveBeenCalledOnce();
    } finally {
      await ai.shutdown();
    }
  });
});
