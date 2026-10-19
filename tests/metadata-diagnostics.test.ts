import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { MetaTubeService } from "../frontend/src/services/metadata/MetaTubeService";
import type { MetaTubeHost } from "../frontend/src/services/metadata/MetaTubeService";
import { JsonHttpError } from "../frontend/src/services/metadata/shared";
import type { JsonHttp } from "../frontend/src/services/metadata/shared";
import {
  cleanMetadataDiagnostics,
  metadataMessages,
  metadataNetwork,
  MetadataQueryError,
  MetadataTrace,
} from "../frontend/src/services/metadata/diagnostics";
import type {
  MetadataCategory,
  MetadataNetwork,
} from "../frontend/src/services/metadata/diagnostics";
import { MetadataPipeline } from "../frontend/src/services/scraping/MetadataPipeline";
import { MovieMetadataResolver } from "../frontend/src/services/metadata/MovieMetadataResolver";
import { ScrapeService } from "../frontend/src/services/scraping/ScrapeService";
import type { ScrapePort } from "../frontend/src/services/scraping/ScrapeService";
import {
  FeedbackService,
  restoreFeedbackState,
} from "../frontend/src/services/feedback/FeedbackService";
import { LogService } from "../frontend/src/services/logging/LogService";
import { setLogSink } from "../frontend/src/services/logging/events";
import { setFailureSink } from "../frontend/src/services/feedback/events";
import { logExcerpt } from "../frontend/src/services/feedback/report";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  setLogSink();
  setFailureSink();
  vi.useRealTimers();
});
const diagnostic = (category: MetadataCategory, provider = "Fixture", extra = {}) => ({
  schema: 1,
  sources: [{ provider, category, elapsedMs: 25, ...extra }],
});
function fixture(reply: JsonHttp, configured: MetadataNetwork = "direct") {
  let network = configured;
  const host: MetaTubeHost = {
    bundled: async () => ({ path: "C:/safe/metatube.exe", version: "v1.4.0" }),
    start: async () => {
      const actual = network;
      let stop!: () => void;
      return {
        endpoint: "http://127.0.0.1:12000",
        token: "safe-fixture-token",
        network: actual,
        exited: new Promise<void>((resolve) => {
          stop = resolve;
        }),
        stop: async () => {
          stop();
        },
        isNetworkCurrent: async () => actual === network,
      };
    },
  };
  const service = new MetaTubeService(
    { read: async () => null, write: async () => {} },
    async (request, signal) => {
      if (request.url.endsWith("/providers")) return { data: { movie_providers: { Fixture: "" } } };
      if (request.url.endsWith("/db/version")) return { data: 1 };
      return reply(request, signal);
    },
    host,
    true,
  );
  cleanup.push(() => service.shutdown());
  return {
    service,
    changeNetwork: (value: MetadataNetwork) => {
      network = value;
    },
  };
}
function feedback() {
  const logs = new LogService();
  const service = new FeedbackService(logs, {
    read: async () => null,
    write: async () => {},
    system: async () => ({ JAVM: "fixture" }),
    copy: async () => {},
    open: async () => {},
  });
  setLogSink(logs.record);
  setFailureSink(service.capture);
  cleanup.push(() => service.dispose());
  return { logs, feedback: service };
}

describe("资料查询结构化诊断", () => {
  it.each(["denied", "tls", "parse", "incomplete", "timeout"] as const)(
    "404 保留 %s 的真实原因",
    async (category) => {
      const { service } = fixture(async () => {
        throw new JsonHttpError(
          404,
          "原始错误不展示",
          diagnostic(category, "Fixture", { missingFields: ["title"] }),
        );
      });
      const error = await service.search("SAFE-001").catch((value: unknown) => value);
      expect(error).toBeInstanceOf(MetadataQueryError);
      expect((error as MetadataQueryError).message).toBe(metadataMessages[category]);
      expect((error as MetadataQueryError).diagnostics).toMatchObject({
        networks: ["direct"],
        version: "v1.4.0",
        attempts: 1,
        detailed: true,
        sources: [{ provider: "Fixture", category, missingFields: ["title"] }],
      });
    },
  );

  it("无结果和不支持编号格式不冒充网络错误，旧组件明确缺少诊断", async () => {
    const { feedback: reports } = feedback();
    const fresh = fixture(async () => {
      throw new JsonHttpError(404, "", {
        schema: 1,
        sources: [
          ...diagnostic("skipped", "Skipped").sources,
          ...diagnostic("empty", "Empty", { results: 0 }).sources,
        ],
      });
    });
    const error = (await fresh.service
      .search("SAFE-001")
      .catch((value: unknown) => value)) as MetadataQueryError;
    expect(error.noResults).toBe(true);
    expect(error.message).toBe(metadataMessages.empty);
    expect(reports.getSnapshot().reports).toHaveLength(0);
    const old = fixture(async () => {
      throw new JsonHttpError(404, "原始404");
    });
    await expect(old.service.search("SAFE-001")).rejects.toThrow(metadataMessages.unavailable);
    expect(reports.getSnapshot().reports[0]!.metadata?.detailed).toBe(false);
  });

  it("相邻查询配置变化时，各自保存当时实际使用的代理", async () => {
    const { feedback: reports } = feedback();
    const { service, changeNetwork } = fixture(async () => {
      throw new JsonHttpError(404, "", diagnostic("incomplete"));
    });
    await service.search("SAFE-001").catch(() => {});
    changeNetwork("proxy/socks5");
    await service.search("SAFE-002").catch(() => {});
    const saved = reports.getSnapshot().reports;
    expect(saved).toHaveLength(2);
    expect(saved.map((item) => item.metadata!.networks)).toEqual([["proxy/socks5"], ["direct"]]);
    expect(new Set(saved.map((item) => item.metadata!.queryId)).size).toBe(2);
    expect(metadataNetwork("http://fake-user:fake-password@127.0.0.1:7890")).toBe("proxy/http");
    expect(JSON.stringify(saved)).not.toContain("fake-password");
  });

  it("在途查询不会借用后来保存的新代理配置", async () => {
    const { logs } = feedback();
    let resolve!: (value: unknown) => void;
    const { service, changeNetwork } = fixture(
      async () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = service.search("SAFE-001");
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    changeNetwork("proxy/http");
    resolve({ data: [], diagnostics: diagnostic("empty", "Fixture", { results: 0 }) });
    await expect(pending).resolves.toEqual([]);
    expect(
      logs.getRecentEntries().find((entry) => entry.event === "query_summary")?.context?.network,
    ).toBe("direct");
  });

  it("重试共用查询 ID，来源重复错误合并计数，日志只输出一次汇总", async () => {
    vi.useFakeTimers();
    const { logs } = feedback();
    const reply = vi.fn<JsonHttp>(async () => {
      throw new JsonHttpError(404, "", diagnostic("timeout"));
    });
    const { service } = fixture(reply, "proxy/http");
    const pipeline = new MetadataPipeline(
      new MovieMetadataResolver(service),
      { read: async () => ({ fusion: false, retries: 2 }), write: async () => {} },
      true,
    );
    const pending = pipeline
      .search("SAFE-001", new AbortController().signal, { taskId: "task-safe" })
      .catch((value: unknown) => value);
    await vi.runAllTimersAsync();
    const error = (await pending) as MetadataQueryError;
    expect(reply).toHaveBeenCalledTimes(3);
    expect(error.diagnostics).toMatchObject({
      attempts: 3,
      sources: [{ category: "timeout", count: 3, elapsedMs: 75 }],
    });
    const entries = logs.getRecentEntries();
    expect(entries.filter((entry) => entry.event === "query_summary")).toHaveLength(1);
    expect(entries.filter((entry) => entry.event === "source_result")).toHaveLength(1);
    expect(
      entries.every(
        (entry) =>
          entry.context?.taskId === "task-safe" &&
          entry.context.queryId === error.diagnostics!.queryId,
      ),
    ).toBe(true);
  });

  it("前台和后台查询交错完成仍各自保存来源诊断", async () => {
    const pending = new Map<string, (error: unknown) => void>();
    const { service } = fixture(
      async (request) =>
        new Promise((_resolve, reject) => {
          pending.set(new URL(request.url).searchParams.get("q")!, reject);
        }),
    );
    const foreground = service.search("SAFE-001").catch((error: unknown) => error);
    const background = service
      .search("SAFE-002", new AbortController().signal, { taskId: "background" })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(pending.size).toBe(2));
    pending.get("SAFE-002")!(new JsonHttpError(404, "", diagnostic("tls", "Second")));
    pending.get("SAFE-001")!(new JsonHttpError(404, "", diagnostic("incomplete", "First")));
    const a = (await foreground) as MetadataQueryError,
      b = (await background) as MetadataQueryError;
    expect(a.diagnostics!.sources.map((item) => item.provider)).toEqual(["First"]);
    expect(b.diagnostics!.sources.map((item) => item.provider)).toEqual(["Second"]);
    expect(a.diagnostics!.queryId).not.toBe(b.diagnostics!.queryId);
  });

  it("主动取消查询不生成故障报告", async () => {
    const { feedback: reports, logs } = feedback();
    let entered = false;
    const { service } = fixture(
      async (_request, signal) =>
        new Promise((_resolve, reject) => {
          entered = true;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const abort = new AbortController();
    const pending = service.search("SAFE-001", abort.signal).catch(() => {});
    await vi.waitFor(() => expect(entered).toBe(true));
    abort.abort();
    await pending;
    expect(reports.getSnapshot().reports).toHaveLength(0);
    expect(logs.getRecentEntries().at(-1)?.message).toContain("已取消");
  });

  it("请求截止时间到达按超时报告，不混同主动取消", async () => {
    const { feedback: reports } = feedback();
    let entered = false;
    const { service } = fixture(
      async (_request, signal) =>
        new Promise((_resolve, reject) => {
          entered = true;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const abort = new AbortController();
    const pending = service.search("SAFE-001", abort.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(entered).toBe(true));
    abort.abort(new DOMException("safe timeout", "TimeoutError"));
    const error = (await pending) as MetadataQueryError;
    expect(error.message).toBe(metadataMessages.timeout);
    expect(error.diagnostics?.outcome).toBe("failed");
    expect(reports.getSnapshot().reports).toHaveLength(1);
  });

  it("刮削失败报告保留结构化摘要，过滤其他任务，不被日志截断或重启丢失", async () => {
    const { logs, feedback: reports } = feedback();
    await reports.initialize();
    const { service } = fixture(async () => {
      throw new JsonHttpError(
        404,
        "",
        diagnostic("incomplete", "Fixture", { missingFields: ["title", "cover_url"] }),
      );
    }, "proxy/https");
    const pipeline = new MetadataPipeline(
      new MovieMetadataResolver(service),
      { read: async () => ({ fusion: false, retries: 2 }), write: async () => {} },
      true,
    );
    const port: ScrapePort = {
      load: async () => [],
      save: async () => {},
      remove: async () => {},
      prepare: async () => ({
        id: "video-safe",
        path: "C:/safe/SAFE-001.mp4",
        fileStamp: "safe",
        code: "SAFE-001",
        title: "安全样例",
        hasArtwork: true,
      }),
      artwork: async () => {
        throw new Error("不得请求图片");
      },
      commit: async () => ({}),
      refresh: async () => {},
    };
    const scrape = new ScrapeService(port, pipeline);
    cleanup.push(() => scrape.shutdown());
    logs.record({
      level: "info",
      module: "metatube",
      event: "source_result",
      message: "无关任务",
      context: { taskId: "other", queryId: "other-query" },
    });
    const id = await scrape.enqueue({ workId: "video-safe", name: "SAFE-001" });
    await vi.waitFor(() => expect(scrape.getSnapshot().tasks[0]?.status).toBe("failed"));
    const saved = reports.getSnapshot().reports[0]!;
    expect(saved).toMatchObject({
      taskId: id,
      count: 1,
      metadata: { networks: ["proxy/https"], version: "v1.4.0" },
    });
    expect(saved.before).not.toContain("无关任务");
    for (let i = 0; i < 420; i++)
      logs.record({ level: "info", module: "other", event: "noise", message: "模拟滚动日志" });
    expect(reports.preview(saved.id)).toContain("缺少字段=title,cover_url");
    const restored = restoreFeedbackState({
      schema: 1,
      session: {
        id: logs.getSession(),
        startedAt: new Date().toISOString(),
        clean: true,
        system: {},
      },
      reports: [saved],
    });
    expect(restored?.reports[0]?.metadata).toEqual(saved.metadata);
  });

  it("诊断只接收白名单字段，容量有界，no error 不推断为命中", () => {
    const trace = new MetadataTrace("search");
    trace.request("v1.4.0", "direct");
    trace.response(
      {
        schema: 1,
        sources: Array.from({ length: 80 }, (_, index) => ({
          provider: `Fixture${index}`,
          category: "empty",
          elapsedMs: 1,
          results: 0,
          title: "不得记录的安全标题",
          url: "https://example.invalid/?token=fake-secret",
          missingFields: ["title", "fake-secret", "cookie"],
        })),
      },
      "MetaTube",
      10,
      200,
    );
    const value = cleanMetadataDiagnostics(trace.snapshot("completed"))!;
    expect(value.sources).toHaveLength(64);
    expect(value.omitted).toBe(16);
    expect(value.sources[0]).toMatchObject({
      results: 0,
      category: "empty",
      missingFields: ["title"],
    });
    expect(JSON.stringify(value)).not.toMatch(/fake-secret|安全标题|example\.invalid|cookie/);
  });

  it("查询关联同时过滤前后日志和无法归因的旧组件日志", () => {
    const logs = new LogService();
    for (const [queryId, taskId, message] of [
      ["ours", "task", "保留"],
      ["other", "task", "其他查询"],
      ["foreign", "other-task", "其他任务"],
    ])
      logs.record({
        level: "info",
        module: "metatube",
        event: "source_result",
        message: message!,
        context: { queryId: queryId!, taskId: taskId! },
      });
    logs.record({
      level: "info",
      module: "metatube",
      event: "legacy_engine",
      message: "未关联旧日志",
    });
    const text = logExcerpt(logs.getRecentEntries(), "task", 14000, "ours");
    expect(text).toContain("保留");
    expect(text).not.toMatch(/其他查询|其他任务|未关联旧日志/);
  });

  it("重试切回原线路后，报告仍保存最后一次实际网络配置", () => {
    const trace = new MetadataTrace("search");
    trace.request("v1.4.0", "direct");
    trace.request("v1.4.0", "proxy/http");
    trace.request("v1.4.0", "direct");
    expect(trace.snapshot("failed")).toMatchObject({
      network: "direct",
      networks: ["direct", "proxy/http"],
      attempts: 3,
    });
  });
});
