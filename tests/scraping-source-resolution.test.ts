/* oxlint-disable typescript/unbound-method -- 测试端口均不依赖 this。 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ScrapeService } from "../frontend/src/services/scraping/ScrapeService";
import type { ScrapePort, ScrapeProvider } from "../frontend/src/services/scraping/ScrapeService";
import type { ScrapeTask } from "../frontend/src/contracts/scraping";
import type { MovieDetails } from "../frontend/src/services/metadata/MetaTubeService";
import { MetadataPipeline } from "../frontend/src/services/scraping/MetadataPipeline";
import { MovieMetadataResolver } from "../frontend/src/services/metadata/MovieMetadataResolver";
import {
  MovieDetailsCache,
  movieCandidate,
} from "../frontend/src/services/metadata/MovieDetailsCache";
import { searchMovieMetadata } from "../frontend/src/services/metadata/movieSearch";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";
import { OnlineWorksService } from "../frontend/src/services/catalog/OnlineWorksService";
import { JavbusMovieLookup } from "../frontend/src/services/catalog/JavbusMovieLookup";
import { parseJavbusWorkDetails } from "../frontend/src/services/catalog/javbusWorks";
import type {
  CatalogProcessor,
  CatalogRequest,
} from "../frontend/src/services/catalog/workerClient";

const code = "SAFE-901";
const details: MovieDetails = {
  provider: "JavBus",
  id: code,
  fields: {
    code,
    title: "虚构自然纪录片",
    actors: ["虚构讲解员"],
    genres: ["自然"],
    premiered: "2026-01-01",
  },
  homepage: `https://www.javbus.com/${code}`,
  coverUrl: "https://images.example.invalid/safe-cover.jpg",
  previewImages: ["https://images.example.invalid/safe-landscape.jpg"],
};
const primaryDetails = { ...details, provider: "Fixture", id: "original" };
const html = (value = code) => `<h3>${value} 虚构自然纪录片</h3>
<a class="bigImage" href="https://images.example.invalid/safe-cover.jpg"><img src="https://images.example.invalid/safe-cover.jpg"></a>
<div class="info"><p>識別碼: ${value}</p><p>發行日期: 2026-01-01</p><p>長度: 80分鐘</p></div>
<a class="sample-box" href="https://images.example.invalid/safe-landscape.jpg">安全风景占位</a>`;
const processor: CatalogProcessor = {
  run: (async (operation: CatalogRequest["operation"], payload: CatalogRequest["payload"]) => {
    const task = { operation, payload } as CatalogRequest;
    if (task.operation !== "javbusDetails") throw new Error("只允许安全详情解析");
    return parseJavbusWorkDetails(task.payload.html, task.payload.work);
  }) as CatalogProcessor["run"],
  close() {},
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function fixture() {
  const cache = new MovieDetailsCache();
  const primary: ScrapeProvider = {
    search: vi.fn(async () => [movieCandidate(primaryDetails)]),
    details: vi.fn(async () => primaryDetails),
  };
  const lookup = { available: true, read: vi.fn(async () => details) };
  const resolver = new MovieMetadataResolver(primary, cache, lookup);
  const pipeline = new MetadataPipeline(
    resolver,
    { read: async () => ({ fusion: false, retries: 0 }), write: async () => {} },
    true,
  );
  const records = new Map<string, ScrapeTask>();
  const port: ScrapePort = {
    load: async (offset) => [...records.values()].slice(offset, offset + 100),
    save: async (task, expected) => {
      expect(records.get(task.id)?.revision ?? 0).toBe(expected);
      records.set(task.id, structuredClone(task));
    },
    remove: async (task) => {
      records.delete(task.id);
    },
    prepare: vi.fn(async () => ({
      id: "work-safe",
      path: "",
      fileStamp: "",
      code,
      title: code,
      hasArtwork: false,
    })),
    artwork: vi.fn(async () => ({
      path: "C:/SafeFixture/safe-cover.jpg",
      dispose: async () => {},
    })),
    commit: vi.fn(async () => ({})),
    refresh: async () => {},
  };
  const service = new ScrapeService(port, pipeline);
  cleanups.push(() => service.shutdown());
  return { cache, primary, lookup, resolver, pipeline, records, port, service };
}
async function finished(service: ScrapeService, status = "completed") {
  await vi.waitFor(() => expect(service.getSnapshot().tasks[0]?.status).toBe(status), {
    interval: 5,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("发现、搜索与刮削资料来源衔接", () => {
  it("发现读取的完整详情直接用于后台刮削，资料服务离线也不再搜索或读取详情", async () => {
    const { cache, primary, lookup, port, service } = fixture();
    const fetch = vi.fn(async () => html());
    const works = new OnlineWorksService(
      processor,
      fetch,
      async () => {},
      undefined,
      (value) => cache.remember(value),
    );
    cleanups.push(() => works.shutdown());
    const seen = await works.readDetails(
      { code, title: code, url: details.homepage },
      new AbortController().signal,
    );
    vi.mocked(primary.search).mockRejectedValue(new Error("安全模拟离线"));
    await service.enqueue({ workId: "work-safe", name: seen.fields.title! });
    await finished(service);
    expect(primary.search).not.toHaveBeenCalled();
    expect(primary.details).not.toHaveBeenCalled();
    expect(lookup.read).not.toHaveBeenCalled();
    expect(port.commit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      seen,
      "C:/SafeFixture/safe-cover.jpg",
    );
    expect(seen.previewImages).toEqual(details.previewImages);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["offline", "empty", "wrong-code"])(
    "资料服务 %s 时按同番号读目录详情，并使用实际来源成功提交",
    async (failure) => {
      const { primary, lookup, service, port, records } = fixture();
      if (failure === "offline")
        vi.mocked(primary.search).mockRejectedValue(new Error("安全模拟离线"));
      else
        vi.mocked(primary.search).mockResolvedValue(
          failure === "empty" ? [] : [{ ...movieCandidate(primaryDetails), code: "SAFE-999" }],
        );
      const id = await service.enqueue({ workId: "work-safe", name: "虚构自然纪录片" });
      await finished(service);
      expect(records.get(id)?.candidate).toEqual(movieCandidate(details));
      expect(lookup.read).toHaveBeenCalledTimes(1);
      expect(primary.details).not.toHaveBeenCalled();
      expect(port.commit).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        details,
        expect.any(String),
      );
    },
  );

  it("旧任务的资料来源详情失败后允许切换来源，更新候选身份而不伪造来源", async () => {
    const { primary, lookup, service, port, records } = fixture();
    vi.mocked(primary.details).mockRejectedValue(new Error("安全模拟详情不可用"));
    const id = await service.enqueue({
      name: "虚构自然纪录片",
      candidate: movieCandidate(primaryDetails),
    });
    await finished(service);
    expect(records.get(id)?.candidate).toEqual(movieCandidate(details));
    expect(primary.search).not.toHaveBeenCalled();
    expect(lookup.read).toHaveBeenCalledTimes(1);
    expect(port.commit).toHaveBeenCalledWith(
      expect.objectContaining({ candidate: movieCandidate(details) }),
      expect.anything(),
      details,
      expect.any(String),
    );
  });

  it.each([code, code.toLowerCase()])(
    "已知目录候选 %s 直接访问对应来源，重启后无缓存也不绕回资料服务",
    async (id) => {
      const { primary, lookup, service, records } = fixture();
      const taskId = await service.enqueue({
        name: "虚构自然纪录片",
        candidate: { ...movieCandidate(details), id },
      });
      await finished(service);
      expect(primary.search).not.toHaveBeenCalled();
      expect(primary.details).not.toHaveBeenCalled();
      expect(lookup.read).toHaveBeenCalledTimes(1);
      expect(records.get(taskId)?.candidate).toEqual(movieCandidate(details));
    },
  );

  it.each(["wrong-code", "empty", "placeholder"])(
    "后备详情 %s 时拒绝提交，仍保留身份和完整性校验",
    async (kind) => {
      const { primary, lookup, service, port } = fixture();
      vi.mocked(primary.search).mockResolvedValue([]);
      lookup.read.mockResolvedValue({
        ...details,
        coverUrl: undefined,
        previewImages: [],
        fields:
          kind === "wrong-code"
            ? { code: "SAFE-999", title: "另一虚构样例" }
            : kind === "empty"
              ? {}
              : { code, title: code },
      });
      await service.enqueue({ workId: "work-safe", name: "虚构自然纪录片" });
      await finished(service, "failed");
      expect(port.commit).not.toHaveBeenCalled();
      expect(port.artwork).not.toHaveBeenCalled();
    },
  );

  it("手动匹配模式也能读取完整目录资料，但不会生成资源占位结果", async () => {
    const lookupByCode = vi.fn(async () => details);
    const result = await searchMovieMetadata(
      { search: async () => [], lookupByCode },
      code,
      new AbortController().signal,
      false,
    );
    expect(result.candidates).toEqual([movieCandidate(details)]);
    expect(result.details).toBe(details);
    expect(result.resourceCode).toBeUndefined();
  });

  it("普通标题搜索不会猜测番号或启动目录后备读取", async () => {
    const { primary, lookup, resolver } = fixture();
    vi.mocked(primary.search).mockResolvedValue([]);
    expect(await resolver.search("安全自然纪录片", new AbortController().signal)).toEqual([]);
    expect(lookup.read).not.toHaveBeenCalled();
  });

  it("取消后忽略资料服务的迟到结果，不继续请求其他来源", async () => {
    const { primary, lookup, resolver } = fixture();
    let release!: () => void;
    vi.mocked(primary.search).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );
    const abort = new AbortController();
    const result = resolver.search(code, abort.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    release();
    await rejected;
    expect(lookup.read).not.toHaveBeenCalled();
  });

  it.each(["search", "details"] as const)(
    "%s 的取消和清理未确认同时发生时保留清理错误，不切换来源",
    async (operation) => {
      const { primary, lookup, pipeline } = fixture();
      const abort = new AbortController();
      const cleanup = vi.fn(async () => {});
      const stop = new StopUnconfirmedError(cleanup);
      vi.mocked(primary[operation]).mockImplementationOnce(async () => {
        abort.abort();
        throw stop;
      });
      const result =
        operation === "search"
          ? pipeline.search(code, abort.signal)
          : pipeline.resolve(movieCandidate(primaryDetails), abort.signal);
      await expect(result).rejects.toBe(stop);
      expect(lookup.read).not.toHaveBeenCalled();
      await stop.retry();
      expect(cleanup).toHaveBeenCalledTimes(1);
    },
  );

  it("启用补全时仍查询其他来源，缓存不屏蔽补全且保留主来源封面身份", async () => {
    const { cache, primary, pipeline } = fixture();
    cache.remember(details);
    vi.mocked(primary.details).mockResolvedValue({
      ...primaryDetails,
      fields: { ...primaryDetails.fields, studio: "虚构制作室" },
    });
    await pipeline.settings.save({ fusion: true, retries: 0 });
    const result = await pipeline.resolve(movieCandidate(details), new AbortController().signal);
    expect(primary.search).toHaveBeenCalledTimes(1);
    expect(result.candidate).toEqual(movieCandidate(details));
    expect(result.details.fields.studio).toBe("虚构制作室");
    expect(result.details.coverUrl).toBe(details.coverUrl);
    expect(result.details.fusion?.fields.studio?.provider).toBe("Fixture");
    expect(result.details.fusion?.sources).toHaveLength(2);
  });

  it("前后台读取独立且共用缓存，取消前台不会中断后台", async () => {
    const cache = new MovieDetailsCache();
    let finishBackground!: () => void;
    const fetch = vi.fn(
      (url: string, signal: AbortSignal) =>
        new Promise<string>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          if (url.endsWith("SAFE-902")) finishBackground = () => resolve(html("SAFE-902"));
        }),
    );
    const front = new JavbusMovieLookup(processor, fetch, cache);
    const background = new JavbusMovieLookup(processor, fetch, cache);
    cleanups.push(
      () => front.shutdown(),
      () => background.shutdown(),
    );
    const abort = new AbortController();
    const foreground = front.read(code, abort.signal);
    const rejected = expect(foreground).rejects.toMatchObject({ name: "AbortError" });
    const pending = background.read("SAFE-902", new AbortController().signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    abort.abort();
    await rejected;
    finishBackground();
    const value = await pending;
    expect(value.fields.code).toBe("SAFE-902");
    expect(await front.read("SAFE-902", new AbortController().signal)).toEqual(value);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("详情缓存有数量和时间上限，数据隔离且拒绝错误番号和空资料", () => {
    let now = 1;
    const cache = new MovieDetailsCache(() => now);
    cache.remember(details);
    const copy = cache.candidate(movieCandidate(details))!;
    copy.fields.title = "修改后的安全样例";
    expect(cache.code(code)?.fields.title).toBe(details.fields.title);
    expect(cache.candidate({ ...movieCandidate(details), code: "SAFE-999" })).toBeUndefined();
    expect(() => cache.remember({ ...details, fields: {} })).toThrow();
    for (let index = 0; index < 64; index++)
      cache.remember({
        ...details,
        id: `SAFE-${index}`,
        fields: { title: "虚构样例", code: `SAFE-${index}` },
      });
    expect(cache.code(code)).toBeUndefined();
    expect(cache.code("SAFE-63")).toBeDefined();
    now += 15 * 60_000;
    expect(cache.code("SAFE-63")).toBeUndefined();
  });

  it("缓存总字节有界，超大更新不会使旧详情冒充本次结果", () => {
    const cache = new MovieDetailsCache();
    cache.remember(details);
    cache.remember({ ...details, fields: { ...details.fields, plot: "s".repeat(260 * 1024) } });
    expect(cache.code(code)).toBeUndefined();
    for (let index = 0; index < 20; index++)
      cache.remember({
        ...details,
        id: `SAFE-${index}`,
        fields: { code: `SAFE-${index}`, title: "安全样例", plot: "s".repeat(240 * 1024) },
      });
    expect(cache.code("SAFE-0")).toBeUndefined();
    expect(cache.code("SAFE-19")).toBeDefined();
    cache.clear();
    expect(cache.code("SAFE-19")).toBeUndefined();
  });
});
