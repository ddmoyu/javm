import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { MaintenanceVideo } from "../frontend/src/contracts/maintenance";
import { duplicateRows, retainedCopies } from "../frontend/src/services/library/maintenanceRules";
import { LibraryMaintenanceService } from "../frontend/src/services/library/LibraryMaintenanceService";
import { LibraryService } from "../frontend/src/services/library/LibraryService";
import type { LibraryPort } from "../frontend/src/services/library/LibraryService";

const sample = (id: string, extra: Partial<MaintenanceVideo> = {}): MaintenanceVideo => ({
  id,
  path: `D:/合成/${id}.mp4`,
  title: "合成纪录片",
  code: "TEST-001",
  hash: "fixture-hash",
  size: 1024,
  duration: 600,
  resolution: "1920x1080",
  codec: "AVC",
  missing: false,
  ...extra,
});

// 执行正式 Worker 的消息处理函数，仅替换线程传输，不替换分组与选择逻辑。
let workerMessage: (event: MessageEvent) => void;
beforeAll(async () => {
  const endpoint = { onmessage: undefined as typeof workerMessage | undefined };
  vi.stubGlobal("self", endpoint);
  await import("../frontend/src/services/library/maintenance.worker");
  workerMessage = endpoint.onmessage!;
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function workerFixture(): Worker {
  let terminated = false;
  const worker = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null,
    postMessage(data: unknown) {
      queueMicrotask(() => {
        if (!terminated) workerMessage({ data } as MessageEvent);
      });
    },
    terminate() {
      terminated = true;
    },
  };
  vi.stubGlobal("self", {
    postMessage: (data: unknown) => worker.onmessage?.({ data } as MessageEvent),
  });
  return worker as unknown as Worker;
}

function maintenanceFixture(mode: "duplicates" | "ads" = "duplicates") {
  let videos = [sample("keep", { size: 2048 }), sample("copy")];
  let activeId = "";
  let failRefresh = false;
  const files = { remove: vi.fn(async () => {}) };
  const request = vi.fn(async (method: string, params: unknown = {}) => {
    const input = params as { id: string; path: string };
    if (method === "library.maintenance.read") {
      if (failRefresh) throw new Error("合成读取失败");
      return { items: videos, revision: 1 };
    }
    if (method === "library.maintenance.prepare") {
      activeId = input.id;
      return { files: [{ path: input.path, stamp: "fixture" }], preserved: 0 };
    }
    if (method === "library.maintenance.checkFile") return { exists: true };
    if (method === "library.maintenance.complete") {
      videos = videos.filter((video) => video.id !== activeId);
    }
    return {};
  });
  const service = new LibraryMaintenanceService(
    { request: request as LibraryPort["request"] },
    files,
    {
      read: async () => ({ keywords: ["合成"], excludeKeywords: [], duplicateNames: false }),
      write: async () => {},
    },
    workerFixture,
    async () => {},
  );
  return {
    service,
    request,
    files,
    scan: () => service.scan(mode),
    failRefresh: () => {
      failRefresh = true;
    },
  };
}

describe("目录清理闭环修复", () => {
  it("已丢失的高清长视频不参与保留建议，当前可用文件优先", () => {
    const rows = duplicateRows([
      sample("gone", { missing: true, duration: 3600, resolution: "3840x2160", size: 9000 }),
      sample("keep", { size: 2048 }),
      sample("copy"),
    ]);
    expect(
      rows.map(({ id, suggestedKeep, suggested }) => ({ id, suggestedKeep, suggested })),
    ).toEqual([
      { id: "keep", suggestedKeep: true, suggested: false },
      { id: "copy", suggestedKeep: false, suggested: true },
      { id: "gone", suggestedKeep: false, suggested: false },
    ]);
    expect(retainedCopies(rows, new Set(["copy", "gone"])).get(rows[0]!.groupId)?.id).toBe("keep");
    expect(retainedCopies(rows, new Set(["keep", "copy"])).size).toBe(0);
  });

  it("全部缺失或零字节时不生成可用副本建议", () => {
    const rows = duplicateRows([sample("missing", { missing: true }), sample("zero", { size: 0 })]);
    expect(rows.every((row) => !row.suggested && !row.suggestedKeep)).toBe(true);
    expect(retainedCopies(rows, new Set()).size).toBe(0);
  });

  it("正式 Worker 传递未选中的保留副本，清理成功后重新分组", async () => {
    const { service, request, files, scan } = maintenanceFixture();
    try {
      await scan();
      await service.change({ type: "select", choice: "suggested" });
      expect(service.getSnapshot()).toMatchObject({ selected: 1, unprotected: 0 });
      await service.remove(false);
      expect(request).toHaveBeenCalledWith(
        "library.maintenance.prepare",
        expect.objectContaining({
          id: "copy",
          requireRetainedCopy: true,
          retained: { id: "keep", path: "D:/合成/keep.mp4" },
        }),
      );
      expect(files.remove).toHaveBeenCalledExactlyOnceWith("D:/合成/copy.mp4");
      expect(service.getSnapshot()).toMatchObject({
        phase: "ready",
        total: 0,
        selected: 0,
        failures: [],
      });
    } finally {
      await service.shutdown();
    }
  });

  it("重复清理不能选中全部可用副本，明确报错且不执行文件删除", async () => {
    const { service, files, request, scan } = maintenanceFixture();
    try {
      await scan();
      await service.change({ type: "select", choice: "all" });
      expect(service.getSnapshot().unprotected).toBe(2);
      await service.remove(false);
      expect(service.getSnapshot().error).toContain("至少保留一个");
      expect(files.remove).not.toHaveBeenCalled();
      expect(request.mock.calls.some(([method]) => method === "library.maintenance.prepare")).toBe(
        false,
      );
    } finally {
      await service.shutdown();
    }
  });

  it("广告候选可以全部清理；清理后读取失败不显示为检查完成", async () => {
    const fixture = maintenanceFixture("ads");
    try {
      await fixture.scan();
      await fixture.service.change({ type: "select", choice: "all" });
      expect(fixture.service.getSnapshot().unprotected).toBe(0);
      fixture.failRefresh();
      await fixture.service.remove(false);
      expect(fixture.files.remove).toHaveBeenCalledTimes(2);
      expect(fixture.service.getSnapshot()).toMatchObject({ phase: "idle", error: "合成读取失败" });
    } finally {
      await fixture.service.shutdown();
    }
  });

  it("添加响应超时后仍读取后台状态并继续轮询扫描进度", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (method: string) => {
      if (method === "library.add") throw new Error("合成响应超时");
      if (method === "library.status")
        return {
          directories: [],
          revision: 1,
          databasePath: "fixture.sqlite3",
          scan: { state: "scanning" },
        };
      if (method === "library.summary") return { total: 0, favorites: 0 };
      return {};
    });
    const library = new LibraryService({
      request: request as LibraryPort["request"],
      mount: async () => () => undefined,
    });
    try {
      await expect(library.add({ path: "D:/合成", recursive: true, formats: [] })).rejects.toThrow(
        "合成响应超时",
      );
      expect(library.getSnapshot().scan?.state).toBe("scanning");
      await vi.advanceTimersByTimeAsync(500);
      expect(request.mock.calls.filter(([method]) => method === "library.status")).toHaveLength(2);
    } finally {
      await library.shutdown();
    }
  });
});
