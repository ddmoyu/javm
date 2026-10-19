import { describe, expect, it, vi } from "vite-plus/test";
import {
  AiService,
  defaultAiSettings,
  validateAiSettings,
} from "../frontend/src/services/metadata/AiService";
import type { AiSettings } from "../frontend/src/services/metadata/AiService";
import type { JsonHttp } from "../frontend/src/services/metadata/shared";
import { ScrapeService } from "../frontend/src/services/scraping/ScrapeService";
import type { ScrapePort } from "../frontend/src/services/scraping/ScrapeService";

const settings: AiSettings = {
  ...defaultAiSettings,
  enabled: true,
  automaticRecognition: true,
  providers: ["first", "second"].map((id) => ({
    id,
    name: id,
    enabled: true,
    endpoint: `https://${id}.example.invalid/v1`,
    model: "safe-model",
    apiKey: `${id}-fixture-key`,
  })),
};
const reply = (code: string) => ({ choices: [{ message: { content: JSON.stringify({ code }) } }] });
const service = (http: JsonHttp, value = settings) =>
  new AiService({ read: async () => value, write: async () => {} }, http, true);

describe("多 AI 供应商（安全 mock）", () => {
  it("兼容单供应商设置，自动识别默认关闭", async () => {
    const old = validateAiSettings({ ...defaultAiSettings, model: "safe-model" });
    expect(old.providers?.[0]?.enabled).toBe(true);
    expect(old.automaticRecognition).toBe(false);
    const http = vi.fn<JsonHttp>();
    const ai = service(http, old);
    try {
      expect(
        await ai.recognizeForScrape("虚构纪录片.mp4", "虚构纪录片", new AbortController().signal),
      ).toBeUndefined();
      expect(http).not.toHaveBeenCalled();
    } finally {
      await ai.shutdown();
    }
  });
  it("按优先级轮换并隔离各供应商密钥，空结果也继续兜底", async () => {
    const http = vi
      .fn<JsonHttp>()
      .mockResolvedValueOnce(reply(""))
      .mockResolvedValueOnce(reply("SAFE-001"));
    const ai = service(http);
    try {
      expect(await ai.recognize("虚构纪录片.mp4", "虚构纪录片")).toEqual({ code: "SAFE-001" });
      expect(http.mock.calls.map(([request]) => request.headers?.Authorization)).toEqual([
        "Bearer first-fixture-key",
        "Bearer second-fixture-key",
      ]);
      expect(http.mock.calls.map(([request]) => new URL(request.url).hostname)).toEqual([
        "first.example.invalid",
        "second.example.invalid",
      ]);
    } finally {
      await ai.shutdown();
    }
  });
  it("外部取消不会轮换或返回迟到结果", async () => {
    let finish: (value: unknown) => void = () => {};
    const http = vi.fn<JsonHttp>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const ai = service(http),
      abort = new AbortController();
    try {
      const pending = ai.recognize("虚构纪录片.mp4", "虚构纪录片", abort.signal);
      const rejected = expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(1));
      abort.abort();
      finish(reply("SAFE-001"));
      await rejected;
      expect(http).toHaveBeenCalledTimes(1);
    } finally {
      await ai.shutdown();
    }
  });
  it("模型明确拒绝时不向其他供应商重复发送", async () => {
    const http = vi
      .fn<JsonHttp>()
      .mockResolvedValue({ choices: [{ message: { refusal: "safe mock refusal" } }] });
    const ai = service(http);
    try {
      await expect(ai.recognize("虚构纪录片", "虚构纪录片")).rejects.toThrow("拒绝");
      expect(http).toHaveBeenCalledTimes(1);
    } finally {
      await ai.shutdown();
    }
  });
  it("自动识别只生成候选查询，来源番号不同则不保存", async () => {
    const ai = service(async () => reply("SAFE-001"));
    const candidate = { provider: "mock", id: "safe", code: "SAFE-002", title: "虚构纪录片" };
    const port: ScrapePort = {
      load: async () => [],
      save: async () => {},
      remove: async () => {},
      prepare: async () => ({
        id: "work",
        path: "C:/safe/fiction.mp4",
        fileStamp: "safe",
        code: "",
        title: "虚构纪录片",
        hasArtwork: true,
      }),
      artwork: async () => {
        throw new Error("本用例不应处理图片");
      },
      commit: vi.fn(async () => ({})),
      refresh: async () => {},
    };
    const search = vi.fn(async () => [candidate]);
    const scraping = new ScrapeService(
      port,
      {
        search,
        details: async () => ({
          ...candidate,
          homepage: "https://safe.example.invalid",
          fields: { code: candidate.code, title: candidate.title },
        }),
      },
      true,
      ai.recognizeForScrape,
    );
    try {
      await scraping.enqueue({ workId: "work", name: "虚构纪录片" });
      await vi.waitFor(() => expect(scraping.getSnapshot().tasks[0]?.status).toBe("needsInput"));
      expect(search).toHaveBeenCalledWith("SAFE-001", expect.any(AbortSignal), {
        taskId: scraping.getSnapshot().tasks[0]!.id,
      });
      expect(port.commit).not.toHaveBeenCalled();
      expect(scraping.getSnapshot().tasks[0]?.query).toBe("SAFE-001");
    } finally {
      await scraping.shutdown();
      await ai.shutdown();
    }
  });
});
