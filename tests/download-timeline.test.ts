import { afterEach, describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import type { DownloadTask } from "../frontend/src/contracts/downloads";
import type { ScrapeTask } from "../frontend/src/contracts/scraping";
import { DownloadTimeline } from "../frontend/src/features/downloads/DownloadTimeline";
import { createDownloadScrapeLookup } from "../frontend/src/features/downloads/downloadScrapes";
import { createDownloadTasks } from "../frontend/src/services/downloads/input";
import { ScrapeService } from "../frontend/src/services/scraping/ScrapeService";
import type { ScrapePort } from "../frontend/src/services/scraping/ScrapeService";

const download: DownloadTask = {
  ...createDownloadTasks(
    {
      name: "虚构自然纪录片",
      urls: ["https://example.invalid/SAFE-001.mp4"],
      directory: "C:/SafeFixture",
      kind: "http",
      headers: {},
    },
    [],
  )[0]!,
  status: "completed",
  phase: "merge",
  scrapeTaskId: "reused-scrape",
};
const record = (patch: Partial<ScrapeTask> = {}): ScrapeTask => ({
  id: "reused-scrape",
  revision: 1,
  name: download.name,
  path: download.output,
  status: "running",
  phase: "details",
  error: "",
  createdAt: "2026-10-13T01:00:00.000Z",
  updatedAt: "2026-10-13T01:00:00.000Z",
  ...patch,
});
const queue = { ready: true, available: true, paused: false, error: "" };
const render = (scrape: ScrapeTask | undefined, state = queue) =>
  renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(DownloadTimeline, { task: download, scrape, queue: state }),
    ),
  );
const services: ScrapeService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
});
function fixture(task: ScrapeTask, failSave = false) {
  const records = new Map([[task.id, task]]);
  const unexpected = async () => {
    throw new Error("安全样例不应执行实际刮削");
  };
  const port: ScrapePort = {
    load: async () => [...records.values()],
    save: async (next) => {
      if (failSave) throw new Error("安全模拟状态写入失败");
      records.set(next.id, next);
    },
    remove: async (removed) => {
      records.delete(removed.id);
    },
    prepare: unexpected,
    artwork: unexpected,
    commit: unexpected,
    refresh: async () => {},
  };
  const service = new ScrapeService(port, { search: unexpected, details: unexpected });
  service.pauseQueue(true);
  services.push(service);
  return { service, records };
}

describe("下载时间轴的异常状态与刮削关联", () => {
  it("恢复时状态写入失败，残留运行快照显示待确认和服务错误", async () => {
    const { service } = fixture(record(), true);
    await service.initialize();
    const state = service.getSnapshot();
    const scrape = createDownloadScrapeLookup(state.tasks)(download);
    expect(scrape?.status).toBe("running");
    const html = render(scrape, state);
    expect(html).toContain("状态待确认");
    expect(html).toContain("安全模拟状态写入失败");
    expect(html).toContain("最后记录阶段：读取资料");
    expect(html).not.toContain("刮削中");
    expect(html).not.toContain('aria-current="step"');
  });

  it("排队任务显示阻止调度的服务错误", () => {
    const html = render(record({ status: "queued", phase: "prepare" }), {
      ...queue,
      error: "安全模拟队列异常",
    });
    expect(html).toContain("队列异常");
    expect(html).toContain("安全模拟队列异常");
    expect(html).not.toContain("等待刮削");
  });

  it("其他任务的队列异常不覆盖已经完成的刮削结果", () => {
    const html = render(record({ status: "completed", phase: "save" }), {
      ...queue,
      error: "安全模拟其他任务失败",
    });
    expect(html).toContain("刮削完成");
    expect(html).not.toContain("状态待确认");
    expect(html).not.toContain("安全模拟其他任务失败");
  });

  it("暂停队列时当前任务仍显示正在执行", () => {
    const html = render(record(), { ...queue, paused: true });
    expect(html).toContain("刮削中");
    expect(html).toContain('aria-current="step"');
    expect(html).not.toContain("队列已暂停");
  });

  it("复用没有当前下载标识的失败记录后，可按关联标识原行重试", async () => {
    const { service, records } = fixture(record({ status: "failed", error: "安全模拟资料失败" }));
    await service.initialize();
    const scrape = createDownloadScrapeLookup(service.getSnapshot().tasks)(download)!;
    expect(scrape.downloadId).toBeUndefined();
    expect(scrape.status).toBe("failed");
    expect(render(scrape)).toContain("刮削失败");
    await service.retry(scrape.id);
    expect(records.size).toBe(1);
    expect(records.get(scrape.id)).toMatchObject({ status: "queued", phase: "prepare", error: "" });
  });

  it("合并后的下载关联记录优先于旧的刮削标识", () => {
    const stale = record({ status: "failed" });
    const merged = record({ id: "merged-scrape", downloadId: download.id, status: "completed" });
    expect(createDownloadScrapeLookup([stale, merged])(download)).toBe(merged);
  });

  it("关联记录缺失时不使用其他任务的状态", () => {
    const unrelated = record({ id: "unrelated", downloadId: "another-download" });
    const scrape = createDownloadScrapeLookup([unrelated])(download);
    expect(scrape).toBeUndefined();
    expect(render(scrape)).toContain("记录不可用");
  });
});
