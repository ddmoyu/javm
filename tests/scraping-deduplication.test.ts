/* oxlint-disable typescript/unbound-method -- 端口方法均为不依赖 this 的测试桩。 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ScrapeTask } from "../frontend/src/contracts/scraping";
import type { MovieCandidate } from "../frontend/src/services/metadata/MetaTubeService";
import { createDownloadTasks } from "../frontend/src/services/downloads/input";
import { ScrapeService } from "../frontend/src/services/scraping/ScrapeService";
import type { ScrapePort, ScrapeProvider } from "../frontend/src/services/scraping/ScrapeService";

const candidate = {
  provider: "SafeFixture",
  id: "001",
  code: "SAFE-001",
  title: "虚构自然纪录片",
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function record(id: string, patch: Partial<ScrapeTask> = {}): ScrapeTask {
  return {
    id,
    revision: 1,
    name: candidate.title,
    workId: "work-1",
    status: "failed",
    phase: "details",
    query: candidate.code,
    error: "安全模拟失败",
    createdAt: "2026-10-10T01:00:00.000Z",
    updatedAt: "2026-10-10T01:00:00.000Z",
    ...patch,
  };
}
function fixture(restored: ScrapeTask[] = []) {
  const records = new Map(restored.map((task) => [task.id, structuredClone(task)]));
  const port: ScrapePort = {
    load: async (offset) => [...records.values()].slice(offset, offset + 100),
    save: vi.fn(async (task, expectedRevision) => {
      expect(records.get(task.id)?.revision ?? 0).toBe(expectedRevision);
      records.set(task.id, structuredClone(task));
    }),
    remove: vi.fn(async (task) => {
      expect(records.get(task.id)?.revision).toBe(task.revision);
      records.delete(task.id);
    }),
    prepare: vi.fn(async (task) => ({
      id: task.workId || "work-1",
      path: task.path || "",
      fileStamp: "safe-stamp",
      code: candidate.code,
      title: candidate.title,
      hasArtwork: true,
    })),
    artwork: vi.fn(async () => ({ path: "", dispose: async () => {} })),
    commit: vi.fn(async () => ({})),
    refresh: vi.fn(async () => {}),
  };
  const provider: ScrapeProvider = {
    search: vi.fn(async () => [candidate]),
    details: vi.fn(async (selected) => ({
      ...selected,
      fields: { code: selected.code, title: selected.title },
      homepage: "https://example.invalid/safe",
    })),
  };
  const service = new ScrapeService(port, provider);
  cleanups.push(() => service.shutdown());
  return { service, records, port, provider };
}
async function settled(service: ScrapeService, status: ScrapeTask["status"]) {
  await vi.waitFor(() => expect(service.getSnapshot().tasks[0]?.status).toBe(status), {
    interval: 5,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
function hold<T>(signal: AbortSignal) {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  return { promise, release };
}

describe("同一视频的刮削任务复用", () => {
  it("批量移除只清理结束记录，去重并保留排队任务及失败项", async () => {
    const { service, records, port, provider } = fixture([
      record("done", { workId: "done", status: "completed" }),
      record("failed", { workId: "failed" }),
      record("queued", { workId: "queued", status: "queued" }),
      record("write-error", { workId: "write-error" }),
    ]);
    service.pauseQueue(true);
    await service.retry("queued");
    const originalRemove = vi.mocked(port.remove).getMockImplementation()!;
    vi.mocked(port.remove).mockImplementation(async (task) => {
      if (task.id === "write-error") throw new Error("安全模拟存储失败");
      await originalRemove(task);
    });
    const result = await service.removeMany(["done", "done", "queued", "write-error", "failed"]);
    expect(result).toMatchObject({ removed: 2, retained: 2 });
    expect(result.error).not.toBe("");
    expect([...records.keys()].sort()).toEqual(["queued", "write-error"]);
    expect(provider.search).not.toHaveBeenCalled();
    expect(port.commit).not.toHaveBeenCalled();
  });
  it("移除失败记录逐条复核状态，保留已恢复成功的任务", async () => {
    const { service, records } = fixture([
      record("done", { workId: "done", status: "completed" }),
      record("failed", { workId: "failed" }),
    ]);
    expect(await service.removeMany(["done", "failed"], { onlyFailed: true })).toEqual({
      removed: 1,
      retained: 1,
      error: "",
    });
    expect([...records.keys()]).toEqual(["done"]);
  });
  it("停止批量移除后保留未处理记录并报告进度", async () => {
    const { service, records } = fixture(
      Array.from({ length: 45 }, (_, i) => record(`safe-${i}`, { workId: `safe-${i}` })),
    );
    const abort = new AbortController();
    const progress = vi.fn(() => abort.abort());
    const result = await service.removeMany([...records.keys()], {
      signal: abort.signal,
      onProgress: progress,
    });
    expect(result).toEqual({ removed: 20, retained: 25, error: "" });
    expect(progress).toHaveBeenLastCalledWith(20, 45);
    expect(records.size).toBe(25);
  });
  it("并发添加二十次只创建一行，运行中再次添加不重置阶段或重复请求", async () => {
    const { service, records, port, provider } = fixture();
    service.pauseQueue(true);
    const input = { workId: "work-1", name: candidate.title };
    const ids = await Promise.all(Array.from({ length: 20 }, () => service.enqueue(input)));
    expect(new Set(ids).size).toBe(1);
    expect(records.size).toBe(1);
    expect(port.save).toHaveBeenCalledTimes(1);
    let gate!: ReturnType<typeof hold<MovieCandidate[]>>;
    vi.mocked(provider.search).mockImplementationOnce((_, signal) => {
      gate = hold(signal);
      return gate.promise;
    });
    service.pauseQueue(false);
    await vi.waitFor(() => expect(provider.search).toHaveBeenCalledTimes(1));
    const revision = records.get(ids[0]!)!.revision;
    expect(await service.enqueue(input)).toBe(ids[0]);
    await service.retry(ids[0]!);
    expect(records.get(ids[0]!)!.revision).toBe(revision);
    expect(records.get(ids[0]!)!.phase).toBe("search");
    gate.release([candidate]);
    await settled(service, "completed");
    expect(port.commit).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "partial", "needsInput", "cancelled", "interrupted", "completed"] as const)(
    "%s 任务重新添加在原行排队，保留 ID、创建时间和已确认资料",
    async (status) => {
      const original = record("original", { status, candidate });
      const { service, records, port } = fixture([original]);
      service.pauseQueue(true);
      const id = await service.enqueue({ workId: "work-1", name: candidate.title });
      expect(id).toBe(original.id);
      expect(records.size).toBe(1);
      expect(records.get(id)).toMatchObject({
        id,
        createdAt: original.createdAt,
        revision: 2,
        status: "queued",
        phase: "prepare",
        error: "",
        candidate,
      });
      service.pauseQueue(false);
      await settled(service, "completed");
      expect(port.commit).toHaveBeenCalledTimes(1);
    },
  );

  it("真实模拟资料请求失败后重新添加，只重试一次且不增加历史行", async () => {
    const { service, records, provider, port } = fixture();
    vi.mocked(provider.details).mockRejectedValueOnce(new Error("安全模拟离线"));
    const input = { workId: "work-1", name: candidate.title };
    const id = await service.enqueue(input);
    await settled(service, "failed");
    expect(await service.enqueue(input)).toBe(id);
    await settled(service, "completed");
    expect(records.size).toBe(1);
    expect(provider.details).toHaveBeenCalledTimes(2);
    expect(port.commit).toHaveBeenCalledTimes(1);
  });

  it("恢复时合并重复历史并保留最近尝试，在途任务仍须手动恢复", async () => {
    const { service, records, port } = fixture([
      record("first"),
      record("second", {
        status: "running",
        candidate,
        createdAt: "2026-10-10T02:00:00.000Z",
        updatedAt: "2026-10-10T02:01:00.000Z",
      }),
      record("different-work", { workId: "work-2" }),
    ]);
    await service.initialize();
    expect(service.getSnapshot().error).toBe("");
    expect(records.size).toBe(2);
    expect(records.get("first")).toMatchObject({ status: "interrupted", candidate });
    expect(records.has("second")).toBe(false);
    expect(port.prepare).not.toHaveBeenCalled();
    const restarted = fixture([...records.values()]);
    await restarted.service.initialize();
    expect(restarted.records.size).toBe(2);
    expect(restarted.port.remove).not.toHaveBeenCalled();
    await restarted.service.retry("first");
    await settled(restarted.service, "completed");
    expect(restarted.port.commit).toHaveBeenCalledTimes(1);
  });

  it("文件路径忽略 Windows 大小写与斜杠，同作品的不同视频及纯资料任务保持独立", async () => {
    const { service, records } = fixture([
      record("file", { path: "C:\\SafeFixture\\SAFE-001.mp4" }),
      record("same-file", { path: "c:/safefixture/safe-001.mp4" }),
      record("other-file", { path: "C:/SafeFixture/SAFE-001-part2.mp4" }),
      record("metadata"),
    ]);
    service.pauseQueue(true);
    await service.initialize();
    expect(records.size).toBe(3);
    expect(
      await service.enqueue({ path: "c:/SAFEFIXTURE/SAFE-001.mp4", name: candidate.title }),
    ).toBe("file");
    expect(await service.enqueue({ workId: "work-1", name: candidate.title })).toBe("metadata");
    expect(records.size).toBe(3);
  });

  it("恢复记录中后来确认的作品身份可连接两组历史，最终只保留一行", async () => {
    const { service, records } = fixture([
      record("work-only"),
      record("source-only", { workId: undefined, candidate }),
      record("resolved", {
        candidate,
        status: "completed",
        updatedAt: "2026-10-10T02:00:00.000Z",
      }),
    ]);
    await service.initialize();
    expect([...records.keys()]).toEqual(["work-only"]);
    expect(records.get("work-only")).toMatchObject({ status: "completed", candidate });
  });

  it("同一规范番号的来源候选共用任务，明确不同作品 ID 和仅同名的候选不合并", async () => {
    const { service } = fixture();
    service.pauseQueue(true);
    const first = await service.enqueue({ name: candidate.title, candidate, collect: true });
    expect(
      await service.enqueue({
        name: candidate.title,
        candidate: { ...candidate, provider: "SecondFixture", code: "ｓａｆｅ＿００１" },
        collect: true,
      }),
    ).toBe(first);
    expect(
      await service.enqueue({
        name: candidate.title,
        candidate: { ...candidate, id: "002", code: "SAFE-002" },
      }),
    ).not.toBe(first);
    const separate = fixture([
      record("first-work", { workId: "work-1", candidate }),
      record("second-work", { workId: "work-2", candidate }),
    ]);
    await separate.service.initialize();
    expect(separate.records.size).toBe(2);
  });

  it.each(["completed", "failed"] as const)(
    "下载重复交接复用 %s 的原记录，不自动重新刮削",
    async (status) => {
      const download = createDownloadTasks(
        {
          urls: ["https://example.invalid/SAFE-001.mp4"],
          directory: "C:/SafeFixture",
          kind: "auto",
          headers: {},
        },
        [],
      )[0]!;
      const { service, records, port } = fixture([
        record("download-scrape", { status, downloadId: download.id, path: download.output }),
      ]);
      expect(await service.enqueueDownload(download)).toBe("download-scrape");
      expect(
        await service.enqueueDownload({ ...download, id: "another-handoff-for-the-same-file" }),
      ).toBe("download-scrape");
      expect(records.size).toBe(1);
      expect(records.get("download-scrape")?.status).toBe(status);
      expect(port.prepare).not.toHaveBeenCalled();
    },
  );

  it("来源候选准备后确认同一作品，吸收另一入口的排队任务并只提交一次", async () => {
    const { service, records, port } = fixture();
    service.pauseQueue(true);
    const first = await service.enqueue({ name: candidate.title, candidate, collect: true });
    await service.enqueue({ name: candidate.title, workId: "work-1" });
    expect(records.size).toBe(2);
    service.pauseQueue(false);
    await settled(service, "completed");
    expect([...records.keys()]).toEqual([first]);
    expect(port.commit).toHaveBeenCalledTimes(1);
    expect(port.prepare).toHaveBeenCalledTimes(1);
  });

  it("手动匹配到正在执行的作品时复用运行任务，不删运行记录或再次执行", async () => {
    const { service, records, provider, port } = fixture([
      record("unmatched", {
        workId: undefined,
        candidate: { ...candidate, id: "002", code: "SAFE-002" },
      }),
    ]);
    let gate!: ReturnType<typeof hold<Awaited<ReturnType<ScrapeProvider["details"]>>>>;
    vi.mocked(provider.details).mockImplementationOnce((_, signal) => {
      gate = hold(signal);
      return gate.promise;
    });
    const running = await service.enqueue({ name: candidate.title, candidate });
    await vi.waitFor(() => expect(provider.details).toHaveBeenCalledTimes(1));
    await service.retry("unmatched", undefined, candidate);
    expect([...records.keys()]).toEqual([running]);
    gate.release({
      ...candidate,
      fields: { title: candidate.title, code: candidate.code },
      homepage: "https://example.invalid/safe",
    });
    await settled(service, "completed");
    expect(port.commit).toHaveBeenCalledTimes(1);
  });

  it("运行中合入收藏意图也会保存，网络资料和图片不重新读取", async () => {
    const { service, records, provider, port } = fixture();
    let gate!: ReturnType<typeof hold<MovieCandidate[]>>;
    vi.mocked(provider.search).mockImplementationOnce((_, signal) => {
      gate = hold(signal);
      return gate.promise;
    });
    const first = await service.enqueue({ name: candidate.title, workId: "work-1" });
    await vi.waitFor(() => expect(provider.search).toHaveBeenCalledTimes(1));
    await service.enqueue({ name: candidate.title, candidate, collect: true });
    gate.release([candidate]);
    await settled(service, "completed");
    expect([...records.keys()]).toEqual([first]);
    expect(records.get(first)?.collect).toBe(true);
    expect(port.prepare).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: first, workId: "work-1", collect: true }),
      expect.any(AbortSignal),
    );
    expect(provider.search).toHaveBeenCalledTimes(1);
    expect(provider.details).toHaveBeenCalledTimes(1);
    expect(port.commit).toHaveBeenCalledTimes(1);
  });

  it("取消后的清理尚未完成时再次添加给出等待提示，不创建新行或重置状态", async () => {
    const { service, records, provider, port } = fixture();
    vi.mocked(provider.search).mockImplementationOnce(
      (_, signal) => hold<MovieCandidate[]>(signal).promise,
    );
    let release!: () => void;
    vi.mocked(port.refresh).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const input = { workId: "work-1", name: candidate.title };
    const id = await service.enqueue(input);
    await vi.waitFor(() => expect(provider.search).toHaveBeenCalledTimes(1));
    const cancelled = service.cancel(id);
    try {
      await vi.waitFor(() => expect(port.refresh).toHaveBeenCalledTimes(1));
      await expect(service.enqueue(input)).rejects.toThrow("正在收尾");
      expect(records.size).toBe(1);
      expect(records.get(id)?.status).toBe("cancelled");
    } finally {
      release();
      await cancelled;
    }
    await settled(service, "cancelled");
    expect(await service.enqueue(input)).toBe(id);
    await settled(service, "completed");
  });

  it("合并时删除失败先保留完整结果，重启可继续清理而不丢最近状态", async () => {
    const { service, records, port } = fixture([
      record("first"),
      record("second", { status: "completed", updatedAt: "2026-10-10T02:00:00.000Z" }),
    ]);
    vi.mocked(port.remove).mockRejectedValueOnce(new Error("安全模拟写入中断"));
    await service.initialize();
    expect(service.getSnapshot().error).toContain("写入中断");
    expect(records.size).toBe(2);
    expect(records.get("first")?.status).toBe("completed");
    expect(port.prepare).not.toHaveBeenCalled();
    const restarted = fixture([...records.values()]);
    await restarted.service.initialize();
    expect(restarted.records.size).toBe(1);
    expect(restarted.records.get("first")?.status).toBe("completed");
    expect(restarted.service.getSnapshot().error).toBe("");
  });

  it("合并结果写入失败时不删除任何原记录", async () => {
    const { service, records, port } = fixture([record("first"), record("second")]);
    vi.mocked(port.save).mockRejectedValueOnce(new Error("安全模拟写入失败"));
    await service.initialize();
    expect(service.getSnapshot().error).toContain("写入失败");
    expect(records.size).toBe(2);
    expect(port.remove).not.toHaveBeenCalled();
  });

  it("达到任务上限时仍可原行重试，只有新视频被上限拒绝", async () => {
    const { service, records } = fixture(
      Array.from({ length: 1000 }, (_, index) =>
        record(`task-${index}`, { workId: `work-${index}` }),
      ),
    );
    service.pauseQueue(true);
    expect(await service.enqueue({ workId: "work-0", name: candidate.title })).toBe("task-0");
    expect(records.size).toBe(1000);
    await expect(service.enqueue({ workId: "new-work", name: candidate.title })).rejects.toThrow(
      "最多保留 1000",
    );
  });
});
