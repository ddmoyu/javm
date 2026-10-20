import { describe, expect, it, vi } from "vite-plus/test";
import { BackgroundSettingsService } from "../frontend/src/services/settings/BackgroundSettingsService";
import { deferred } from "./helpers/deferred";

function memory(value: unknown = null) {
  return {
    value,
    read: vi.fn(async () => structuredClone(value)),
    async write(next: { runInBackground: boolean }) {
      value = structuredClone(next);
    },
  };
}

describe("后台运行偏好", () => {
  it("首次启动默认开启，保存后重启读取关闭状态，再次开启也会保存", async () => {
    const store = memory();
    const settings = new BackgroundSettingsService(store);
    expect(await settings.shouldRunInBackground()).toBe(true);
    await settings.setRunInBackground(false);
    const restarted = new BackgroundSettingsService(store);
    expect(await restarted.shouldRunInBackground()).toBe(false);
    await restarted.setRunInBackground(true);
    expect(await new BackgroundSettingsService(store).shouldRunInBackground()).toBe(true);
  });

  it("慢速读取期间的关闭操作等待设置加载，重复初始化只读一次", async () => {
    const read = deferred<unknown>();
    const store = { read: vi.fn(() => read.promise), write: vi.fn() };
    const settings = new BackgroundSettingsService(store);
    const closed = vi.fn();
    const close = settings.shouldRunInBackground().then(closed);
    void settings.initialize();
    await Promise.resolve();
    expect(closed).not.toHaveBeenCalled();
    read.resolve({ runInBackground: false });
    await close;
    expect(closed).toHaveBeenCalledWith(false);
    expect(store.read).toHaveBeenCalledTimes(1);
  });

  it("刚修改就关闭时等待保存，不在保存成功之前更改行为或接受下一次写入", async () => {
    const write = deferred<void>();
    const settings = new BackgroundSettingsService({
      read: async () => null,
      write: () => write.promise,
    });
    await settings.initialize();
    const save = settings.setRunInBackground(false);
    const closed = vi.fn();
    const close = settings.shouldRunInBackground().then(closed);
    await expect(settings.setRunInBackground(true)).rejects.toThrow("正在保存");
    await Promise.resolve();
    expect(settings.getSnapshot()).toMatchObject({ runInBackground: true, saving: true });
    expect(closed).not.toHaveBeenCalled();
    write.resolve();
    await Promise.all([save, close]);
    expect(closed).toHaveBeenCalledWith(false);
    expect(settings.getSnapshot()).toMatchObject({
      runInBackground: false,
      saving: false,
      error: "",
    });
  });

  it("写入失败保留原行为并显示错误，重试成功后清除错误", async () => {
    const store = memory();
    const write = vi.spyOn(store, "write").mockRejectedValueOnce(new Error("磁盘满"));
    const settings = new BackgroundSettingsService(store);
    await expect(settings.setRunInBackground(false)).rejects.toThrow("磁盘满");
    expect(await settings.shouldRunInBackground()).toBe(true);
    expect(settings.getSnapshot()).toMatchObject({ saving: false, runInBackground: true });
    expect(settings.getSnapshot().error).toContain("保存失败");
    await settings.setRunInBackground(false);
    expect(settings.getSnapshot().error).toBe("");
    expect(write).toHaveBeenCalledTimes(2);
    expect(await new BackgroundSettingsService(store).shouldRunInBackground()).toBe(false);
  });

  it.each([{}, { runInBackground: "false" }, false, []])(
    "坏设置 %j 使用开启默认值且不自动覆盖",
    async (value) => {
      const store = memory(value);
      const write = vi.spyOn(store, "write");
      const settings = new BackgroundSettingsService(store);
      expect(await settings.shouldRunInBackground()).toBe(true);
      expect(settings.getSnapshot().error).toContain("无法读取");
      expect(write).not.toHaveBeenCalled();
      await settings.setRunInBackground(false);
      expect(settings.getSnapshot().error).toBe("");
    },
  );

  it("读取失败有反馈；浏览器预览不访问桌面存储且不允许保存", async () => {
    const store = memory();
    store.read.mockRejectedValue(new Error("无访问权限"));
    const settings = new BackgroundSettingsService(store);
    expect(await settings.shouldRunInBackground()).toBe(true);
    expect(settings.getSnapshot().error).toContain("无法读取");
    const browserStore = memory();
    const preview = new BackgroundSettingsService(browserStore, false);
    expect(await preview.shouldRunInBackground()).toBe(true);
    await expect(preview.setRunInBackground(false)).rejects.toThrow("桌面端");
    expect(browserStore.read).not.toHaveBeenCalled();
  });
});
