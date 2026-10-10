/* oxlint-disable typescript/unbound-method -- ports use this-free test functions. */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ScrapeService } from "../frontend/src/services/scraping/ScrapeService";
import type { ScrapePort } from "../frontend/src/services/scraping/ScrapeService";
import { createDownloadTasks } from "../frontend/src/services/downloads/input";
import { MetaTubeService } from "../frontend/src/services/metadata/MetaTubeService";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";
import type { ScrapeTask } from "../frontend/src/contracts/scraping";

const candidate = { provider: "Fixture", id: "001", code: "TEST-001", title: "合成资料" };
const workId = "aabbccdd-0000-4000-8000-000000000001";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function fixture() {
  const records = new Map<string, ScrapeTask>();
  const port: ScrapePort = {
    load: async () => [],
    remove: async () => {},
    save: async (task) => {
      records.set(task.id, structuredClone(task));
    },
    prepare: vi.fn(async (task) => ({
      id: task.workId || workId,
      path: task.path || "",
      fileStamp: "",
      nfoStamp: "",
      code: "TEST-001",
      title: candidate.title,
      hasArtwork: true,
    })),
    artwork: vi.fn(async () => ({ path: "", dispose: async () => {} })),
    commit: vi.fn(async () => ({})),
    refresh: async () => {},
  };
  const provider = {
    search: vi.fn(async () => [candidate]),
    details: vi.fn(async () => ({
      ...candidate,
      homepage: "https://example.invalid/001",
      fields: { code: candidate.code, title: candidate.title },
    })),
  };
  const service = new ScrapeService(port, provider);
  cleanups.push(() => service.shutdown());
  return { service, port, provider, records };
}

describe("资料优先刮削调度", () => {
  it("只有来源候选即可收藏刮削，不生成视频路径，保存后记录作品身份", async () => {
    const { service, port, provider, records } = fixture();
    const id = await service.enqueue({ name: candidate.title, candidate, collect: true });
    await vi.waitFor(() => expect(records.get(id)?.status).toBe("completed"));
    expect(port.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ candidate, collect: true }),
      expect.any(AbortSignal),
    );
    expect(provider.search).not.toHaveBeenCalled();
    expect(records.get(id)).toMatchObject({ workId, path: "" });
    expect(port.commit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: workId, path: "" }),
      expect.anything(),
      "",
    );
  });
  it("关联下载保留 workId，完成交接及重复回调复用同一任务", async () => {
    const { service, port } = fixture();
    const download = createDownloadTasks(
      {
        workId,
        urls: ["https://example.invalid/resource.mp4"],
        directory: "C:/fixture",
        kind: "auto",
        headers: {},
      },
      [],
    )[0]!;
    expect(download.workId).toBe(workId);
    const first = await service.enqueueDownload(download);
    expect(await service.enqueueDownload(download)).toBe(first);
    await vi.waitFor(() => expect(port.commit).toHaveBeenCalled());
    expect(port.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ workId, path: download.output }),
      expect.any(AbortSignal),
    );
  });
  it("相同候选在排队时幂等；不同来源候选保持独立任务", async () => {
    const { service } = fixture();
    await service.initialize();
    service.pauseQueue(true);
    const first = await service.enqueue({ candidate, name: candidate.title, collect: true });
    expect(await service.enqueue({ candidate, name: candidate.title, collect: true })).toBe(first);
    expect(
      await service.enqueue({
        candidate: { ...candidate, provider: "Second" },
        name: candidate.title,
      }),
    ).not.toBe(first);
  });
  it("MetaTube 搜索在取消时仍传播未确认停止，保留清理回调", async () => {
    const abort = new AbortController();
    const stop = new StopUnconfirmedError(async () => {});
    const service = new MetaTubeService(
      { read: async () => ({ providers: ["Fixture"] }), write: async () => {} },
      async (request) => {
        if (request.url.includes("/providers"))
          return { data: { movie_providers: { Fixture: {} } } };
        if (request.url.includes("/db/version")) return { data: 1 };
        abort.abort();
        throw stop;
      },
      {
        bundled: async () => ({ path: "fixture", version: "v1.4.0" }),
        start: async () => ({
          endpoint: "http://127.0.0.1:8080",
          token: "fixture",
          exited: new Promise<void>(() => {}),
          stop: async () => {},
        }),
      },
      true,
    );
    cleanups.push(() => service.shutdown());
    await expect(service.search("TEST-001", abort.signal)).rejects.toBe(stop);
  });
});
