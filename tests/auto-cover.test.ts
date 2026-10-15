import { describe, expect, it, vi } from "vite-plus/test";
import {
  ArtworkService,
  type ArtworkTarget,
  type ArtworkTools,
} from "../frontend/src/services/library/ArtworkService";
import {
  AutoCoverService,
  autoCoverSeconds,
  type PendingCover,
} from "../frontend/src/services/library/AutoCoverService";
import type { LibraryPort } from "../frontend/src/services/library/LibraryService";

const directory = "C:/fixture/metadata/safe/images";
const pending = (count: number, offset = 0): PendingCover[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `w-${String(offset + index).padStart(3, "0")}`,
    video_id: `v-${offset + index}`,
    path: `C:/safe/${offset + index}.mp4`,
    file_stamp: `stamp-${offset + index}`,
    duration_ms: 60_000,
  }));

/** 安全 mock：不运行 FFmpeg、不读写真实文件，只记录调用。 */
function fixture(pages: PendingCover[][], options: { failFrame?: (path: string) => boolean } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let page = 0,
    running = 0,
    peak = 0;
  const posters = new Map<string, string>();
  const request: LibraryPort["request"] = async <T>(method: string, params: unknown = {}) => {
    const input = params as Record<string, unknown>;
    calls.push({ method, params: input });
    if (method === "library.artwork.pending") return (pages[page++] ?? []) as T;
    if (method === "library.artwork.prepare")
      return { directory, poster: posters.get(String(input.id)) ?? "" } as T;
    if (method === "library.artwork.commit") {
      posters.set(String(input.id), "poster");
      return { retired: [] } as T;
    }
    return {} as T;
  };
  const tools = {
    mkdir: vi.fn(async () => {}),
    read: async () => new ArrayBuffer(4),
    write: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    frame: vi.fn(
      async (path: string, _output?: string, _seconds?: number, _signal?: AbortSignal) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running--;
        if (options.failFrame?.(path)) throw new Error("视频已损坏");
      },
    ),
    transform: async () => new ArrayBuffer(4),
  };
  const refresh = vi.fn(async () => {});
  const log = vi.fn();
  const service = new AutoCoverService({ request }, tools, refresh, log);
  const finished = () =>
    new Promise<void>((resolve) => {
      const check = () => (service.getSnapshot().running ? setTimeout(check, 2) : resolve());
      setTimeout(check, 2);
    });
  return { service, calls, tools, refresh, log, finished, peak: () => peak, posters };
}

describe("扫描后自动封面（安全 mock）", () => {
  it("chooses a frame at 10% of the duration while staying inside short videos", () => {
    expect(autoCoverSeconds(600_000)).toBe(60);
    expect(autoCoverSeconds(5_000)).toBe(1);
    expect(autoCoverSeconds(800)).toBeCloseTo(0.4);
  });
  it("pages through pending works, runs at most two captures and commits automatic covers", async () => {
    const f = fixture([pending(50), pending(5, 50)]);
    f.service.schedule();
    await f.finished();
    const commits = f.calls.filter((call) => call.method === "library.artwork.commit");
    expect(commits).toHaveLength(55);
    expect(commits[0]!.params).toMatchObject({
      id: "w-000",
      expectedPoster: "",
      automatic: true,
      video: { id: "v-0", file_stamp: "stamp-0" },
    });
    expect(f.peak()).toBeLessThanOrEqual(2);
    // 第二页从第一页最后一个作品之后开始，页面不足时结束。
    const pages = f.calls.filter((call) => call.method === "library.artwork.pending");
    expect(pages.map((call) => call.params.after)).toEqual(["", "w-049"]);
    expect(f.refresh.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(f.service.getSnapshot()).toMatchObject({ running: false, created: 55, failed: 0 });
    expect(f.log).toHaveBeenCalledWith("自动封面：生成 55 张。");
  });
  it("records a failed capture, cleans up and keeps going", async () => {
    const f = fixture([pending(3)], { failFrame: (path) => path.endsWith("1.mp4") });
    f.service.schedule();
    await f.finished();
    expect(f.calls.filter((call) => call.method === "library.artwork.failed")).toEqual([
      { method: "library.artwork.failed", params: { id: "w-001", fileStamp: "stamp-1" } },
    ]);
    expect(f.service.getSnapshot()).toMatchObject({ created: 2, failed: 1 });
    // 失败的作品：未提交的输出与临时目录都会删除。
    expect(f.tools.remove.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
  it("skips works that received a cover in the meantime", async () => {
    const f = fixture([pending(2)]);
    f.posters.set("w-000", "C:/existing.jpg");
    f.service.schedule();
    await f.finished();
    expect(f.calls.filter((call) => call.method === "library.artwork.commit")).toHaveLength(1);
    expect(f.tools.frame).toHaveBeenCalledTimes(1);
  });
  it("stops quietly when a scan takes the library lock, and reruns once if rescheduled", async () => {
    let attempts = 0;
    const calls: string[] = [];
    const request: LibraryPort["request"] = async <T>(method: string) => {
      calls.push(method);
      if (method === "library.artwork.pending") return (attempts++ === 0 ? pending(2) : []) as T;
      if (method === "library.artwork.prepare") throw new Error("请等待当前片库操作完成后处理图片");
      return {} as T;
    };
    const service = new AutoCoverService(
      { request },
      {
        mkdir: async () => {},
        read: async () => new ArrayBuffer(4),
        write: async () => {},
        remove: async () => {},
        frame: async () => {},
        transform: async () => new ArrayBuffer(4),
      },
      async () => {},
    );
    service.schedule();
    service.schedule();
    await vi.waitFor(() => expect(attempts).toBe(2));
    await vi.waitFor(() => expect(service.getSnapshot().running).toBe(false));
    // 扫描占用片库时不记录失败，避免把可截帧的视频误标为失败。
    expect(calls).not.toContain("library.artwork.failed");
    expect(calls.filter((method) => method === "library.artwork.pending")).toHaveLength(2);
  });
  it("aborts the running capture on shutdown and ignores later schedules", async () => {
    let release!: () => void;
    const f = fixture([pending(1)]);
    f.tools.frame.mockImplementation(
      (_path: string, _output?: string, _seconds?: number, signal?: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          release = resolve;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    f.service.schedule();
    await vi.waitFor(() => expect(release).toBeDefined());
    await f.service.shutdown();
    f.service.schedule();
    expect(f.service.getSnapshot().running).toBe(false);
    expect(f.calls.filter((call) => call.method === "library.artwork.commit")).toHaveLength(0);
  });
});

describe("从视频挑选画面（安全 mock）", () => {
  const target: ArtworkTarget = {
    directory,
    poster: "",
    code: "SAFE-001",
    title: "安全样例",
    source: {},
    videos: [{ id: "v1", path: "C:/safe/1.mp4", file_stamp: "s1", duration_ms: 110_000 }],
  };
  function picker() {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const request: LibraryPort["request"] = async <T>(method: string, params: unknown = {}) => {
      calls.push({ method, params: params as Record<string, unknown> });
      if (method === "library.artwork.prepare") return target as T;
      return { retired: [] } as T;
    };
    const frame = vi.fn(async () => {});
    const tools: ArtworkTools = {
      mkdir: async () => {},
      read: async () => new ArrayBuffer(4),
      write: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      frame,
      transform: async () => new ArrayBuffer(8),
      download: async () => {},
      details: async () => {
        throw new Error("不应联网");
      },
    };
    return { calls, frame, tools, service: new ArtworkService({ request }, tools, async () => {}) };
  }
  it("streams evenly spaced candidates without saving them", async () => {
    const f = picker();
    const seen: number[] = [];
    const result = await f.service.captureCandidates("safe", 10, undefined, (frame) =>
      seen.push(frame.seconds),
    );
    expect(seen).toHaveLength(10);
    seen.forEach((seconds, index) => expect(seconds).toBeCloseTo((index + 1) * 10));
    expect(result.frames).toHaveLength(10);
    expect(result.video).toMatchObject({ id: "v1" });
    expect(f.calls.map((call) => call.method)).toEqual(["library.artwork.prepare"]);
    expect(vi.mocked(f.tools.remove).mock.calls.at(-1)![0]).toContain("/.work-");
    await f.service.shutdown();
  });
  it("saves one chosen frame as the cover or several as previews in time order", async () => {
    const f = picker();
    const { frames, video } = await f.service.captureCandidates("safe", 3, undefined, () => {});
    await f.service.applyFrames("safe", [frames[0]!], "poster", video);
    await f.service.applyFrames("safe", [frames[2]!, frames[1]!], "screenshot", video);
    const commits = f.calls.filter((call) => call.method === "library.artwork.commit");
    expect((commits[0]!.params.images as { kind: string }[]).map((image) => image.kind)).toEqual([
      "poster",
    ]);
    expect(
      (commits[1]!.params.images as { kind: string; seconds: number }[]).map(
        (image) => image.seconds,
      ),
    ).toEqual([frames[1]!.seconds, frames[2]!.seconds]);
    expect(commits[1]!.params.video).toMatchObject({ id: "v1", file_stamp: "s1" });
    await expect(f.service.applyFrames("safe", frames, "poster", video)).rejects.toThrow("一张");
    await expect(f.service.applyFrames("safe", [], "screenshot", video)).rejects.toThrow("至少");
    await f.service.shutdown();
  });
  it("refuses works without a probed local video", async () => {
    const f = picker();
    target.videos[0]!.duration_ms = 0;
    try {
      await expect(f.service.captureCandidates("safe", 10, undefined, () => {})).rejects.toThrow(
        "没有可抽帧",
      );
    } finally {
      target.videos[0]!.duration_ms = 110_000;
    }
    await f.service.shutdown();
  });
});
