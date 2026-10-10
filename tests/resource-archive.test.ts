import { describe, expect, it, vi } from "vite-plus/test";
import { ResourceSearchService } from "../frontend/src/services/streamResolution/ResourceSearchService";
import type { ResolutionService } from "../frontend/src/services/streamResolution/ResolutionService";
import type { ResolutionOutcome, ResolvedStream } from "../frontend/src/contracts/streamResolution";
import type {
  ResourceArchive,
  SavedResource,
} from "../frontend/src/services/streamResolution/archive";

const base = "https://safe.example.invalid";
export const safeStream: ResolvedStream = {
  pageUrl: `${base}/player`,
  manifestUrl: `${base}/stream.m3u8`,
  tracks: [{ kind: "video", url: `${base}/stream.m3u8`, duration: 60, height: 720 }],
  checkedAt: 1,
  expiresAt: 2,
  validation: "playlist-and-sample",
  discoveredBy: "webview",
  context: {
    origin: base,
    headers: { cookie: "fixture-private" },
    publicHeaders: { referer: `${base}/player` },
  },
};
const record: SavedResource = {
  id: "saved-1",
  code: "SAFE-001",
  sourceId: "safe",
  sourceName: "虚构来源",
  savedAt: 1,
  stream: safeStream,
};
const source = { id: "safe", name: "虚构来源", template: `${base}/{code}` };
function fixture() {
  let outcome: ResolutionOutcome = { ok: true, streams: [safeStream] };
  const submit = vi.fn(() => ({
    id: crypto.randomUUID(),
    result: Promise.resolve(outcome),
    cancel() {},
  }));
  const resolution = {
    subscribe: () => () => {},
    getSnapshot: () => ({ webviewAvailable: true, cleanupPending: 0, tasks: [] }),
    submit,
  } as unknown as ResolutionService;
  const archive: ResourceArchive = {
    read: vi.fn(async () => [record]),
    save: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    readPreferences: async () => ({
      query: "SAFE-001",
      code: "SAFE-001",
      selected: ["safe"],
      filter: "found",
    }),
    writePreferences: vi.fn(async () => {}),
  };
  const add = vi.fn(async () => 1);
  const service = new ResourceSearchService(
    resolution,
    { add, directory: () => "fixture" },
    [source],
    archive,
  );
  return {
    service,
    archive,
    submit,
    add,
    fail: () => {
      outcome = { ok: false, code: "not_found", message: "链接已失效", fallbackEligible: false };
    },
  };
}
describe("资源归档闭环（安全 mock）", () => {
  it("恢复查询与候选不触发网络，复制前重新检查并清除私密请求头", async () => {
    const f = fixture();
    try {
      await f.service.initialize();
      expect(f.submit).not.toHaveBeenCalled();
      expect(f.service.getSnapshot()).toMatchObject({
        query: "SAFE-001",
        filter: "found",
        restoring: false,
      });
      expect(await f.service.copyResult("safe")).toBe(safeStream.manifestUrl);
      expect(f.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "direct-hls",
          publicHeaders: safeStream.context.publicHeaders,
        }),
      );
      expect(f.archive.save).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: expect.objectContaining({ context: expect.objectContaining({ headers: {} }) }),
        }),
      );
      f.service.setQuery("SAFE-002");
    } finally {
      await f.service.shutdown();
    }
    expect(f.archive.writePreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "SAFE-002" }),
    );
  });
  it("失效候选不交给下载器，也不覆盖历史；允许移除候选", async () => {
    const f = fixture();
    try {
      await f.service.initialize();
      f.fail();
      await expect(f.service.useSaved(record, "download", "work-safe")).rejects.toThrow(
        "链接已失效",
      );
      expect(f.add).not.toHaveBeenCalled();
      expect(f.archive.save).not.toHaveBeenCalled();
      await f.service.removeSaved(record.id);
      expect(f.archive.remove).toHaveBeenCalledWith(record.id);
    } finally {
      await f.service.shutdown();
    }
  });
  it("异步归档使用任务开始时的番号与作品，不被下一次查询覆盖", async () => {
    const f = fixture();
    try {
      await f.service.initialize();
      f.service.search("SAFE-002", "work-2");
      await vi.waitFor(() => expect(f.archive.save).toHaveBeenCalled());
      f.service.search("SAFE-003", "work-3");
      await vi.waitFor(() => expect(f.archive.save).toHaveBeenCalledTimes(2));
      expect(f.archive.save).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ code: "SAFE-002", workId: "work-2" }),
      );
      expect(f.archive.save).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ code: "SAFE-003", workId: "work-3" }),
      );
    } finally {
      await f.service.shutdown();
    }
  });
});
