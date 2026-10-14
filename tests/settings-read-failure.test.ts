import { describe, expect, it, vi } from "vite-plus/test";
import { ResourceSearchService } from "../frontend/src/services/streamResolution/ResourceSearchService";
import type { ResolutionService } from "../frontend/src/services/streamResolution/ResolutionService";
import type { ResourceArchive } from "../frontend/src/services/streamResolution/archive";

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
});
