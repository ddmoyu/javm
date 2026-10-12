import { describe, expect, it, vi } from "vite-plus/test";
import {
  AiService,
  defaultAiSettings,
  parseAiObject,
  validateAiSettings,
} from "../frontend/src/services/metadata/AiService";
import {
  MetaTubeService,
  defaultMetaTubeSettings,
  movieDetails,
} from "../frontend/src/services/metadata/MetaTubeService";
import type {
  MetaTubeHost,
  ManagedMetaTube,
} from "../frontend/src/services/metadata/MetaTubeService";
import { Settings, serviceUrl } from "../frontend/src/services/metadata/shared";
import type { JsonHttp, JsonRequest, Store } from "../frontend/src/services/metadata/shared";

function store<T>(value: T | null = null): Store<T> {
  return {
    read: async () => structuredClone(value),
    write: async (next) => {
      value = structuredClone(next);
    },
  };
}
const reply = (value: unknown) => ({
  choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }],
});
const aiConfig = {
  ...defaultAiSettings,
  enabled: true,
  model: "fixture-model",
  apiKey: "fixture-key",
};
const health: JsonHttp = async (request) =>
  request.url.endsWith("providers")
    ? { data: { movie_providers: { Fixture: "https://example.invalid" } } }
    : { data: request.url.includes("movies/search") ? [] : 1 };
function managedProcess() {
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => {
    exit = resolve;
  });
  const stop = vi.fn(async () => exit());
  const process: ManagedMetaTube = {
    endpoint: "http://127.0.0.1:1234",
    token: "test-token",
    exited,
    stop,
  };
  return { process, stop, exit };
}
function host(): MetaTubeHost {
  return {
    bundled: async () => ({
      path: "C:/test/bin/tools/metatube/metatube-server.exe",
      version: "v1.4.0",
    }),
    start: async () => managedProcess().process,
  };
}
describe("资料服务配置", () => {
  it("保存后新实例可以读取，保存失败不更新生效值", async () => {
    const data = store<typeof aiConfig>();
    const settings = new Settings(data, aiConfig, validateAiSettings, true);
    await settings.save({ ...aiConfig, model: "new" });
    const next = new Settings(data, aiConfig, validateAiSettings, true);
    expect(await next.require()).toMatchObject({ model: "new" });
    data.write = async () => {
      throw new Error("disk full");
    };
    await expect(next.save({ ...aiConfig, model: "lost" })).rejects.toThrow("disk full");
    expect(next.getSnapshot().value.model).toBe("new");
  });
  it("坏配置不会静默使用默认值，显式保存后可以恢复", async () => {
    const settings = new Settings(
      { read: async () => "broken", write: async () => {} },
      aiConfig,
      validateAiSettings,
      true,
    );
    await expect(settings.require()).rejects.toThrow("无法读取");
    await settings.save(aiConfig);
    expect(await settings.require()).toEqual(validateAiSettings(aiConfig));
  });
  it("禁止浏览器写入以及 URL 凭据、错误协议、命令头注入", async () => {
    const settings = new Settings(store(), aiConfig, validateAiSettings, false);
    await expect(settings.save(aiConfig)).rejects.toThrow("桌面");
    for (const url of ["file:///a", "https://u:p@example.com", "https://example.com?key=x"])
      expect(() => serviceUrl(url)).toThrow();
    expect(() => validateAiSettings({ ...aiConfig, apiKey: "key\nInjected: value" })).toThrow();
    expect(() =>
      validateAiSettings({ ...aiConfig, endpoint: "https://example.com/v1/chat/completions" }),
    ).toThrow();
  });
});
describe("AI 识别与翻译", () => {
  it("连接测试真实调用模型，识别仅发送文件名和标题", async () => {
    const requests: JsonRequest[] = [];
    const ai = new AiService(
      store(aiConfig),
      async (request) => {
        requests.push(request);
        return requests.length === 1 ? reply({ ok: true }) : reply({ code: "test-001" });
      },
      true,
    );
    await ai.test(aiConfig);
    expect(await ai.recognize("TEST-001.mp4", "测试片")).toEqual({ code: "TEST-001" });
    expect(requests[1]).toMatchObject({
      url: "https://api.openai.com/v1/chat/completions",
      headers: { Authorization: "Bearer fixture-key" },
      body: { model: "fixture-model", stream: false },
    });
    const messages = (requests[1]!.body as { messages: { content: string }[] }).messages;
    expect(JSON.parse(messages[1]!.content)).toEqual({ filename: "TEST-001.mp4", title: "测试片" });
  });
  it("关闭 AI 后拒绝业务请求，仍允许显式连接测试", async () => {
    const http = vi.fn(async () => reply({ ok: true }));
    const ai = new AiService(store({ ...aiConfig, enabled: false }), http, true);
    await expect(ai.recognize("x", "x")).rejects.toThrow("启用");
    expect(http).not.toHaveBeenCalled();
    await ai.test(aiConfig);
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("JSON 围栏可解析，拒绝模型拒答、截断和非结构化文本", () => {
    expect(
      parseAiObject({ choices: [{ message: { content: '```json\n{"code":"TEST-1"}\n```' } }] }),
    ).toEqual({ code: "TEST-1" });
    for (const value of [
      { choices: [] },
      { choices: [{ finish_reason: "length", message: {} }] },
      { choices: [{ message: { refusal: "no" } }] },
      { choices: [{ message: { content: "answer" } }] },
    ])
      expect(() => parseAiObject(value)).toThrow();
  });
  it("不接受路径、空结果和臆造的简介", async () => {
    const ai = new AiService(
      store(aiConfig),
      async () => reply({ code: "C:/Video.mp4", title: "译文", plot: "invented" }),
      true,
    );
    await expect(ai.recognize("x", "x")).rejects.toThrow("格式");
    await expect(ai.translate({ title: "sample", plot: "" })).rejects.toThrow("无来源");
    const empty = new AiService(store(aiConfig), async () => reply({ code: "" }), true);
    await expect(empty.recognize("x", "x")).rejects.toThrow("未能可靠");
  });
  it("翻译保留原输入，不自动写入或替换字段", async () => {
    const input = { title: "Sample", plot: "A fictional film." };
    const ai = new AiService(
      store(aiConfig),
      async () => reply({ title: "示例", plot: "一部虚构影片。" }),
      true,
    );
    expect(await ai.translate(input)).toEqual({ title: "示例", plot: "一部虚构影片。" });
    expect(input).toEqual({ title: "Sample", plot: "A fictional film." });
  });
  it("限制并发，取消与退出后不交付过期结果", async () => {
    let finish!: (value: unknown) => void;
    const ai = new AiService(
      store(aiConfig),
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      true,
    );
    const request = ai.recognize("x", "x");
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await expect(ai.test(aiConfig)).rejects.toThrow("上一项");
    const stopped = ai.shutdown();
    finish(reply({ code: "TEST-001" }));
    await stopped;
    await rejected;
    await expect(ai.recognize("x", "x")).rejects.toThrow("退出");
    expect(ai.getSnapshot().busy).toBe(false);
  });
});
describe("MetaTube 按需启动与查询", () => {
  it("加载和保存设置不启动，旧外部地址、自启动和程序路径不再生效", async () => {
    const native = host();
    const start = vi.fn(native.start.bind(native));
    native.start = start;
    const requests: JsonRequest[] = [];
    const service = new MetaTubeService(
      store({
        mode: "remote",
        endpoint: "https://old.example.invalid",
        token: "old-secret",
        autoStart: true,
        binaryPath: "C:/old/metatube.exe",
        providers: ["Fixture"],
      }),
      async (request, signal) => {
        requests.push(request);
        return health(request, signal);
      },
      native,
      true,
    );
    await service.initialize();
    expect(await service.settings.require()).toEqual({ providers: ["Fixture"] });
    await service.save({ providers: ["Fixture"] });
    await expect(service.search(" ")).rejects.toThrow("请输入");
    expect(service.getSnapshot().status).toBe("stopped");
    expect(start).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    await service.search("TEST-001");
    expect(start).toHaveBeenCalledWith(
      "C:/test/bin/tools/metatube/metatube-server.exe",
      expect.any(AbortSignal),
    );
    expect(requests.every((request) => request.url.startsWith("http://127.0.0.1:1234/"))).toBe(
      true,
    );
    expect(
      requests.every((request) => request.headers?.Authorization === "Bearer test-token"),
    ).toBe(true);
    expect(service.getSnapshot()).toMatchObject({
      status: "ready",
      version: "v1.4.0",
      bundleChecked: true,
    });
    await service.shutdown();
  });
  it("浏览器预览不能启动内置服务", async () => {
    const native = host();
    const start = vi.fn(native.start.bind(native));
    native.start = start;
    const service = new MetaTubeService(store(), health, native, false);
    await expect(service.search("TEST")).rejects.toThrow("桌面");
    expect(start).not.toHaveBeenCalled();
    await service.shutdown();
  });
  it("缺失内置组件时明确报错，补全运行包后可直接重试", async () => {
    const native = host();
    const bundled = native.bundled.bind(native);
    native.bundled = async () => undefined;
    const start = vi.fn(native.start.bind(native));
    native.start = start;
    const service = new MetaTubeService(store(), health, native, true);
    await expect(service.search("TEST")).rejects.toThrow("内置 MetaTube 组件缺失");
    expect(start).not.toHaveBeenCalled();
    native.bundled = bundled;
    await service.search("TEST");
    expect(service.getSnapshot().status).toBe("ready");
    await service.shutdown();
  });
  it("首次查询等待旧进程回收，多次查询复用进程且保存来源不重启", async () => {
    const native = host();
    const managed = managedProcess();
    const start = vi.fn(async () => managed.process);
    native.start = start;
    let recovered!: () => void;
    const prepare = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          recovered = resolve;
        }),
    );
    const calls: string[] = [];
    const service = new MetaTubeService(
      store(),
      async (request, signal) => {
        calls.push(request.url);
        return health(request, signal);
      },
      native,
      true,
      prepare,
    );
    const pending = service.search("TEST");
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(start).not.toHaveBeenCalled();
    await expect(service.save(defaultMetaTubeSettings)).rejects.toThrow("正忙");
    recovered();
    await pending;
    expect(service.getSnapshot()).toMatchObject({ status: "ready", providers: ["Fixture"] });
    expect(calls[0]).toContain("/v1/db/version");
    await service.save({ providers: ["Other"] });
    await service.search("NEXT");
    expect(calls.at(-1)).toContain("provider=Other");
    expect(start).toHaveBeenCalledOnce();
    expect(managed.stop).not.toHaveBeenCalled();
    await service.shutdown();
    expect(managed.stop).toHaveBeenCalledOnce();
    expect(service.getSnapshot()).toMatchObject({ status: "stopped", error: "" });
    await expect(service.search("AFTER EXIT")).rejects.toThrow("退出");
  });
  it("鉴权失败不能把公共健康检查成功当作连接成功", async () => {
    vi.useFakeTimers();
    const native = host();
    const managed = managedProcess();
    native.start = async () => managed.process;
    const calls: string[] = [];
    const service = new MetaTubeService(
      store(),
      async (request) => {
        calls.push(request.url);
        throw new Error("401");
      },
      native,
      true,
    );
    try {
      const rejected = expect(service.search("TEST")).rejects.toThrow("401");
      await vi.advanceTimersByTimeAsync(16000);
      await rejected;
      expect(service.getSnapshot().status).toBe("failed");
      expect(calls.every((url) => url.endsWith("/v1/db/version"))).toBe(true);
      expect(managed.stop).toHaveBeenCalledOnce();
    } finally {
      await service.shutdown();
      vi.useRealTimers();
    }
  });
  it("进程意外退出后只在下次查询时重新启动", async () => {
    const first = managedProcess(),
      second = managedProcess();
    const native = host();
    const start = vi
      .fn()
      .mockResolvedValueOnce(first.process)
      .mockResolvedValueOnce(second.process);
    native.start = start;
    const service = new MetaTubeService(store(defaultMetaTubeSettings), health, native, true);
    await service.search("TEST");
    first.exit();
    await vi.waitFor(() => expect(service.getSnapshot().status).toBe("failed"));
    expect(start).toHaveBeenCalledOnce();
    await service.search("TEST");
    expect(start).toHaveBeenCalledTimes(2);
    expect(service.getSnapshot().status).toBe("ready");
    await service.shutdown();
    expect(second.stop).toHaveBeenCalledOnce();
  });
  it("查询转义关键词及来源，详情先经过字段与长度校验", async () => {
    const requests: JsonRequest[] = [];
    const http: JsonHttp = async (request, signal) => {
      requests.push(request);
      if (request.url.includes("movies/search"))
        return { data: [{ provider: "Fixture", id: "id/1", number: "TEST-1", title: "合成片" }] };
      if (request.url.includes("movies/Fixture"))
        return {
          data: {
            provider: "Fixture",
            id: "id/1",
            title: "合成片",
            number: "TEST-1",
            actors: ["虚构甲"],
            runtime: 90,
            summary: "合成简介",
          },
        };
      return health(request, signal);
    };
    const service = new MetaTubeService(store({ providers: ["Fixture"] }), http, host(), true);
    const candidates = await service.search("TEST-1 & 其他");
    const details = await service.details(candidates[0]!);
    expect(requests[2]!.url).toContain("q=TEST-1+%26");
    expect(requests[2]!.url).toContain("provider=Fixture");
    expect(requests[3]!.url).toContain("id%2F1");
    expect(details.fields).toMatchObject({ title: "合成片", duration: 90, actors: ["虚构甲"] });
    expect(() => movieDetails({ title: "x".repeat(3000) })).toThrow();
    await service.shutdown();
  });
  it("取消查询后不返回候选且仍可继续使用连接", async () => {
    let querying = false;
    const http: JsonHttp = async (request, signal) =>
      request.url.includes("search")
        ? new Promise((_, reject) => {
            querying = true;
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("cancelled", "AbortError")),
              { once: true },
            );
          })
        : health(request, signal);
    const native = host();
    const managed = managedProcess();
    native.start = async () => managed.process;
    const service = new MetaTubeService(store(), http, native, true);
    const pending = service.search("TEST");
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(querying).toBe(true));
    await expect(service.search("again")).rejects.toThrow("正忙");
    service.cancel();
    await rejected;
    expect(service.getSnapshot()).toMatchObject({ querying: false, status: "ready" });
    expect(managed.stop).not.toHaveBeenCalled();
    await service.shutdown();
    expect(managed.stop).toHaveBeenCalledOnce();
  });
  it("取消首次查询后启动继续完成，新查询等待同一次启动", async () => {
    const native = host();
    const managed = managedProcess();
    let started!: (value: ManagedMetaTube) => void;
    const start = vi.fn(
      () =>
        new Promise<ManagedMetaTube>((resolve) => {
          started = resolve;
        }),
    );
    native.start = start;
    const service = new MetaTubeService(store(), health, native, true);
    const rejected = expect(service.search("FIRST")).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(started).toBeTypeOf("function"));
    service.cancel();
    await rejected;
    expect(service.getSnapshot()).toMatchObject({ querying: false, status: "starting" });
    const next = service.search("NEXT");
    started(managed.process);
    await next;
    expect(start).toHaveBeenCalledOnce();
    expect(managed.stop).not.toHaveBeenCalled();
    expect(service.getSnapshot().status).toBe("ready");
    await service.shutdown();
  });
  it("资料来源失败不会关闭已启动服务", async () => {
    const managed = managedProcess();
    const native = host();
    native.start = vi.fn(async () => managed.process);
    const service = new MetaTubeService(
      store(),
      async (request, signal) =>
        request.url.includes("movies/") ? { error: "fixture failure" } : health(request, signal),
      native,
      true,
    );
    await expect(service.search("TEST")).rejects.toThrow("来源请求失败");
    expect(service.getSnapshot().status).toBe("ready");
    expect(managed.stop).not.toHaveBeenCalled();
    await service.shutdown();
  });
  it("退出应用会取消正在启动的服务并等待进程回收", async () => {
    const native = host();
    const managed = managedProcess();
    let started!: (value: ManagedMetaTube) => void;
    let signal!: AbortSignal;
    native.start = async (_, startupSignal) => {
      signal = startupSignal;
      return new Promise<ManagedMetaTube>((resolve) => {
        started = resolve;
      });
    };
    const service = new MetaTubeService(store(), health, native, true);
    const rejected = expect(service.search("TEST")).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(started).toBeTypeOf("function"));
    const shutdown = service.shutdown();
    expect(signal.aborted).toBe(true);
    started(managed.process);
    await shutdown;
    await rejected;
    expect(managed.stop).toHaveBeenCalledOnce();
    expect(service.getSnapshot()).toMatchObject({
      status: "stopped",
      busy: false,
      querying: false,
    });
  });
});
