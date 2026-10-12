import { describe, it, expect, vi } from "vite-plus/test";
import { ResourceSearchService } from "../frontend/src/services/streamResolution/ResourceSearchService";
import { ResolutionService } from "../frontend/src/services/streamResolution/ResolutionService";
import { ResolutionHttpSession } from "../frontend/src/services/streamResolution/http";
import { parsePlaylist } from "../frontend/src/services/streamResolution/parsers";
import { normalizeCode, sourceRequest } from "../frontend/src/services/streamResolution/sources";
import { ResolutionError } from "../frontend/src/services/streamResolution/shared";
import type {
  ResolutionWebviewPort,
  ResolutionParser,
  ParseTasks,
  ResolutionHttpPort,
} from "../frontend/src/services/streamResolution/ports";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";

const base = "https://safe.example.invalid";
const source = { id: "safe", name: "安全来源", template: `${base}/video/{code}` };
const parser: ResolutionParser = {
  async run<K extends keyof ParseTasks>(
    operation: K,
    input: ParseTasks[K]["input"],
  ): Promise<ParseTasks[K]["output"]> {
    if (operation !== "playlist") throw new Error("不应执行网页 HTTP 解析");
    return parsePlaylist(input.body, input.url) as ParseTasks[K]["output"];
  },
  close() {},
};
const http: ResolutionHttpPort = async (request) => ({
  status: 200,
  headers: {},
  body: request.url.endsWith(".m3u8")
    ? new TextEncoder().encode(
        "#EXTM3U\n#EXT-X-TARGETDURATION:1200\n#EXTINF:1200,\nsegment.bin\n#EXT-X-ENDLIST",
      ).buffer
    : new Uint8Array([0x47, 0, 1, 2]).buffer,
});
const wait = async (predicate: () => boolean) => {
  await vi.waitFor(() => expect(predicate()).toBe(true));
};
const candidate = (code: string) => [
  { url: `${base}/${code}.m3u8`, publicHeaders: { referer: `${base}/player` } },
];

describe("资源查找闭环（全部为安全 mock）", () => {
  it("使用番号来源模板，拒绝页面地址和路径穿越", () => {
    expect(sourceRequest(source, " demo-001 ").url).toBe(`${base}/video/demo-001`);
    expect(sourceRequest({ ...source, template: `${base}/{CODE}` }, "demo-001").url).toBe(
      `${base}/DEMO-001`,
    );
    expect(() => normalizeCode("../DEMO-001")).toThrow();
    expect(() => normalizeCode(`${base}/DEMO-001`)).toThrow();
    expect(normalizeCode("010126_001")).toBe("010126_001");
  });
  it("快速改查取消旧任务，旧结果不能覆盖当前查询或留下忙碌状态", async () => {
    let firstStarted = false;
    const webview: ResolutionWebviewPort = async (request, signal) => {
      if (request.url.endsWith("demo-001")) {
        firstStarted = true;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      return candidate(request.url.split("/").at(-1)!);
    };
    const resolution = new ResolutionService({ http, parser, webview });
    const search = new ResourceSearchService(
      resolution,
      { add: async () => 1, directory: () => "safe" },
      [source],
    );
    try {
      search.search("DEMO-001");
      await wait(() => firstStarted);
      search.search("DEMO-002");
      await wait(() => !search.getSnapshot().busy);
      expect(search.getSnapshot().rows[0]?.stream?.manifestUrl).toBe(`${base}/demo-002.m3u8`);
      expect(search.getSnapshot().code).toBe("DEMO-002");
    } finally {
      await search.shutdown();
      await resolution.shutdown();
    }
  });
  it("取消后立即重查同一番号会创建新任务，旧 WebView 及时退出", async () => {
    let started = 0,
      live = 0,
      maximum = 0;
    const webview: ResolutionWebviewPort = async (_request, signal) => {
      live++;
      maximum = Math.max(maximum, live);
      const first = ++started === 1;
      if (first)
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      live--;
      return candidate("demo-001");
    };
    const resolution = new ResolutionService({ http, parser, webview });
    try {
      const first = resolution.submit(sourceRequest(source, "DEMO-001"));
      await wait(() => started === 1);
      first.cancel();
      const second = resolution.submit(sourceRequest(source, "DEMO-001"));
      expect(second.id).not.toBe(first.id);
      expect(await first.result).toMatchObject({ ok: false, code: "cancelled" });
      expect(await second.result).toMatchObject({ ok: true });
      expect(started).toBe(2);
      expect(maximum).toBe(1);
      expect(live).toBe(0);
    } finally {
      await resolution.shutdown();
    }
  });
  it("清理失败不会验证候选或放行另一个 WebView，重试后恢复", async () => {
    const transport = vi.fn(http),
      cleanup = vi.fn(async () => {});
    const webview = vi
      .fn<ResolutionWebviewPort>()
      .mockRejectedValueOnce(new StopUnconfirmedError(cleanup))
      .mockResolvedValue(candidate("demo-002"));
    const resolution = new ResolutionService({ http: transport, parser, webview });
    try {
      const first = resolution.submit(sourceRequest(source, "DEMO-001"));
      expect(await first.result).toMatchObject({ code: "cleanup_failed" });
      const blocked = resolution.submit(sourceRequest(source, "DEMO-002"));
      expect(await blocked.result).toMatchObject({ code: "cleanup_failed" });
      expect(transport).not.toHaveBeenCalled();
      expect(webview).toHaveBeenCalledTimes(1);
      await resolution.retryCleanup();
      const second = resolution.submit(sourceRequest(source, "DEMO-002"));
      expect(await second.result).toMatchObject({ ok: true });
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      await resolution.shutdown();
    }
  });
  it("下载前重新检查链接，重复点击只交接一次；失败后允许重试", async () => {
    let invalid = false;
    const transport: ResolutionHttpPort = async (...args) => {
      if (invalid) throw new ResolutionError("not_found");
      return http(...args);
    };
    const add = vi.fn(async () => 1);
    const resolution = new ResolutionService({
      http: transport,
      parser,
      webview: async () => candidate("demo-001"),
    });
    const search = new ResourceSearchService(resolution, { add, directory: () => "safe" }, [
      source,
    ]);
    try {
      search.search("DEMO-001");
      await wait(() => !search.getSnapshot().busy);
      invalid = true;
      await expect(search.addDownload("safe")).rejects.toThrow();
      expect(add).not.toHaveBeenCalled();
      invalid = false;
      await Promise.all([search.addDownload("safe"), search.addDownload("safe")]);
      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "hls", headers: { referer: `${base}/player` } }),
      );
    } finally {
      await search.shutdown();
      await resolution.shutdown();
    }
  });
  it("公开请求上下文可用于跨域分片，敏感头仍只发往原 origin", async () => {
    const transport = vi.fn(http);
    const session = new ResolutionHttpSession(
      {
        url: `${base}/a.m3u8`,
        provider: "direct-hls",
        headers: { cookie: "fixture-only" },
        publicHeaders: { referer: `${base}/player` },
      },
      transport,
      "",
      Date.now() + 5000,
      new AbortController().signal,
      () => {},
    );
    await session.get("https://cdn.example.invalid/segment.bin", 100);
    expect(transport.mock.calls[0]![0].headers).toEqual({ referer: `${base}/player` });
  });
  it("隐藏浏览器使用代理时，HLS 检查沿用同一代理线路", async () => {
    const transport = vi.fn(http);
    const session = new ResolutionHttpSession(
      { url: `${base}/a.m3u8`, provider: "direct-hls", preferProxy: true },
      transport,
      "http://127.0.0.1:9876",
      Date.now() + 5000,
      new AbortController().signal,
      () => {},
    );
    await session.get(`${base}/a.m3u8`, 1024);
    expect(transport.mock.calls[0]![0].proxy).toBe("http://127.0.0.1:9876");
  });
});
