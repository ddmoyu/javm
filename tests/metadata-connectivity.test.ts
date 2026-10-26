import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MetadataConnectivity,
  metadataNetworkNotice,
  metadataQueueNotice,
} from "../frontend/src/services/metadata/MetadataConnectivity";
import type { MetadataConnectivityStatus } from "../frontend/src/services/metadata/MetadataConnectivity";
import { MetaTubeService } from "../frontend/src/services/metadata/MetaTubeService";
import type { MetaTubeHost } from "../frontend/src/services/metadata/MetaTubeService";
import { JsonHttpError } from "../frontend/src/services/metadata/shared";
import {
  MetadataQueryError,
  metadataMessages,
} from "../frontend/src/services/metadata/diagnostics";
import type {
  MetadataCategory,
  MetadataNetwork,
} from "../frontend/src/services/metadata/diagnostics";
import { MetadataPipeline } from "../frontend/src/services/scraping/MetadataPipeline";
import { ScrapeService } from "../frontend/src/services/scraping/ScrapeService";
import type { ScrapePort } from "../frontend/src/services/scraping/ScrapeService";
import { searchMovieMetadata } from "../frontend/src/services/metadata/movieSearch";
import { setFailureSink } from "../frontend/src/services/feedback/events";
import { setLogSink } from "../frontend/src/services/logging/events";
import { failureFromLog } from "../frontend/src/services/feedback/report";
import type { LogEntry } from "../frontend/src/services/logging/events";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";
import { createMetadataConnectivity } from "../frontend/src/platform/neutralino/metadataConnectivity";
import { requestHttp } from "../frontend/src/platform/neutralino/http";
import type { HttpResponse } from "../frontend/src/services/network/HttpService";

vi.mock("../frontend/src/platform/neutralino/http", () => ({ requestHttp: vi.fn() }));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  setFailureSink();
  setLogSink();
  vi.clearAllMocks();
});
const signal = () => new AbortController().signal;
const response = (patch: Partial<HttpResponse> = {}): HttpResponse => ({
  status: 204,
  exitCode: 0,
  bytes: 0,
  headers: {},
  setCookie: false,
  ambiguousHeaders: false,
  effectiveUrl: "https://www.gstatic.com/generate_204",
  connections: 1,
  elapsedMs: 5,
  tunnelStatus: 0,
  ...patch,
});
const rows = (category: MetadataCategory, provider = "Fixture") => [
  { provider, category, elapsedMs: 20, count: 1 },
];
const candidate = { provider: "Fixture", id: "safe001", code: "SAFE-001", title: "安全合成样例" };
function fixture(
  options: {
    category?: MetadataCategory;
    provider?: string;
    probe?: () => Promise<MetadataConnectivityStatus>;
    network?: MetadataNetwork;
    configuredProviders?: string[];
  } = {},
) {
  const reports = vi.fn(() => undefined);
  setFailureSink(reports);
  const probe = vi.fn(options.probe ?? (async () => "unreachable" as const));
  const connectivity = new MetadataConnectivity(probe);
  let recovered = false;
  const searches = vi.fn();
  const host: MetaTubeHost = {
    bundled: async () => ({ path: "C:/safe/metatube.exe", version: "v1.4.0" }),
    start: async () => {
      let stop!: () => void;
      return {
        endpoint: "http://127.0.0.1:12001",
        token: "safe-fixture",
        connectivity,
        network: options.network ?? "direct",
        exited: new Promise<void>((resolve) => {
          stop = resolve;
        }),
        stop: async () => {
          await connectivity.dispose();
          stop();
        },
      };
    },
  };
  const service = new MetaTubeService(
    { read: async () => ({ providers: options.configuredProviders ?? [] }), write: async () => {} },
    async (request) => {
      if (request.url.endsWith("/providers")) return { data: { movie_providers: { Fixture: "" } } };
      if (request.url.endsWith("/db/version")) return { data: 1 };
      searches(request.url);
      if (recovered) return { data: [{ ...candidate, number: candidate.code }] };
      throw new JsonHttpError(404, "合成来源错误", {
        schema: 1,
        sources: rows(options.category ?? "timeout", options.provider),
      });
    },
    host,
    true,
  );
  cleanup.push(() => service.shutdown());
  return {
    service,
    probe,
    reports,
    searches,
    recover: () => {
      recovered = true;
    },
  };
}

describe("资料网络连通性检测", () => {
  it("并发调用合并，取消一方不影响另一方，缓存到期后重新检测", async () => {
    let now = 0;
    let resolve!: (value: MetadataConnectivityStatus) => void;
    let probeSignal!: AbortSignal;
    const probe = vi.fn((active: AbortSignal) => {
      probeSignal = active;
      return new Promise<MetadataConnectivityStatus>((done) => {
        resolve = done;
      });
    });
    const connectivity = new MetadataConnectivity(probe, () => now);
    cleanup.push(() => connectivity.dispose());
    const abort = new AbortController();
    const first = connectivity.check(abort.signal).catch((error: unknown) => error);
    const second = connectivity.check(signal());
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    abort.abort();
    expect(await first).toBeInstanceOf(DOMException);
    expect(probeSignal.aborted).toBe(false);
    resolve("unreachable");
    expect(await second).toBe("unreachable");
    expect(await connectivity.check(signal())).toBe("unreachable");
    expect(probe).toHaveBeenCalledTimes(1);
    now = 30_001;
    const third = connectivity.check(signal());
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    resolve("reachable");
    expect(await third).toBe("reachable");
  });

  it("全部调用者取消后停止检测，不缓存取消结果，后续调用能重新开始", async () => {
    let stopped = 0;
    const probe = vi.fn(
      (active: AbortSignal) =>
        new Promise<MetadataConnectivityStatus>((_, reject) => {
          active.addEventListener(
            "abort",
            () => {
              stopped++;
              reject(active.reason);
            },
            { once: true },
          );
        }),
    );
    const connectivity = new MetadataConnectivity(probe);
    cleanup.push(() => connectivity.dispose());
    const abort = new AbortController();
    const pending = connectivity.check(abort.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    abort.abort();
    await pending;
    expect(stopped).toBe(1);
    probe.mockResolvedValueOnce("reachable");
    expect(await connectivity.check(signal())).toBe("reachable");
    expect(probe).toHaveBeenCalledTimes(2);
    await connectivity.dispose();
    await expect(connectivity.check(signal())).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each(["", "http://fake-user:fake-password@127.0.0.1:7890"])(
    "使用启动时配置 %s 请求两个 HTTPS 检测地址，任一成功即可判为可达",
    async (proxy) => {
      vi.mocked(requestHttp)
        .mockResolvedValueOnce(response({ status: 0, exitCode: 28 }))
        .mockResolvedValueOnce(response());
      const connectivity = createMetadataConnectivity(proxy);
      cleanup.push(() => connectivity.dispose());
      expect(await connectivity.check(signal())).toBe("reachable");
      expect(requestHttp).toHaveBeenCalledTimes(2);
      for (const [request] of vi.mocked(requestHttp).mock.calls) {
        expect(request).toMatchObject({
          proxy,
          timeoutMs: 4000,
          connectTimeoutMs: 2500,
          maxRedirects: 0,
          cacheTtlMs: 0,
        });
        expect(request.url).toMatch(/^https:\/\/www\.(gstatic|google)\.com\/generate_204$/);
      }
    },
  );

  it("只有两个检测均为连接故障才判不可达，HTTP 异常和本地设施错误保留未知", async () => {
    for (const [first, second, expected] of [
      [response({ exitCode: 28 }), response({ exitCode: 6 }), "unreachable"],
      [response({ exitCode: 28 }), response({ status: 200, bytes: 100 }), "unknown"],
      [response({ status: 302 }), response({ status: 403 }), "unknown"],
    ] as const) {
      vi.mocked(requestHttp).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
      const connectivity = createMetadataConnectivity("");
      expect(await connectivity.check(signal())).toBe(expected);
      await connectivity.dispose();
    }
    vi.mocked(requestHttp)
      .mockRejectedValueOnce(new Error("本地模块不可用"))
      .mockResolvedValueOnce(response({ exitCode: 28 }));
    const connectivity = createMetadataConnectivity("");
    expect(await connectivity.check(signal())).toBe("unknown");
    await connectivity.dispose();
  });

  it("检测请求停止未确认仍作为本地故障透传", async () => {
    const error = new StopUnconfirmedError(async () => {});
    vi.mocked(requestHttp).mockRejectedValueOnce(error).mockResolvedValueOnce(response());
    const connectivity = createMetadataConnectivity("");
    cleanup.push(() => connectivity.dispose());
    await expect(connectivity.check(signal())).rejects.toBe(error);
  });
});

describe("资料网络故障降为普通提示", () => {
  it.each(["direct", "proxy/http"] as const)(
    "%s 模式均按实际连通性判定，保留诊断且不生成报告",
    async (network) => {
      const { service, reports, probe } = fixture({ network });
      const error = await service.search("SAFE-001").catch((reason: unknown) => reason);
      expect(error).toMatchObject({
        networkUnavailable: true,
        retryable: false,
        noResults: false,
        message: metadataNetworkNotice,
      });
      expect((error as MetadataQueryError).diagnostics).toMatchObject({
        network,
        sources: [{ provider: "Fixture", category: "timeout" }],
      });
      expect(service.getSnapshot().error).toBe("");
      expect(reports).not.toHaveBeenCalled();
      const found = await searchMovieMetadata(
        { search: (query) => service.search(query) },
        "SAFE-001",
        signal(),
        false,
      );
      expect(found).toMatchObject({ candidates: [], error: "", notice: metadataNetworkNotice });
      expect(probe).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["reachable", "unknown"] as const)("检测为 %s 时保留来源故障及报告", async (status) => {
    const { service, reports } = fixture({ probe: async () => status });
    const error = await service.search("SAFE-001").catch((reason: unknown) => reason);
    expect(error).toMatchObject({ networkUnavailable: false, message: metadataMessages.timeout });
    expect(reports).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["parse", "Fixture"],
    ["denied", "Fixture"],
    ["service", "MetaTube"],
    ["timeout", "MetaTube"],
  ] as const)("%s/%s 不触发网络检测，也不隐藏真实故障", async (category, provider) => {
    const { service, reports, probe } = fixture({ category, provider });
    const error = await service.search("SAFE-001").catch((reason: unknown) => reason);
    expect(error).toMatchObject({ networkUnavailable: false });
    expect(probe).not.toHaveBeenCalled();
    expect(reports).toHaveBeenCalledTimes(1);
  });

  it("纯空结果作为普通提示，不触发检测和故障报告", async () => {
    const { service, reports, probe } = fixture({ category: "empty" });
    const found = await searchMovieMetadata(
      { search: (query) => service.search(query) },
      "SAFE-001",
      signal(),
      false,
    );
    expect(found).toMatchObject({ error: "", notice: metadataMessages.empty });
    expect(probe).not.toHaveBeenCalled();
    expect(reports).not.toHaveBeenCalled();
  });

  it("先完成已选来源查询，再检测；确认不可达后不继续自动重试", async () => {
    const { service, reports, searches, probe } = fixture({
      configuredProviders: ["First", "Second"],
    });
    const pipeline = new MetadataPipeline(
      service,
      { read: async () => ({ fusion: false, retries: 2 }), write: async () => {} },
      true,
    );
    await expect(pipeline.search("SAFE-001", signal())).rejects.toMatchObject({
      networkUnavailable: true,
    });
    expect(searches).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(reports).not.toHaveBeenCalled();
  });

  it("用户在检测时取消查询，不生成报告且停止检测", async () => {
    let resolve!: (status: MetadataConnectivityStatus) => void;
    const { service, reports, probe } = fixture({
      probe: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const abort = new AbortController();
    const pending = service.search("SAFE-001", abort.signal).catch((reason: unknown) => reason);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    abort.abort();
    expect(await pending).toMatchObject({ name: "AbortError" });
    resolve("unreachable");
    expect(reports).not.toHaveBeenCalled();
  });

  it("网络不可达时暂停批量队列并保留任务，恢复后继续且不提前拦截查询", async () => {
    const { service, reports, searches, recover } = fixture();
    const logs: LogEntry[] = [];
    setLogSink((entry) => {
      logs.push({
        ...entry,
        session: "safe-session",
        sequence: logs.length + 1,
        time: new Date().toISOString(),
      });
    });
    const pipeline = new MetadataPipeline(
      service,
      { read: async () => ({ fusion: false, retries: 2 }), write: async () => {} },
      true,
    );
    const commit = vi.fn(async () => ({}));
    const port: ScrapePort = {
      load: async () => [],
      save: async () => {},
      remove: async () => {},
      prepare: async (task) => ({
        id: task.workId!,
        path: "",
        fileStamp: "safe",
        code: candidate.code,
        title: candidate.title,
        hasArtwork: true,
      }),
      artwork: async () => ({ path: "", dispose: async () => {} }),
      commit,
      refresh: async () => {},
    };
    const scraping = new ScrapeService(port, {
      search: (query, active, options) => pipeline.search(query, active, options),
      details: async () => ({
        provider: candidate.provider,
        id: candidate.id,
        homepage: "https://example.invalid/safe",
        fields: { code: candidate.code, title: candidate.title },
      }),
    });
    cleanup.push(() => scraping.shutdown());
    await scraping.enqueue({ workId: "safe-1", name: candidate.title });
    await scraping.enqueue({ workId: "safe-2", name: candidate.title });
    await vi.waitFor(() => expect(scraping.getSnapshot().networkNotice).toBe(metadataQueueNotice));
    expect(scraping.getSnapshot()).toMatchObject({ paused: true, error: "" });
    expect(scraping.getSnapshot().tasks.map((task) => task.status)).toEqual(["queued", "queued"]);
    expect(searches).toHaveBeenCalledTimes(1);
    expect(reports).not.toHaveBeenCalled();
    expect(logs.map(failureFromLog).filter(Boolean)).toEqual([]);
    recover();
    scraping.pauseQueue(false);
    await vi.waitFor(() =>
      expect(
        scraping.getSnapshot().tasks.map((task) => ({ status: task.status, error: task.error })),
      ).toEqual([
        { status: "completed", error: "" },
        { status: "completed", error: "" },
      ]),
    );
    expect(scraping.getSnapshot().networkNotice).toBe("");
    expect(commit).toHaveBeenCalledTimes(2);
    expect(reports).not.toHaveBeenCalled();
  });
});
