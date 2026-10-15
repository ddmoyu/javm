import { describe, expect, it, vi } from "vite-plus/test";
import type { FilmLayout } from "../frontend/src/contracts/library";
import { LibraryLayoutService } from "../frontend/src/services/library/LibraryLayoutService";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("媒体库显示方式记忆", () => {
  it.each<FilmLayout>(["poster", "landscape", "list"])("重新启动后恢复 %s", async (layout) => {
    let saved: unknown = null;
    const store = {
      read: async () => saved,
      write: async (value: unknown) => {
        saved = value;
      },
    };
    const first = new LibraryLayoutService(store);
    await first.setLayout(layout);
    const reopened = new LibraryLayoutService(store);
    await reopened.initialize();
    expect(reopened.getSnapshot()).toEqual({ layout, error: "" });
  });

  it("慢速读取不会覆盖用户刚选择的显示方式", async () => {
    const reading = deferred<unknown>();
    const write = vi.fn(async () => {});
    const service = new LibraryLayoutService({ read: () => reading.promise, write });
    const loading = service.initialize();
    const saving = service.setLayout("landscape");
    expect(service.getSnapshot().layout).toBe("landscape");
    reading.resolve({ layout: "list" });
    await Promise.all([loading, saving]);
    expect(service.getSnapshot().layout).toBe("landscape");
    expect(write).toHaveBeenLastCalledWith({ layout: "landscape" });
  });

  it("慢速保存期间合并快速切换，退出等待最后一次选择保存", async () => {
    const firstWrite = deferred<void>();
    const write = vi
      .fn()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValue(undefined);
    const service = new LibraryLayoutService({ read: async () => null, write });
    await service.initialize();
    void service.setLayout("landscape");
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    void service.setLayout("poster");
    void service.setLayout("list");
    expect(service.getSnapshot().layout).toBe("list");
    expect(write).toHaveBeenCalledTimes(1);
    firstWrite.resolve();
    await service.flush();
    expect(write.mock.calls).toEqual([[{ layout: "landscape" }], [{ layout: "list" }]]);
  });

  it("保存失败恢复上次成功的显示方式，并允许重试", async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error("只读存储")).mockResolvedValue(undefined);
    const service = new LibraryLayoutService({
      read: async () => ({ layout: "landscape" }),
      write,
    });
    await service.setLayout("list");
    expect(service.getSnapshot().layout).toBe("landscape");
    expect(service.getSnapshot().error).toContain("保存失败");
    await service.setLayout("list");
    expect(service.getSnapshot()).toEqual({ layout: "list", error: "" });
  });

  it.each([{ layout: "unknown" }, { layout: ["poster"] }])(
    "无效设置不会破坏默认视图",
    async (value) => {
      const write = vi.fn(async () => {});
      const service = new LibraryLayoutService({ read: async () => value, write });
      await service.initialize();
      expect(service.getSnapshot().layout).toBe("poster");
      expect(service.getSnapshot().error).toContain("无法读取");
      expect(write).not.toHaveBeenCalled();
    },
  );
});
