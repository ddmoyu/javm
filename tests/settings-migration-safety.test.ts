import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { UiPreferencesService } from "../frontend/src/services/settings/UiPreferencesService";
import type { UiPreferences } from "../frontend/src/services/settings/UiPreferencesService";
import { LibraryLayoutService } from "../frontend/src/services/library/LibraryLayoutService";
import { NetworkSettingsService } from "../frontend/src/services/network/NetworkSettingsService";
import { deferred } from "./helpers/deferred";

const native = vi.hoisted(() => ({
  getKeys: vi.fn(),
  getData: vi.fn(),
  setData: vi.fn(),
  getStats: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("@neutralinojs/lib", () => ({
  storage: { getKeys: native.getKeys, getData: native.getData, setData: native.setData },
  filesystem: { getStats: native.getStats },
  events: { on: native.on, off: native.off },
  extensions: { dispatch: native.dispatch },
}));
vi.mock("../frontend/src/platform/neutralino/process", () => ({
  recoverNativeProcesses: vi.fn(async () => {}),
}));

const uiKey = "javm-ui-preferences-v1";
const defaults: UiPreferences = {
  colorScheme: "dark",
  cardClickToPlay: true,
  navCollapsed: false,
  discoverCardWidth: 260,
};
const existing: UiPreferences = {
  colorScheme: "light",
  cardClickToPlay: false,
  navCollapsed: false,
  discoverCardWidth: 440,
};
const records = new Map<string, string>();
const legacy = new Map<string, string>();
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  records.clear();
  legacy.clear();
  native.getKeys.mockImplementation(async () => [...records.keys()]);
  native.getData.mockImplementation(async (key: string) => records.get(key));
  native.setData.mockImplementation(async (key: string, value: string) => {
    records.set(key, value);
  });
  vi.stubGlobal("window", {
    NL_PORT: 12345,
    NL_DATAPATH: "C:/JAVM-Safe",
    matchMedia: () => ({ matches: false }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => legacy.get(key) ?? null,
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("设置迁移的覆盖保护", () => {
  it("更新启动等待结束后重新检查目标，已有值优先且不解析旧配置", async () => {
    const { nativeSettingsStorage } =
      await import("../frontend/src/platform/neutralino/settingsStorage");
    const { holdUpdateStartup, commitUpdateStartup } =
      await import("../frontend/src/platform/neutralino/updateGate");
    const store = nativeSettingsStorage<UiPreferences>(uiKey);
    holdUpdateStartup();
    const create = vi.fn(() => defaults);
    const migrating = store.migrate(create);
    records.set(uiKey, JSON.stringify(existing));
    commitUpdateStartup();
    expect(await migrating).toEqual(existing);
    expect(create).not.toHaveBeenCalled();
    expect(native.setData).not.toHaveBeenCalled();
  });

  it.each(["迁移先", "保存先"])("同一键跨适配器串行处理，%s也保留用户最终保存", async (order) => {
    const { nativeSettingsStorage } =
      await import("../frontend/src/platform/neutralino/settingsStorage");
    const { holdUpdateStartup, commitUpdateStartup } =
      await import("../frontend/src/platform/neutralino/updateGate");
    const one = nativeSettingsStorage<UiPreferences>(uiKey);
    const two = nativeSettingsStorage<UiPreferences>(uiKey);
    holdUpdateStartup();
    const jobs =
      order === "迁移先"
        ? [one.migrate(() => defaults), two.write(existing)]
        : [two.write(existing), one.migrate(() => defaults)];
    commitUpdateStartup();
    await Promise.all(jobs);
    expect(JSON.parse(records.get(uiKey)!)).toEqual(existing);
    expect(native.setData).toHaveBeenCalledTimes(order === "迁移先" ? 2 : 1);
  });

  it("同一设置键的排队有界，失败后仍能继续保存", async () => {
    const { nativeSettingsStorage } =
      await import("../frontend/src/platform/neutralino/settingsStorage");
    const { holdUpdateStartup, commitUpdateStartup } =
      await import("../frontend/src/platform/neutralino/updateGate");
    const store = nativeSettingsStorage<UiPreferences>(uiKey);
    holdUpdateStartup();
    const jobs = Array.from({ length: 16 }, () => store.write(defaults));
    await expect(store.write(existing)).rejects.toThrow("请求过多");
    commitUpdateStartup();
    await Promise.all(jobs);
    await store.write(existing);
    expect(JSON.parse(records.get(uiKey)!)).toEqual(existing);
  });

  it("下载分页期间出现的官方配置优先，即使旧设置损坏也不覆盖", async () => {
    const { NativeDownloadRepository } =
      await import("../frontend/src/platform/neutralino/downloadRepository");
    const key = "javm-download-settings-v1";
    const settings = { directory: "C:/JAVM-Safe", concurrency: 4, ffmpegPath: "", curlPath: "" };
    let reply: (event: CustomEvent) => void;
    native.on.mockImplementation(async (_name, callback) => {
      reply = callback;
    });
    native.dispatch.mockImplementation(async (_id, _event, data) => {
      const { requestId, method } = data as { requestId: string; method: string };
      expect(["hello", "downloads.load"]).toContain(method);
      if (method === "downloads.load") records.set(key, JSON.stringify(settings));
      reply(
        new CustomEvent("reply", {
          detail: {
            requestId,
            ok: true,
            result:
              method === "downloads.load"
                ? { tasks: [], settings: { directory: 23 }, nextOffset: null }
                : {},
          },
        }),
      );
    });
    expect((await new NativeDownloadRepository().load()).settings).toEqual(settings);
    expect(native.setData).not.toHaveBeenCalled();
  });

  it("旧代理迁移前重新检查全局选择，保留后来保存的关闭状态", async () => {
    const { nativeSettingsStorage } =
      await import("../frontend/src/platform/neutralino/settingsStorage");
    const key = "javm-network-v1";
    const service = new NetworkSettingsService(nativeSettingsStorage(key));
    await service.initialize();
    const saved = { proxyEnabled: false, proxy: "http://127.0.0.1:7890" };
    records.set(key, JSON.stringify(saved));
    await service.importLegacyProxy("http://127.0.0.1:7891");
    expect(service.getSnapshot().settings).toEqual(saved);
    expect(native.setData).not.toHaveBeenCalled();
  });
});

describe("界面偏好完整迁移与部分修改", () => {
  it.each([
    ["损坏 JSON", "javm:preferences", "{broken"],
    ["错误字段类型", "javm:preferences", '{"navCollapsed":"false"}'],
    ["空对象记录", "javm:preferences", "null"],
    ["错误主题", "javm:color-scheme", "broken"],
    ["错误卡片宽度", "javm:discover-card-width", "broken"],
  ])("旧设置%s时拒绝部分迁移或以默认值覆盖", async (_label, key, raw) => {
    legacy.set("javm:color-scheme", "light");
    legacy.set(key, raw);
    const original = new Map(legacy);
    const { createUiPreferences } = await import("../frontend/src/app/preferences");
    const service = createUiPreferences("desktop");
    await service.initialize();
    await service.flush();
    await service.update({ navCollapsed: true });
    expect(service.getSnapshot().error).toContain("无法读取");
    expect(native.setData).not.toHaveBeenCalled();
    expect(legacy).toEqual(original);
  });

  it("旧偏好部分不可读时不把其他键和默认值迁走", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => {
        if (key === "javm:preferences") throw new Error("安全样例：拒绝访问");
        return key === "javm:color-scheme" ? "light" : null;
      },
    });
    const { createUiPreferences } = await import("../frontend/src/app/preferences");
    const service = createUiPreferences("desktop");
    await service.initialize();
    await service.flush();
    expect(service.getSnapshot().error).toContain("无法读取");
    expect(native.setData).not.toHaveBeenCalled();
  });

  it("官方读取失败时不写默认值，恢复读取后只修改用户指定字段", async () => {
    const read = vi.fn().mockRejectedValue(new Error("安全样例：拒绝访问"));
    const write = vi.fn(async (_value: UiPreferences) => {});
    const service = new UiPreferencesService({ read, write }, defaults, () => null);
    await service.initialize();
    await service.update({ navCollapsed: true });
    expect(write).not.toHaveBeenCalled();
    read.mockResolvedValue(existing);
    await service.update({ navCollapsed: true });
    expect(write).toHaveBeenCalledExactlyOnceWith({ ...existing, navCollapsed: true });
  });

  it("迁移等待期间只合并用户修改字段，保留后来出现的其他官方偏好", async () => {
    legacy.set("javm:color-scheme", "dark");
    const { createUiPreferences } = await import("../frontend/src/app/preferences");
    const { holdUpdateStartup, commitUpdateStartup } =
      await import("../frontend/src/platform/neutralino/updateGate");
    const service = createUiPreferences("desktop");
    await service.initialize();
    holdUpdateStartup();
    const migrating = service.flush();
    const changing = service.update({ navCollapsed: true });
    records.set(uiKey, JSON.stringify(existing));
    commitUpdateStartup();
    await Promise.all([migrating, changing]);
    const expected = { ...existing, navCollapsed: true };
    expect(service.getSnapshot().value).toEqual(expected);
    expect(JSON.parse(records.get(uiKey)!)).toEqual(expected);
    expect(native.setData).toHaveBeenCalledTimes(1);
  });

  it("迁移目标后来损坏时保持原记录，修复后可重新读取而不覆盖", async () => {
    legacy.set("javm:color-scheme", "dark");
    const { createUiPreferences } = await import("../frontend/src/app/preferences");
    const service = createUiPreferences("desktop");
    await service.initialize();
    records.set(uiKey, "null");
    await service.flush();
    expect(service.getSnapshot().error).toContain("迁移失败");
    expect(records.get(uiKey)).toBe("null");
    expect(native.setData).not.toHaveBeenCalled();
    records.set(uiKey, JSON.stringify(existing));
    await service.flush();
    expect(service.getSnapshot().value).toEqual(existing);
    expect(service.getSnapshot().error).toBe("");
    expect(native.setData).not.toHaveBeenCalled();
  });

  it("迁移写入失败可重试，旧值一直保留", async () => {
    legacy.set("javm:color-scheme", "light");
    const { createUiPreferences } = await import("../frontend/src/app/preferences");
    const service = createUiPreferences("desktop");
    await service.initialize();
    native.setData.mockRejectedValueOnce(new Error("安全样例：保存失败"));
    await service.flush();
    expect(service.getSnapshot().error).toContain("迁移失败");
    expect(records.has(uiKey)).toBe(false);
    await service.flush();
    expect(JSON.parse(records.get(uiKey)!)).toEqual({ ...defaults, colorScheme: "light" });
    expect(legacy.get("javm:color-scheme")).toBe("light");
  });

  it("较早保存失败后，后续保存仍包含尚未成功的其他修改", async () => {
    const first = deferred<void>(),
      started = deferred<void>();
    const write = vi.fn(async (_value: UiPreferences) => {});
    write.mockImplementationOnce(() => {
      started.resolve();
      return first.promise;
    });
    const service = new UiPreferencesService(
      { read: async () => defaults, write },
      defaults,
      () => null,
    );
    await service.initialize();
    const one = service.update({ colorScheme: "light" });
    await started.promise;
    const two = service.update({ navCollapsed: true });
    first.reject(new Error("安全样例：暂时不可写"));
    await Promise.all([one, two]);
    expect(write).toHaveBeenLastCalledWith({
      ...defaults,
      colorScheme: "light",
      navCollapsed: true,
    });
    expect(service.getSnapshot().value).toEqual({
      ...defaults,
      colorScheme: "light",
      navCollapsed: true,
    });
  });

  it("读取失败阻止主题保存时，Mantine 同步恢复实际主题", async () => {
    native.getKeys.mockRejectedValue(new Error("安全样例：拒绝访问"));
    const { createUiPreferences, uiColorSchemeManager } =
      await import("../frontend/src/app/preferences");
    const service = createUiPreferences("desktop");
    await service.initialize();
    const manager = uiColorSchemeManager(service);
    const notify = vi.fn((value: UiPreferences["colorScheme"]) => manager.set(value));
    manager.subscribe(notify);
    manager.set("light");
    await service.initialize();
    expect(notify).toHaveBeenLastCalledWith("dark");
    expect(native.setData).not.toHaveBeenCalled();
    manager.unsubscribe();
  });
});

describe("片库显示设置写入收尾", () => {
  it("首次读取期间已切换显示方式，保存失败仍恢复真正的旧值", async () => {
    const reading = deferred<unknown>();
    const service = new LibraryLayoutService({
      read: () => reading.promise,
      write: async () => {
        throw new Error("安全样例：不可写");
      },
    });
    const saving = service.setLayout("list");
    reading.resolve({ layout: "landscape" });
    await saving;
    expect(service.getSnapshot()).toMatchObject({
      layout: "landscape",
      error: expect.stringContaining("保存失败"),
    });
  });

  it("保存结束同一轮微任务内的新选择不会丢失", async () => {
    const first = deferred<void>(),
      started = deferred<void>();
    const write = vi.fn(async (_value: { layout: string }) => {});
    write.mockImplementationOnce(() => {
      started.resolve();
      return first.promise;
    });
    const service = new LibraryLayoutService({ read: async () => ({ layout: "poster" }), write });
    const one = service.setLayout("list");
    await started.promise;
    const two = first.promise.then(() => service.setLayout("landscape"));
    first.resolve();
    await Promise.all([one, two]);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith({ layout: "landscape" });
  });
});
