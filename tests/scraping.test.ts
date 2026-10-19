/* oxlint-disable typescript/unbound-method -- 本文件引用的端口方法均为不依赖 this 的 vi.fn 测试桩。 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";
import { ScrapeService } from "../frontend/src/services/scraping/ScrapeService";
import type { ScrapePort, ScrapeProvider } from "../frontend/src/services/scraping/ScrapeService";
import type { ScrapeTask } from "../frontend/src/contracts/scraping";
import type { DownloadTask } from "../frontend/src/contracts/downloads";
import { defaultDownloadSettings } from "../frontend/src/contracts/downloads";
import { identifyCode, normalizeCode } from "../frontend/src/services/scraping/identity";
import { DownloadService } from "../frontend/src/services/downloads/DownloadService";
import { createDownloadTasks } from "../frontend/src/services/downloads/input";
import type { DownloadRepository } from "../frontend/src/services/downloads/ports";
import { MetaTubeService } from "../frontend/src/services/metadata/MetaTubeService";
import type { MovieDetails } from "../frontend/src/services/metadata/MetaTubeService";

const candidate = { provider: "Fixture", id: "001", code: "TEST-001", title: "虚构测试片" };
const details: MovieDetails = {
  ...candidate,
  homepage: "https://example.invalid/001",
  fields: { code: candidate.code, title: candidate.title, actors: ["虚构演员"], rating: 4 },
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function fixture(restored: ScrapeTask[] = []) {
  const records = new Map(restored.map((task) => [task.id, task]));
  const port: ScrapePort = {
    load: async (offset) => [...records.values()].slice(offset, offset + 100),
    save: vi.fn(async (task, expected) => {
      expect(records.get(task.id)?.revision ?? 0).toBe(expected);
      records.set(task.id, structuredClone(task));
    }),
    remove: async (task) => {
      records.delete(task.id);
    },
    prepare: vi.fn(async (task) => ({
      id: task.workId || "video-1",
      path: task.path || "",
      fileStamp: "stamp",
      code: "",
      title: "TEST-001",
      hasArtwork: false,
    })),
    artwork: vi.fn(async () => ({ path: "C:/fixture/cover.png", dispose: vi.fn(async () => {}) })),
    commit: vi.fn(async () => ({})),
    refresh: vi.fn(async () => {}),
  };
  const provider: ScrapeProvider = {
    search: vi.fn(async () => [candidate]),
    details: vi.fn(async () => details),
  };
  const service = new ScrapeService(port, provider);
  cleanups.push(() => service.shutdown());
  return { service, port, provider, records };
}
async function finished(service: ScrapeService, status: ScrapeTask["status"], index = 0) {
  await vi.waitFor(() => expect(service.getSnapshot().tasks[index]?.status).toBe(status), {
    interval: 5,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return service.getSnapshot().tasks[index]!;
}
const input = {
  urls: ["https://example.invalid/TEST-001.mp4"],
  directory: "C:/fixture",
  kind: "auto" as const,
  headers: {},
};

describe("MetaTube 基础刮削", () => {
  it("工具停止未确认时冻结队列，重试先完成清理", async () => {
    const { service, port } = fixture();
    const stop = vi.fn(async () => {});
    vi.mocked(port.artwork).mockRejectedValueOnce(new StopUnconfirmedError(stop));
    const first = await service.enqueue({ workId: "video-1", name: "TEST-001" });
    await service.enqueue({ workId: "video-2", name: "TEST-001" });
    await finished(service, "failed");
    expect(service.getSnapshot().error).toContain("尚未确认停止");
    expect(service.getSnapshot().tasks[1]?.status).toBe("queued");
    expect(port.commit).not.toHaveBeenCalled();
    await service.retry(first);
    await finished(service, "completed", 1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot().error).toBe("");
  });
  it("提取唯一番号并拒绝多作品文件名", () => {
    expect(identifyCode("[高清] TEST-001-C.mp4")).toBe("TEST-001");
    expect(identifyCode("FC2-PPV-1234567_C.mp4")).toBe("FC2-1234567");
    expect(normalizeCode("ＦＣ２ PPV 1234567")).toBe(normalizeCode("fc2-1234567"));
    expect(identifyCode("TEST-001 TEST-002.mp4")).toBeUndefined();
    expect(identifyCode("FC2-1234567 TEST-001.mp4")).toBeUndefined();
    expect(identifyCode("unknown-1080p.mp4")).toBeUndefined();
  });
  it("下载交接幂等，元数据、封面与保存按顺序完成", async () => {
    const { service, port, provider } = fixture();
    const download = { ...createDownloadTasks(input, [])[0]!, status: "completed" as const };
    const ids = await Promise.all([
      service.enqueueDownload(download),
      service.enqueueDownload(download),
    ]);
    expect(ids[0]).toBe(ids[1]);
    expect((await finished(service, "completed")).candidate).toEqual(candidate);
    expect(port.commit).toHaveBeenCalledTimes(1);
    expect(provider.search).toHaveBeenCalledWith("TEST-001", expect.any(AbortSignal), {
      taskId: ids[0],
    });
    expect(service.getSnapshot().tasks).toHaveLength(1);
  });
  it("封面失败仍保存资料并允许单独重试", async () => {
    const { service, port } = fixture();
    vi.mocked(port.artwork).mockRejectedValueOnce(new Error("网络超时"));
    const id = await service.enqueue({ workId: "video-1", name: "TEST-001" });
    expect((await finished(service, "partial")).error).toContain("网络超时");
    expect(port.commit).toHaveBeenCalledWith(expect.anything(), expect.anything(), details, "");
    await service.retry(id);
    await finished(service, "completed");
  });
  it("没有精确匹配时待确认，手动选择后继续", async () => {
    const { service, port, provider } = fixture();
    vi.mocked(provider.search).mockResolvedValue([]);
    const id = await service.enqueue({ workId: "video-1", name: "TEST-001" });
    await finished(service, "needsInput");
    expect(port.commit).not.toHaveBeenCalled();
    await service.retry(id, undefined, candidate);
    await finished(service, "completed");
  });
  it("详情身份不符时不落盘", async () => {
    const { service, port, provider } = fixture();
    vi.mocked(provider.details).mockResolvedValue({
      ...details,
      fields: { title: "另一作品", code: "TEST-002" },
    });
    await service.enqueue({ workId: "video-1", name: "TEST-001" });
    await finished(service, "needsInput");
    expect(port.commit).not.toHaveBeenCalled();
  });
  it("单并发、取消阻止迟到结果提交，下一个任务仍可完成", async () => {
    const { service, port, provider } = fixture();
    let release!: (value: (typeof candidate)[]) => void;
    vi.mocked(provider.search).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = await service.enqueue({ workId: "video-1", name: "TEST-001" });
    await service.enqueue({ workId: "video-2", name: "TEST-001" });
    await vi.waitFor(() => expect(provider.search).toHaveBeenCalledTimes(1));
    const cancelled = service.cancel(first);
    release([candidate]);
    await cancelled;
    await finished(service, "completed", 1);
    expect(service.getSnapshot().tasks[0]?.status).toBe("cancelled");
    expect(port.commit).toHaveBeenCalledTimes(1);
  });
  it("退出等待保存完成，重启后的在途任务标为中断", async () => {
    const { service, port } = fixture();
    let release!: () => void;
    vi.mocked(port.commit).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({});
        }),
    );
    await service.enqueue({ workId: "video-1", name: "TEST-001" });
    await vi.waitFor(() => expect(port.commit).toHaveBeenCalled());
    const stopping = service.shutdown();
    release();
    await stopping;
    const done = service.getSnapshot().tasks[0]!;
    expect(done.status).toBe("completed");
    const next = fixture([{ ...done, status: "running" }]);
    await next.service.initialize();
    expect(next.service.getSnapshot().tasks[0]?.status).toBe("interrupted");
    expect(next.provider.search).not.toHaveBeenCalled();
  });
  it("下载成功自动交接，刮削失败不回退下载或重复下载", async () => {
    const { service, provider } = fixture();
    vi.mocked(provider.search).mockRejectedValueOnce(new Error("来源离线"));
    const saved = new Map<string, DownloadTask>();
    const repository: DownloadRepository = {
      load: async () => ({
        tasks: [...saved.values()],
        settings: { ...defaultDownloadSettings, directory: input.directory },
      }),
      save: async (task, revision) => {
        expect(saved.get(task.id)?.revision ?? 0).toBe(revision);
        saved.set(task.id, structuredClone(task));
      },
      remove: async (id) => {
        saved.delete(id);
      },
      saveSettings: async () => {},
      close: async () => {},
    };
    const run = vi.fn(async () => {});
    const downloads = new DownloadService(repository, {
      defaultDirectory: async () => input.directory,
      outputSize: async () => 123,
      run,
      open: async () => {},
      checkTools: async () => [],
    });
    cleanups.push(() => downloads.shutdown());
    downloads.connectScraping(service.enqueueDownload);
    await downloads.initialize();
    await downloads.add(input);
    const failed = await finished(service, "failed");
    await vi.waitFor(() => expect(downloads.getSnapshot().tasks[0]?.scrapeTaskId).toBe(failed.id));
    expect(downloads.getSnapshot().tasks[0]?.status).toBe("completed");
    await service.retry(failed.id);
    await finished(service, "completed");
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("恢复已完成下载的遗漏交接，同时跳过历史下载", async () => {
    const tasks = createDownloadTasks(
      { ...input, urls: [...input.urls, "https://example.invalid/old.mp4"] },
      [],
    ).map((task, index) => ({
      ...task,
      revision: 1,
      status: "completed" as const,
      scrapeAfterDownload: index === 0,
    }));
    const repository: DownloadRepository = {
      load: async () => ({ tasks, settings: defaultDownloadSettings }),
      save: async () => {},
      remove: async () => {},
      saveSettings: async () => {},
      close: async () => {},
    };
    const run = vi.fn(async () => {});
    const downloads = new DownloadService(repository, {
      defaultDirectory: async () => input.directory,
      outputSize: async () => 123,
      run,
      open: async () => {},
      checkTools: async () => [],
    });
    cleanups.push(() => downloads.shutdown());
    const handoff = vi.fn(async () => "scrape-task");
    downloads.connectScraping(handoff);
    await downloads.initialize();
    await vi.waitFor(() =>
      expect(downloads.getSnapshot().tasks[0]?.scrapeTaskId).toBe("scrape-task"),
    );
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("MetaTube 前后台查询", () => {
  it("多个 provider 分别请求，取消搜索不影响后台刮削", async () => {
    const urls: string[] = [];
    let backgroundSignal: AbortSignal | undefined;
    let finish!: () => void;
    const service = new MetaTubeService(
      { read: async () => ({ providers: ["Fixture", "Second"] }), write: async () => {} },
      async (request, signal) => {
        const url = new URL(request.url);
        urls.push(request.url);
        if (url.pathname.endsWith("/providers"))
          return { data: { movie_providers: { Fixture: {}, Second: {} } } };
        if (url.pathname.endsWith("/db/version")) return { data: 1 };
        if (url.searchParams.get("q") === "background") {
          backgroundSignal = signal;
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        }
        if (url.searchParams.get("q") === "foreground")
          await new Promise<void>((_, reject) =>
            signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
          );
        return {
          data: [
            {
              provider: url.searchParams.get("provider"),
              id: "001",
              number: "TEST-001",
              title: "虚构测试片",
            },
          ],
        };
      },
      {
        bundled: async () => ({ path: "fixture", version: "v1.4.0" }),
        start: async () => ({
          endpoint: "http://127.0.0.1:1234",
          token: "test",
          exited: new Promise(() => {}),
          stop: async () => {},
        }),
      },
      true,
    );
    cleanups.push(() => service.shutdown());
    // 先验证两个配置来源不会被拼为一个逗号分隔的 provider。
    expect(await service.search("test")).toHaveLength(2);
    expect(
      urls
        .filter((url) => url.includes("movies/search"))
        .map((url) => new URL(url).searchParams.get("provider")),
    ).toEqual(["Fixture", "Second"]);
    await service.save({ providers: ["Fixture"] });
    const background = service.search("background", new AbortController().signal);
    await vi.waitFor(() => expect(backgroundSignal).toBeDefined());
    const foreground = service.search("foreground").catch((error: unknown) => error);
    await vi.waitFor(() => expect(urls.some((url) => url.includes("q=foreground"))).toBe(true));
    service.cancel();
    expect(await foreground).toBeInstanceOf(Error);
    expect(backgroundSignal!.aborted).toBe(false);
    finish();
    expect(await background).toHaveLength(1);
  });
});
