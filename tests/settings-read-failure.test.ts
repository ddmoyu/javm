import { describe, expect, it, vi } from "vite-plus/test";
import { ResourceSearchService } from "../frontend/src/services/streamResolution/ResourceSearchService";
import type { ResolutionService } from "../frontend/src/services/streamResolution/ResolutionService";
import type { ResourceArchive } from "../frontend/src/services/streamResolution/archive";
import { UpdateService, type UpdatePort } from "../frontend/src/services/settings/UpdateService";

describe("读取失败后保护原有设置", () => {
  it.each(["读取失败", "格式损坏", "查询历史读取失败"])("资源设置%s后不自动覆盖", async (kind) => {
    const resolution = {
      subscribe: () => () => {},
      getSnapshot: () => ({ webviewAvailable: true, cleanupPending: 0, tasks: [] }),
    } as unknown as ResolutionService;
    const writePreferences = vi.fn();
    const archive: ResourceArchive = {
      read: async () => {
        throw new Error("安全样例：无法读取历史");
      },
      save: vi.fn(),
      remove: vi.fn(),
      writePreferences,
      readPreferences: async () => {
        if (kind === "读取失败") throw new Error("安全样例：不可读");
        return kind === "格式损坏"
          ? false
          : { query: "SAFE-001", code: "SAFE-001", filter: "found" };
      },
    };
    const service = new ResourceSearchService(
      resolution,
      { add: vi.fn(), directory: () => "C:/JAVM-Safe" },
      [],
      archive,
    );
    await service.initialize();
    expect(service.getSnapshot().storageError).toContain("读取失败");
    service.setQuery("SAFE-002");
    service.setFilter("all");
    await service.shutdown();
    expect(writePreferences).not.toHaveBeenCalled();
  });

  it("资源设置读取成功后仍保存新查询并保留原筛选", async () => {
    const resolution = {
      subscribe: () => () => {},
      getSnapshot: () => ({ webviewAvailable: true, cleanupPending: 0, tasks: [] }),
    } as unknown as ResolutionService;
    const writePreferences = vi.fn();
    const archive: ResourceArchive = {
      read: async () => [],
      save: vi.fn(),
      remove: vi.fn(),
      writePreferences,
      readPreferences: async () => ({ query: "SAFE-001", code: "SAFE-001", filter: "found" }),
    };
    const service = new ResourceSearchService(
      resolution,
      { add: vi.fn(), directory: () => "C:/JAVM-Safe" },
      [],
      archive,
    );
    await service.initialize();
    service.setQuery("SAFE-002");
    await service.shutdown();
    expect(writePreferences).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ query: "SAFE-002", filter: "found" }),
    );
  });

  it.each([{ channel: "broken", automatic: true }, { channel: "beta", automatic: "false" }, false])(
    "更新配置损坏时不自动检查或以默认设置覆盖：%s",
    async (saved) => {
      const installation = vi.fn<UpdatePort["installation"]>(async () => ({
        available: true,
        kind: "portable",
      }));
      const find = vi.fn<UpdatePort["find"]>(async () => null);
      const port: UpdatePort = {
        installation,
        status: async () => ({ phase: "idle" }),
        find,
        download: vi.fn(),
        install: vi.fn(),
        cancel: vi.fn(),
      };
      const write = vi.fn();
      const service = new UpdateService("1.2.0-beta.1", port, { read: async () => saved, write });
      await service.initialize();
      expect(service.getSnapshot().error).toContain("设置格式无效");
      await service.check(false);
      await service.shutdown();
      expect(installation).not.toHaveBeenCalled();
      expect(find).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    },
  );
});
