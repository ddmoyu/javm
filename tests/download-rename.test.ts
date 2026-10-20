import { describe, expect, it, vi } from "vite-plus/test";
import { createDownloadTasks } from "../frontend/src/services/downloads/input";
import { defaultDownloadSettings, type DownloadTask } from "../frontend/src/contracts/downloads";
import { DownloadService } from "../frontend/src/services/downloads/DownloadService";
import type { DownloadEngine, DownloadRepository } from "../frontend/src/services/downloads/ports";
const input = {
  urls: ["https://safe.example.invalid/mock.m3u8"],
  directory: "C:/safe-fixture",
  kind: "hls" as const,
  headers: {},
};
describe("下载成品改名（安全 mock）", () => {
  it("成品改名失败保留恢复请求，重试沿用同一操作标识", async () => {
    let saved: DownloadTask = {
      ...createDownloadTasks(input, [])[0]!,
      status: "completed",
      revision: 1,
    };
    const repository: DownloadRepository = {
      load: async () => ({
        tasks: [saved],
        settings: { ...defaultDownloadSettings, directory: input.directory },
      }),
      save: async (task) => {
        saved = structuredClone(task);
      },
      remove: async () => {},
      saveSettings: async () => {},
      close: async () => {},
    };
    const engine: DownloadEngine = {
      defaultDirectory: async () => input.directory,
      outputSize: async () => 10,
      run: async () => {},
      open: async () => {},
      checkTools: async () => [],
    };
    const service = new DownloadService(repository, engine);
    const rename = vi.fn(async () => {
      throw new Error("原文件被占用");
    });
    service.connectFileRename(rename);
    await expect(service.edit(saved.id, "safe-new")).rejects.toThrow("被占用");
    const id = saved.rename?.operationId;
    expect(id).toBeTruthy();
    service.connectFileRename(async (_task, pending) => {
      expect(pending.operationId).toBe(id);
    });
    await service.edit(saved.id, "safe-new");
    expect(saved.rename).toBeUndefined();
    expect(saved.output).toContain("safe-new.mp4");
    await service.shutdown();
  });
});
