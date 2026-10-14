import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { UiPreferencesService } from "../frontend/src/services/settings/UiPreferencesService";
import type { UiPreferences } from "../frontend/src/services/settings/UiPreferencesService";
import { deferred } from "./helpers/deferred";

const native = vi.hoisted(() => ({
  getKeys: vi.fn(),
  getData: vi.fn(),
  setData: vi.fn(),
  getStats: vi.fn(),
}));
vi.mock("@neutralinojs/lib", () => ({
  storage: { getKeys: native.getKeys, getData: native.getData, setData: native.setData },
  filesystem: { getStats: native.getStats },
}));

const defaults: UiPreferences = {
  colorScheme: "dark",
  cardClickToPlay: true,
  navCollapsed: false,
  discoverCardWidth: 260,
};
const key = "javm-ui-preferences-v1";

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  native.getKeys.mockResolvedValue([key]);
  native.getData.mockResolvedValue(JSON.stringify(defaults));
  native.setData.mockResolvedValue(undefined);
  vi.stubGlobal("window", {
    NL_PORT: 12345,
    NL_DATAPATH: "C:/JAVM-Safe",
    matchMedia: () => ({ matches: false }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("普通界面偏好使用官方存储", () => {
  it("已有官方设置优先，桌面保存不读写浏览器存储", async () => {
    const getItem = vi.fn(() => {
      throw new Error("不得访问旧存储");
    });
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem, setItem });
    native.getData.mockResolvedValue(JSON.stringify({ ...defaults, colorScheme: "light" }));
    const { createUiPreferences } = await import("../frontend/src/app/preferences");
    const settings = createUiPreferences("desktop");
    await settings.initialize();
    expect(settings.getSnapshot().value.colorScheme).toBe("light");
    await settings.update({ navCollapsed: true });
    expect(native.setData).toHaveBeenCalledWith(
      key,
      JSON.stringify({
        ...defaults,
        colorScheme: "light",
        navCollapsed: true,
      }),
    );
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("缺失时读取旧值，更新试运行期间不阻塞初始化，提交后才迁移且保留旧记录", async () => {
    native.getKeys.mockResolvedValue([]);
    const legacy = new Map([
      ["javm:preferences", JSON.stringify({ cardClickToPlay: false, navCollapsed: true })],
      ["javm:color-scheme", "light"],
      ["javm:discover-card-width", "420"],
    ]);
    const before = new Map(legacy);
    vi.stubGlobal("localStorage", { getItem: (name: string) => legacy.get(name) ?? null });
    const { holdUpdateStartup, commitUpdateStartup } =
      await import("../frontend/src/platform/neutralino/updateGate");
    holdUpdateStartup();
    const { createUiPreferences } = await import("../frontend/src/app/preferences");
    const settings = createUiPreferences("desktop");
    await settings.initialize();
    expect(settings.getSnapshot().value).toEqual({
      colorScheme: "light",
      cardClickToPlay: false,
      navCollapsed: true,
      discoverCardWidth: 420,
    });
    const saving = settings.flush();
    await Promise.resolve();
    expect(native.setData).not.toHaveBeenCalled();
    commitUpdateStartup();
    await saving;
    expect(native.setData).toHaveBeenCalledTimes(1);
    expect(JSON.parse(native.setData.mock.calls[0]![1] as string)).toEqual(
      settings.getSnapshot().value,
    );
    expect(legacy).toEqual(before);
  });

  it.each(["读取失败", "格式损坏"])("官方配置%s时不迁移、不覆盖原值", async (kind) => {
    const read =
      kind === "读取失败"
        ? vi.fn().mockRejectedValue(new Error("安全样例：拒绝访问"))
        : vi.fn().mockResolvedValue({ colorScheme: "invalid" });
    const write = vi.fn();
    const legacy = vi.fn(() => ({ colorScheme: "light" as const }));
    const settings = new UiPreferencesService({ read, write }, defaults, legacy);
    await settings.initialize();
    await settings.flush();
    expect(settings.getSnapshot().error).toContain("无法读取");
    expect(legacy).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("慢写入期间合并最新修改，写入串行且不会丢失其他偏好字段", async () => {
    const first = deferred<void>();
    const started = deferred<void>();
    const write = vi.fn(async (_value: UiPreferences) => {});
    write.mockImplementationOnce(() => {
      started.resolve();
      return first.promise;
    });
    const settings = new UiPreferencesService(
      { read: async () => defaults, write },
      defaults,
      () => null,
    );
    await settings.initialize();
    const one = settings.update({ navCollapsed: true });
    await started.promise;
    const two = settings.update({ discoverCardWidth: 300 });
    const three = settings.update({ discoverCardWidth: 400, cardClickToPlay: false });
    expect(write).toHaveBeenCalledTimes(1);
    first.resolve();
    await Promise.all([one, two, three]);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith({
      ...defaults,
      navCollapsed: true,
      discoverCardWidth: 400,
      cardClickToPlay: false,
    });
  });

  it("主题保存失败恢复最后成功值，Mantine 订阅回调不会再次保存回退值", async () => {
    const write = vi.fn(async (_value: UiPreferences) => {});
    const settings = new UiPreferencesService(
      { read: async () => defaults, write },
      defaults,
      () => null,
    );
    await settings.initialize();
    const { uiColorSchemeManager } = await import("../frontend/src/app/preferences");
    const manager = uiColorSchemeManager(settings);
    const changes: string[] = [];
    manager.subscribe((value) => {
      changes.push(value);
      manager.set(value);
    });
    manager.set("light");
    await settings.flush();
    write.mockRejectedValueOnce(new Error("安全样例：磁盘不可写"));
    manager.set("dark");
    await settings.flush();
    expect(manager.get("dark")).toBe("light");
    expect(settings.getSnapshot().error).toContain("保存失败");
    expect(changes).toEqual(["light", "dark", "light"]);
    expect(write).toHaveBeenCalledTimes(2);
    manager.unsubscribe();
  });

  it("窗口同步的迟到读取不会覆盖用户刚保存的偏好", async () => {
    const old = deferred<unknown>();
    const started = deferred<void>();
    const read = vi.fn(async (): Promise<unknown> => defaults);
    const settings = new UiPreferencesService(
      { read, write: async () => {} },
      defaults,
      () => null,
    );
    await settings.initialize();
    read.mockImplementationOnce(() => {
      started.resolve();
      return old.promise;
    });
    const refreshing = settings.refresh();
    await started.promise;
    await settings.update({ navCollapsed: true });
    old.resolve({ ...defaults, colorScheme: "light" });
    await refreshing;
    expect(settings.getSnapshot().value).toEqual({ ...defaults, navCollapsed: true });
  });

  it("不负责迁移的播放器仍能读取主窗口新保存的主题", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ ...defaults, colorScheme: "light" });
    const write = vi.fn();
    const settings = new UiPreferencesService({ read, write }, defaults, () => ({
      colorScheme: "dark",
    }));
    await settings.initialize();
    await settings.refresh();
    expect(settings.getSnapshot().value.colorScheme).toBe("light");
    await settings.flush();
    expect(write).not.toHaveBeenCalled();
  });

  it("同步读取期间的新通知会合并为一次后续读取", async () => {
    const old = deferred<unknown>();
    const started = deferred<void>();
    const read = vi.fn(async (): Promise<unknown> => defaults);
    const settings = new UiPreferencesService(
      { read, write: async () => {} },
      defaults,
      () => null,
    );
    await settings.initialize();
    read.mockImplementationOnce(() => {
      started.resolve();
      return old.promise;
    });
    const one = settings.refresh();
    await started.promise;
    read.mockResolvedValue({ ...defaults, colorScheme: "light" });
    const two = settings.refresh();
    const three = settings.refresh();
    old.resolve(defaults);
    await Promise.all([one, two, three]);
    expect(settings.getSnapshot().value.colorScheme).toBe("light");
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("写入结束同一轮微任务里的新修改仍会落盘", async () => {
    const first = deferred<void>();
    const started = deferred<void>();
    const write = vi.fn(async (_value: UiPreferences) => {});
    write.mockImplementationOnce(() => {
      started.resolve();
      return first.promise;
    });
    const settings = new UiPreferencesService(
      { read: async () => defaults, write },
      defaults,
      () => null,
    );
    await settings.initialize();
    const one = settings.update({ navCollapsed: true });
    await started.promise;
    const two = first.promise.then(() => settings.update({ cardClickToPlay: false }));
    first.resolve();
    await Promise.all([one, two]);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith({
      ...defaults,
      navCollapsed: true,
      cardClickToPlay: false,
    });
  });

  it("浏览器预览仍使用本地存储，不访问官方原生接口", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (name: string) => values.get(name) ?? null,
      setItem: (name: string, value: string) => {
        values.set(name, value);
      },
    });
    const { createUiPreferences } = await import("../frontend/src/app/preferences");
    const settings = createUiPreferences("browser");
    await settings.initialize();
    await settings.update({ cardClickToPlay: false });
    expect(JSON.parse(values.get(key)!)).toEqual({ ...defaults, cardClickToPlay: false });
    expect(native.getKeys).not.toHaveBeenCalled();
    expect(native.setData).not.toHaveBeenCalled();
  });
});
