import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LibraryBackupService } from "../frontend/src/services/library/LibraryBackupService";
import { LibraryRequestTimeoutError } from "../frontend/src/services/library/LibraryService";
import type { BackupStatus } from "../frontend/src/contracts/libraryBackup";

afterEach(() => vi.useRealTimers());
describe("备份服务状态恢复", () => {
  it("启动响应丢失后查询同一任务，不重复执行；恢复结束刷新一次", async () => {
    vi.useFakeTimers();
    let status: BackupStatus = { state: "idle" };
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method.endsWith("start")) {
        const input = params as { id: string; operation: "inspect" | "restore" };
        status = {
          ...input,
          state: "completed",
          result: { path: "C:/safe/backup.sqlite3", works: 3, resources: 2, favorites: 1 },
        };
        throw new LibraryRequestTimeoutError("应答丢失");
      }
      return status;
    });
    const refresh = vi.fn(async () => {});
    const service = new LibraryBackupService({ request: request as never }, undefined, refresh);
    await service.inspect("C:/safe/backup.sqlite3");
    expect(service.getSnapshot().candidate?.works).toBe(3);
    await service.restore();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot().state).toBe("completed");
    expect(request.mock.calls.filter(([method]) => method.endsWith("start"))).toHaveLength(2);
    await service.shutdown();
  });
  it("任务前置条件失败不发原生请求，并可重新操作", async () => {
    const request = vi.fn();
    const service = new LibraryBackupService({ request }, async () => {
      throw new Error("请先暂停下载");
    });
    await service.create("C:/safe");
    expect(request).not.toHaveBeenCalled();
    expect(service.getSnapshot()).toMatchObject({ state: "failed", error: "请先暂停下载" });
    await service.shutdown();
  });
  it("启动未送达时重放同一身份，明确拒绝后结束等待", async () => {
    const ids: string[] = [];
    const request = vi.fn(async (method: string, input?: { id: string }) => {
      if (method.endsWith("start")) {
        ids.push(input!.id);
        if (ids.length === 1) throw new LibraryRequestTimeoutError("启动未送达");
        throw new Error("已有其他备份任务");
      }
      return { state: "idle" };
    });
    const service = new LibraryBackupService({ request: request as never });
    await service.create("C:/safe");
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(service.getSnapshot()).toMatchObject({ state: "failed", error: "已有其他备份任务" });
    await service.shutdown();
  });
  it("已提交的恢复即使刷新失败也显示成功及重启提示", async () => {
    let status: BackupStatus = { state: "idle" };
    const service = new LibraryBackupService(
      {
        request: (async (method: string, input?: object) => {
          if (method.endsWith("start"))
            status = {
              ...input,
              state: "completed",
              result: { path: "C:/safe/db.sqlite3", works: 1, resources: 0, favorites: 0 },
            };
          return status;
        }) as never,
      },
      undefined,
      async () => {
        throw new Error("刷新失败");
      },
    );
    await service.inspect("C:/safe/db.sqlite3");
    await service.restore();
    expect(service.getSnapshot()).toMatchObject({
      state: "completed",
      warning: expect.stringContaining("重启"),
    });
    await service.shutdown();
  });
});
