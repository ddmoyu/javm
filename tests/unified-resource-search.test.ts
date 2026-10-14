import { describe, expect, it, vi } from "vite-plus/test";
import { mergeMovieCandidates } from "../frontend/src/services/metadata/mergeMovieCandidates";
import { ResourceSearchService } from "../frontend/src/services/streamResolution/ResourceSearchService";
import { ResolutionService } from "../frontend/src/services/streamResolution/ResolutionService";
import {
  rankResourceSources,
  readSourcePerformance,
} from "../frontend/src/services/streamResolution/sourcePerformance";
import {
  mergeResourceLinks,
  resourceVideoTrack,
} from "../frontend/src/services/streamResolution/resourceLinks";
import { parsePlaylist } from "../frontend/src/services/streamResolution/parsers";
import { bounds } from "../frontend/src/services/streamResolution/shared";
import type {
  ResourceArchive,
  ResourcePreferences,
} from "../frontend/src/services/streamResolution/archive";
import type {
  ResolutionHandle,
  ResolutionOutcome,
  ResolutionRequest,
  ResolvedStream,
} from "../frontend/src/contracts/streamResolution";
import type { ParseTasks, ResolutionParser } from "../frontend/src/services/streamResolution/ports";

const base = "https://safe.example.invalid";
const sources = ["a", "b", "c"].map((id) => ({
  id,
  name: "虚构来源 " + id,
  template: base + "/" + id + "/{code}",
}));
const stream: ResolvedStream = {
  pageUrl: base + "/player",
  manifestUrl: base + "/master.m3u8?quality=1080",
  tracks: [{ kind: "video", url: base + "/1080.m3u8", width: 1920, height: 1080, duration: 60 }],
  checkedAt: 1,
  expiresAt: 2,
  validation: "playlist-and-sample",
  discoveredBy: "webview",
  context: { origin: base, headers: {}, publicHeaders: { referer: base + "/player" } },
};
const success: ResolutionOutcome = { ok: true, streams: [stream] };
const cancelled: ResolutionOutcome = {
  ok: false,
  code: "cancelled",
  message: "已取消",
  fallbackEligible: false,
};

function fixture(initial: ResourcePreferences | null = null, sourceList = sources) {
  let preferences = initial;
  const jobs: { request: ResolutionRequest; finish: (value: ResolutionOutcome) => void }[] = [];
  const submit = (request: ResolutionRequest): ResolutionHandle => {
    let finish!: (value: ResolutionOutcome) => void;
    const result = new Promise<ResolutionOutcome>((resolve) => {
      finish = resolve;
    });
    const id = "safe-job-" + jobs.length;
    jobs.push({ request, finish });
    return { id, result, cancel: () => finish(cancelled) };
  };
  const resolution = {
    subscribe: () => () => {},
    getSnapshot: () => ({ webviewAvailable: true, cleanupPending: 0, tasks: [] }),
    submit,
  } as unknown as ResolutionService;
  const archive: ResourceArchive = {
    read: async () => [],
    save: vi.fn(async () => {}),
    remove: async () => {},
    readPreferences: async () => preferences,
    writePreferences: vi.fn(async (value) => {
      preferences = structuredClone(value);
    }),
  };
  const add = vi.fn(async () => 1);
  const service = new ResourceSearchService(
    resolution,
    { add, directory: () => "safe-downloads" },
    sourceList,
    archive,
  );
  return { service, jobs, archive, add, preferences: () => preferences };
}

describe("统一搜索与资源链接（仅安全虚构数据）", () => {
  it("合并同番号及无冲突片名，保留同名但不同番号的作品", async () => {
    const rows = await mergeMovieCandidates([
      { provider: "safe-a", id: "1", code: "SAFE-001", title: "山间旅行" },
      { provider: "safe-b", id: "2", code: "safe_001", title: "山间旅行" },
      { provider: "safe-c", id: "3", code: "", title: "山间旅行" },
      { provider: "safe-a", id: "4", code: "SAFE-002", title: "城市漫步" },
      { provider: "safe-b", id: "5", code: "SAFE-003", title: "城市漫步" },
      { provider: "safe-a", id: "6", code: "", title: "夜空记录" },
      { provider: "safe-b", id: "7", code: "", title: "夜空记录" },
    ]);
    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.candidate.code === "SAFE-001")?.candidates).toHaveLength(3);
    expect(rows.filter((row) => row.candidate.title === "城市漫步")).toHaveLength(2);
    expect(rows.find((row) => row.candidate.title === "夜空记录")?.candidates).toHaveLength(2);
  });

  it("按成功率及成功次数排序，无效历史被忽略", () => {
    const stats = readSourcePerformance(
      {
        a: { attempts: 10, successes: 1 },
        b: { attempts: 10, successes: 9 },
        c: { attempts: 1, successes: 5 },
      },
      sources,
    );
    expect(stats.c).toBeUndefined();
    expect(rankResourceSources(sources, stats).map((source) => source.id)).toEqual(["b", "c", "a"]);
    expect(
      rankResourceSources(sources, {
        a: { attempts: 2, successes: 1, lastSuccessAt: 0 },
        b: { attempts: 10, successes: 5, lastSuccessAt: 0 },
      }).map((source) => source.id),
    ).toEqual(["b", "a", "c"]);
  });

  it("各来源并行查找，找到即发布，相同链接去重且保留分辨率及内部来源", async () => {
    const f = fixture();
    try {
      await f.service.initialize();
      f.service.search("SAFE-001");
      // 并行提交到隐藏实例上限，不必等前一个来源结束。
      expect(f.jobs).toHaveLength(Math.min(sources.length, bounds.webviews));
      f.jobs[0]!.finish(success);
      await vi.waitFor(() =>
        expect(f.service.getSnapshot()).toMatchObject({ searching: true, completed: 1 }),
      );
      expect(f.service.getSnapshot().rows[0]?.stream).toBe(stream);
      f.jobs[1]!.finish(success);
      await vi.waitFor(() => expect(f.jobs).toHaveLength(3));
      f.jobs[2]!.finish({
        ok: true,
        streams: [{ ...stream, manifestUrl: base + "/master.m3u8?quality=720" }],
      });
      await vi.waitFor(() => expect(f.service.getSnapshot().busy).toBe(false));
      const links = mergeResourceLinks(f.service.getSnapshot().rows, [], "SAFE-001");
      expect(links).toHaveLength(2);
      expect(links[0]?.liveSourceIds).toEqual(["a", "b"]);
      expect(resourceVideoTrack(links[0]!)).toMatchObject({
        width: 1920,
        height: 1080,
        duration: 60,
      });
      expect(f.service.getSnapshot().sourcePerformance).toMatchObject({
        a: { attempts: 1, successes: 1 },
        b: { attempts: 1, successes: 1 },
        c: { attempts: 1, successes: 1 },
      });
    } finally {
      await f.service.shutdown();
    }
  });

  it.each([2, 8])(
    "并发上限为 %i 时取消清空剩余队列，保留链接和已开始的复制且不记为来源失败",
    async (concurrency) => {
      const previousLimit = bounds.webviews;
      bounds.webviews = concurrency;
      const queuedSources = Array.from({ length: concurrency + 2 }, (_, index) => {
        const id = String.fromCharCode(97 + index);
        return { id, name: "虚构来源 " + id, template: base + "/" + id + "/{code}" };
      });
      const f = fixture(null, queuedSources);
      try {
        await f.service.initialize();
        f.service.search("SAFE-001");
        expect(f.jobs).toHaveLength(concurrency);
        f.jobs[0]!.finish(success);
        await vi.waitFor(() => expect(f.service.getSnapshot().rows[0]?.stream).toBe(stream));
        // 完成一项会补充下一来源；取消时仍有一项未开始。
        const started = concurrency + 1;
        expect(f.jobs).toHaveLength(started);
        expect(started).toBeLessThan(queuedSources.length);
        const copy = f.service.copyResult("a");
        f.service.cancel();
        f.jobs.at(-1)!.finish(success);
        expect(await copy).toBe(stream.manifestUrl);
        await vi.waitFor(() => expect(f.service.getSnapshot().busy).toBe(false));
        expect(f.jobs.filter((job) => job.request.provider === "webview")).toHaveLength(started);
        expect(f.service.getSnapshot().rows[0]?.stream).toBe(stream);
        expect(Object.keys(f.service.getSnapshot().sourcePerformance)).toEqual(["a"]);
      } finally {
        await f.service.shutdown();
        bounds.webviews = previousLimit;
      }
    },
  );

  it("保存成功及失败次数，重开后优先历史表现好的来源且恢复全部来源", async () => {
    const f = fixture();
    await f.service.initialize();
    f.service.search("SAFE-001");
    f.jobs[0]!.finish({
      ok: false,
      code: "not_found",
      message: "安全样例不存在",
      fallbackEligible: false,
    });
    f.jobs[1]!.finish(success);
    await vi.waitFor(() => expect(f.jobs).toHaveLength(3));
    await f.service.shutdown();
    expect(f.preferences()?.sourcePerformance).toMatchObject({
      a: { attempts: 1, successes: 0 },
      b: { attempts: 1, successes: 1 },
    });
    const restored = fixture({ ...f.preferences()!, selected: ["a"] });
    try {
      await restored.service.initialize();
      expect(restored.jobs).toHaveLength(0);
      restored.service.search("SAFE-002");
      expect(restored.jobs[0]?.request.url).toBe(base + "/b/safe-002");
      expect(restored.service.getSnapshot().total).toBe(3);
    } finally {
      await restored.service.shutdown();
    }
  });

  it("切换影片后迟到结果不能覆盖新查找或计入统计", async () => {
    const f = fixture();
    try {
      await f.service.initialize();
      f.service.search("SAFE-001");
      f.jobs[0]!.finish(success);
      f.service.search("SAFE-002");
      await Promise.resolve();
      expect(f.service.getSnapshot().code).toBe("SAFE-002");
      expect(f.service.getSnapshot().rows.some((row) => row.stream)).toBe(false);
      expect(f.service.getSnapshot().sourcePerformance).toEqual({});
    } finally {
      await f.service.shutdown();
    }
  });

  it("预览无需作品 ID 即可交接下载，复制与下载校验不重复累计成功次数", async () => {
    const f = fixture();
    try {
      await f.service.initialize();
      f.service.search("SAFE-001");
      f.jobs[0]!.finish(success);
      await vi.waitFor(() => expect(f.service.getSnapshot().rows[0]?.stream).toBe(stream));
      const download = f.service.addDownload("a");
      expect(f.jobs.at(-1)?.request.provider).toBe("direct-hls");
      f.jobs.at(-1)!.finish(success);
      await download;
      expect(f.add).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "hls",
          workId: undefined,
          urls: [stream.manifestUrl],
          headers: { referer: base + "/player" },
        }),
      );
      await f.service.addDownload("a");
      expect(f.add).toHaveBeenCalledTimes(1);
      const copy = f.service.copyResult("a");
      f.jobs.at(-1)!.finish(success);
      expect(await copy).toBe(stream.manifestUrl);
      expect(f.service.getSnapshot().sourcePerformance.a).toMatchObject({
        attempts: 1,
        successes: 1,
      });
    } finally {
      await f.service.shutdown();
    }
  });

  it("详情关闭后取消该番号的查找，StrictMode 式卸载再挂载及其他番号不受影响", async () => {
    const f = fixture();
    try {
      await f.service.initialize();
      f.service.search("SAFE-001", "1");
      const release = f.service.holdView("SAFE-001", "1");
      // 卸载后立即重新挂载（StrictMode、切换标签）不能取消。
      release();
      const again = f.service.holdView("safe-001", "1");
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(f.service.getSnapshot().searching).toBe(true);
      // 关闭其他影片的详情不影响当前查找。
      f.service.holdView("SAFE-002", "2")();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(f.service.getSnapshot().searching).toBe(true);
      again();
      await vi.waitFor(() => expect(f.service.getSnapshot().searching).toBe(false));
      expect(f.service.getSnapshot().cancelled).toBe(true);
      expect(f.service.getSnapshot().sourcePerformance).toEqual({});
    } finally {
      await f.service.shutdown();
    }
  });

  it("嵌套 HLS 外层缺少分辨率时保留内层的实际像素尺寸", async () => {
    const parser: ResolutionParser = {
      async run<K extends keyof ParseTasks>(
        operation: K,
        input: ParseTasks[K]["input"],
      ): Promise<ParseTasks[K]["output"]> {
        if (operation !== "playlist" || !("url" in input)) throw new Error("仅解析安全 HLS 样例");
        return parsePlaylist(input.body, input.url) as ParseTasks[K]["output"];
      },
      close() {},
    };
    const resolution = new ResolutionService({
      parser,
      http: async (request) => {
        const path = new URL(request.url).pathname;
        const body =
          path === "/outer.m3u8"
            ? "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\ninner.m3u8"
            : path === "/inner.m3u8"
              ? "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1920x1080\nvideo.m3u8"
              : path === "/video.m3u8"
                ? "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST"
                : "SAFE-SEGMENT";
        return { status: 200, headers: {}, body: new TextEncoder().encode(body).buffer };
      },
    });
    try {
      const result = await resolution.submit({ provider: "direct-hls", url: base + "/outer.m3u8" })
        .result;
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.streams[0]?.tracks[0]).toMatchObject({
          width: 1920,
          height: 1080,
          duration: 6,
        });
    } finally {
      await resolution.shutdown();
    }
  });
});
