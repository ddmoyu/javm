import { describe, expect, it, vi } from "vite-plus/test";
import { LegacyImportService } from "../frontend/src/services/library/LegacyImportService";
import { deferred } from "./helpers/deferred";

const candidate = { state: "available", sourcePath: "C:/synthetic/old.db" };

describe("旧库迁移跳过后的恢复入口", () => {
  it("同一服务跳过后可重新检测并打开，无需重建服务或重启应用", async () => {
    const request = vi.fn(async () => candidate);
    const service = new LegacyImportService({ request: request as never });
    await service.initialize();
    service.dismiss();
    expect(service.getSnapshot().opened).toBe(false);
    await service.open();
    expect(service.getSnapshot()).toMatchObject({
      opened: true,
      state: "available",
      checking: false,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("连续点击重新打开只发起一次检查", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn(async () => pending.promise);
    const service = new LegacyImportService({ request: request as never });
    const first = service.open();
    const second = service.open();
    expect(service.getSnapshot().checking).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    pending.resolve(candidate);
    await Promise.all([first, second]);
    expect(service.getSnapshot().checking).toBe(false);
  });

  it("手动检查旧库已移除时展示无待导入数据，清除旧路径和错误", async () => {
    let found = true;
    const request = vi.fn(async () => (found ? candidate : { state: "none" }));
    const service = new LegacyImportService({ request: request as never });
    await service.initialize();
    service.dismiss();
    found = false;
    await service.open();
    expect(service.getSnapshot()).toMatchObject({
      opened: true,
      state: "none",
      error: "",
      sourcePath: undefined,
    });
  });

  it("当前库初始化失败后保留可重试状态，修复后可重新打开引导", async () => {
    let ready = false;
    const request = vi.fn(async (method: string) => {
      if (method.endsWith("check")) return candidate;
      if (method.endsWith("start")) throw new Error("当前片库完整性检查失败");
      return { state: ready ? "available" : "unchecked" };
    });
    const service = new LegacyImportService({ request: request as never });
    await service.initialize();
    await service.start();
    expect(service.getSnapshot()).toMatchObject({
      state: "failed",
      error: "当前片库完整性检查失败",
    });
    service.dismiss();
    ready = true;
    await service.open();
    expect(service.getSnapshot()).toMatchObject({ state: "available", opened: true, error: "" });
    await service.shutdown();
  });
});
