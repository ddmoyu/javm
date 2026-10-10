import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LegacyImportService } from "../frontend/src/services/library/LegacyImportService";
import type { LegacyImportSnapshot } from "../frontend/src/contracts/legacyImport";
import { deferred } from "./helpers/deferred";

const candidate: LegacyImportSnapshot = {
  state: "available",
  sourcePath: "C:/synthetic/old.db",
  currentVideos: 12,
};
afterEach(() => vi.useRealTimers());

describe("旧库导入引导状态", () => {
  it("初始化去重，稍后导入只关闭本次引导，浏览器预览不连接数据库", async () => {
    const request = vi.fn(async () => candidate);
    const service = new LegacyImportService({ request: request as never });
    await Promise.all([service.initialize(), service.initialize()]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot().opened).toBe(true);
    service.dismiss();
    expect(service.getSnapshot()).toMatchObject({ opened: false, state: "available" });
    const browser = new LegacyImportService();
    await browser.initialize();
    expect(browser.getSnapshot()).toMatchObject({ state: "none", opened: false });
  });
  it("请求已受理但响应丢失时读取后台状态，不重复提交；完成后刷新片库", async () => {
    vi.useFakeTimers();
    let state: LegacyImportSnapshot = {
      state: "running",
      phase: "importing",
      total: 100,
      processed: 30,
    };
    const request = vi.fn(async (method: string) => {
      if (method.endsWith("check")) return candidate;
      if (method.endsWith("start")) throw new Error("响应暂时丢失");
      return state;
    });
    const refresh = vi.fn(async () => {});
    const service = new LegacyImportService({ request: request as never }, refresh);
    await service.initialize();
    await service.start();
    service.dismiss();
    expect(service.getSnapshot()).toMatchObject({ state: "running", opened: true, error: "" });
    await service.start();
    expect(request.mock.calls.filter(([method]) => method.endsWith("start"))).toHaveLength(1);
    state = { state: "completed", backupPath: "C:/synthetic/backup.db" };
    await vi.advanceTimersByTimeAsync(500);
    expect(service.getSnapshot().state).toBe("completed");
    expect(refresh).toHaveBeenCalledTimes(1);
    service.dismiss();
    expect(service.getSnapshot().opened).toBe(false);
    await service.shutdown();
  });
  it("开始请求尚未完成时取消，待受理后发送取消，避免原生任务重置取消标记", async () => {
    vi.useFakeTimers();
    const accepted = deferred<unknown>();
    const request = vi.fn(async (method: string) => {
      if (method.endsWith("check")) return candidate;
      if (method.endsWith("start")) return accepted.promise;
      return { state: "cancelled", error: "导入已取消" };
    });
    const service = new LegacyImportService({ request: request as never });
    await service.initialize();
    const start = service.start();
    await service.cancel();
    expect(request.mock.calls.some(([method]) => method.endsWith("cancel"))).toBe(false);
    accepted.resolve({});
    await start;
    expect(request.mock.calls.some(([method]) => method.endsWith("cancel"))).toBe(true);
    expect(service.getSnapshot().state).toBe("cancelled");
    await service.shutdown();
  });
  it("轮询暂时失败时保持运行状态并重连，不误报导入失败或允许重试", async () => {
    vi.useFakeTimers();
    let fail = true;
    const request = vi.fn(async (method: string) => {
      if (method.endsWith("check")) return candidate;
      if (method.endsWith("status") && fail) throw new Error("网络中断");
      return { state: "running", phase: "backingUp" };
    });
    const service = new LegacyImportService({ request: request as never });
    await service.initialize();
    await service.start();
    expect(service.getSnapshot()).toMatchObject({ state: "running", error: "网络中断" });
    fail = false;
    await vi.advanceTimersByTimeAsync(1500);
    expect(service.getSnapshot()).toMatchObject({ state: "running", error: "" });
    await service.shutdown();
  });
});
