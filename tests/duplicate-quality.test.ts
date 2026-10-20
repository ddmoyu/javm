import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type {
  MaintenanceCommand,
  MaintenancePage,
  MaintenanceVideo,
  RemovalTarget,
} from "../frontend/src/contracts/maintenance";
import { defaultAdRules } from "../frontend/src/contracts/maintenance";
import { duplicateRows, videoBitrate } from "../frontend/src/services/library/maintenanceRules";
import { LibraryMaintenanceService } from "../frontend/src/services/library/LibraryMaintenanceService";
import type { LibraryPort } from "../frontend/src/services/library/LibraryService";

const sample = (id: string, extra: Partial<MaintenanceVideo> = {}): MaintenanceVideo => ({
  id,
  workId: "safe-work",
  path: `D:/安全合成/${id}.mp4`,
  title: "合成纪录片",
  code: "TEST-001",
  hash: `hash-${id}`,
  size: 2_000_000_000,
  duration: 3600,
  resolution: "1920x1080",
  codec: "AVC",
  bitrate: 4_000_000,
  missing: false,
  ...extra,
});

describe("重复视频按画质建议", () => {
  it("同编码、同分辨率优先实际视频码率，不被音频和容器造成的大文件误导", () => {
    const rows = duplicateRows([
      sample("large", { size: 5_000_000_000, bitrate: 3_000_000 }),
      sample("keep", { codec: "H.264", bitrate: 8_000_000 }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["keep", "large"]);
    expect(rows[0]?.suggestedKeep).toBe(true);
    expect(rows[1]).toMatchObject({ suggested: true, advice: "同分辨率、同编码，视频码率较低" });
  });
  it("优先分辨率，并把不同剪辑留给人工核对", () => {
    const rows = duplicateRows([
      sample("full-4k", { resolution: "3840x2160" }),
      sample("full-hd"),
      sample("short-8k", { duration: 1200, resolution: "8K", size: 10_000_000_000 }),
    ]);
    expect(rows[0]?.id).toBe("full-4k");
    expect(rows.find((row) => row.id === "full-hd")?.suggested).toBe(true);
    expect(rows.find((row) => row.id === "short-8k")).toMatchObject({
      suggested: false,
      review: true,
    });
  });
  it("同分辨率的不同编码不按码率或大小互相淘汰", () => {
    const rows = duplicateRows([
      sample("avc"),
      sample("hevc", { codec: "HEVC", bitrate: 2_000_000 }),
    ]);
    expect(rows.every((row) => !row.suggested && row.review)).toBe(true);
    expect(rows.some((row) => row.advice?.includes("编码不同"))).toBe(true);
  });
  it("旧记录明确使用估算总码率，缺少时长时不生成估算或删除建议", () => {
    const keep = sample("keep", { bitrate: null, size: 4_500_000_000 });
    const copy = sample("copy", { bitrate: undefined, size: 2_250_000_000 });
    expect(videoBitrate(keep)).toEqual({ value: 10_000_000, estimated: true });
    expect(duplicateRows([keep, copy])[1]).toMatchObject({
      suggested: true,
      advice: "同分辨率、同编码，估算总码率较低，仅供参考",
    });
    expect(videoBitrate({ ...copy, duration: 0 }).value).toBe(0);
    expect(duplicateRows([keep, { ...copy, duration: 0 }]).every((row) => !row.suggested)).toBe(
      true,
    );
  });
  it("快速指纹不能覆盖编码冲突，细微码率差异不标为明显较差", () => {
    for (const pair of [
      [sample("a", { hash: "same" }), sample("b", { hash: "same", codec: "HEVC" })],
      [sample("a"), sample("b", { bitrate: 4_010_000 })],
    ])
      expect(duplicateRows(pair).every((row) => !row.suggested)).toBe(true);
  });
  it("同一作品即使没有番号和指纹也能比较视频", () => {
    const rows = duplicateRows([
      sample("keep", { code: "", hash: "", bitrate: 8_000_000 }),
      sample("copy", { code: "", hash: "" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ group: "合成纪录片", reason: "同一作品", suggestedKeep: true });
  });
  it("显式分段和文件名分段均不自动清理", () => {
    for (const videos of [
      [sample("one", { part: 1 }), sample("two", { part: 2 })],
      [sample("TEST-001-CD1"), sample("TEST-001-PART2")],
    ])
      expect(
        duplicateRows(videos).every((row) => row.review && !row.suggested && !row.suggestedKeep),
      ).toBe(true);
  });
  it("指纹交叉关联不同番号时不自动清理", () => {
    const rows = duplicateRows([
      sample("a", { hash: "same" }),
      sample("b", { workId: "other", code: "TEST-002", hash: "same" }),
    ]);
    expect(rows.every((row) => row.review && !row.suggested)).toBe(true);
  });
  it("缺失、未知大小、缺少分辨率的资源不进入自动清理", () => {
    const rows = duplicateRows([
      sample("keep", { bitrate: 8_000_000 }),
      sample("copy"),
      sample("gone", { missing: true }),
      sample("unknown", { size: null }),
      sample("no-resolution", { resolution: "" }),
    ]);
    expect(rows.filter((row) => row.suggested).map((row) => row.id)).toEqual(["copy"]);
  });
  it("指纹和参数一致时优先无副本后缀的文件，默认不勾选", () => {
    const rows = duplicateRows([
      sample("copy", { hash: "same", path: "D:/安全合成/合成纪录片 (1).mp4" }),
      sample("original", { hash: "same", path: "D:/安全合成/合成纪录片.mp4" }),
    ]);
    expect(rows[0]?.id).toBe("original");
    expect(rows[1]?.suggested).toBe(true);
    expect(rows.every((row) => !row.selected)).toBe(true);
  });
});

let workerMessage: (event: MessageEvent) => void;
beforeAll(async () => {
  const endpoint = { onmessage: undefined as typeof workerMessage | undefined };
  vi.stubGlobal("self", endpoint);
  await import("../frontend/src/services/library/maintenance.worker");
  workerMessage = endpoint.onmessage!;
  vi.unstubAllGlobals();
});
afterEach(() => vi.unstubAllGlobals());
function command<T>(value: MaintenanceCommand): T {
  let response: { result: T; error?: string } | undefined;
  vi.stubGlobal("self", {
    postMessage: (message: typeof response) => {
      response = message;
    },
  });
  workerMessage({ data: { id: 1, command: value } } as MessageEvent);
  if (response?.error) throw new Error(response.error);
  return response!.result;
}
function load(videos: MaintenanceVideo[]) {
  command({ type: "reset", mode: "duplicates", rules: defaultAdRules });
  command({ type: "append", rows: videos });
  return command<MaintenancePage>({ type: "finish" });
}
describe("画质建议的 Worker 与删除边界", () => {
  it("跨页统计建议数量和大小，一键选择只包含建议项且保留正确副本", () => {
    const videos = Array.from({ length: 31 }, (_, index) => [
      sample(`keep-${index}`, {
        workId: `work-${index}`,
        code: `TEST-${index}`,
        bitrate: 8_000_000,
      }),
      sample(`copy-${index}`, { workId: `work-${index}`, code: `TEST-${index}` }),
    ]).flat();
    const initial = load(videos);
    expect(initial).toMatchObject({
      total: 62,
      suggested: 31,
      suggestedBytes: 62_000_000_000,
      selected: 0,
    });
    expect(initial.rows).toHaveLength(30);
    command({ type: "page", page: 3 });
    const selected = command<MaintenancePage>({ type: "select", choice: "suggested" });
    expect(selected).toMatchObject({ selected: 31, selectedBytes: 62_000_000_000, unprotected: 0 });
    const targets = command<RemovalTarget[]>({ type: "selected", after: 0 });
    expect(targets).toHaveLength(30);
    expect(
      targets.every(
        (target) => target.id.startsWith("copy-") && target.retained?.id.startsWith("keep-"),
      ),
    ).toBe(true);
  });
  it("不能用另一分段保护当前分段的删除", () => {
    load([sample("part-1", { part: 1 }), sample("part-2", { part: 2 })]);
    expect(command<MaintenancePage>({ type: "select", choice: "suggested" }).selected).toBe(0);
    expect(
      command<MaintenancePage>({ type: "select", choice: "toggle", ids: ["part-2"] }).unprotected,
    ).toBe(1);
    expect(command<RemovalTarget[]>({ type: "selected", after: 0 })[0]?.retained).toBeUndefined();
  });
  it("建议选择成功后才允许打开确认，清理继续使用原生保留副本校验", async () => {
    let videos = [
      sample("keep", { bitrate: 8_000_000 }),
      sample("copy"),
      sample("different-edit", { duration: 1000 }),
    ];
    const files = { remove: vi.fn(async () => {}) };
    let active = "";
    const request = vi.fn(async (method: string, input: unknown = {}) => {
      const params = input as { id: string; path: string };
      if (method === "library.maintenance.read") return { items: videos, revision: 1 };
      if (method === "library.maintenance.prepare") {
        active = params.id;
        return { files: [{ path: params.path, stamp: "safe" }], preserved: 0 };
      }
      if (method === "library.maintenance.checkFile") return { exists: true };
      if (method === "library.maintenance.complete")
        videos = videos.filter((video) => video.id !== active);
      return {};
    });
    const worker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null,
      terminate() {},
      postMessage(data: unknown) {
        queueMicrotask(() => {
          vi.stubGlobal("self", {
            postMessage: (reply: unknown) => worker.onmessage?.({ data: reply } as MessageEvent),
          });
          workerMessage({ data } as MessageEvent);
        });
      },
    };
    const service = new LibraryMaintenanceService(
      { request: request as LibraryPort["request"] },
      files,
      { read: async () => null, write: async () => {} },
      () => worker as unknown as Worker,
      async () => {},
    );
    try {
      expect(await service.change({ type: "select", choice: "suggested" })).toBe(false);
      await service.scan();
      expect(await service.change({ type: "select", choice: "suggested" })).toBe(true);
      expect(files.remove).not.toHaveBeenCalled();
      await service.remove(false);
      expect(files.remove).toHaveBeenCalledExactlyOnceWith("D:/安全合成/copy.mp4");
      expect(request).toHaveBeenCalledWith(
        "library.maintenance.prepare",
        expect.objectContaining({
          id: "copy",
          requireRetainedCopy: true,
          retained: { id: "keep", path: "D:/安全合成/keep.mp4" },
        }),
      );
      expect(videos.map((video) => video.id)).toEqual(["keep", "different-edit"]);
    } finally {
      await service.shutdown();
    }
  });
});
