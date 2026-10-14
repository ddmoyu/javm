import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { events, extensions, filesystem, storage } from "@neutralinojs/lib";
import { NativeDownloadRepository } from "../frontend/src/platform/neutralino/downloadRepository";
import { DownloadService } from "../frontend/src/services/downloads/DownloadService";
import { createDownloadTasks } from "../frontend/src/services/downloads/input";
import { defaultDownloadSettings } from "../frontend/src/contracts/downloads";
import type { DownloadSettings, DownloadTask } from "../frontend/src/contracts/downloads";

vi.mock("@neutralinojs/lib", () => ({
  events: { on: vi.fn(), off: vi.fn() },
  extensions: { dispatch: vi.fn() },
  filesystem: { getStats: vi.fn() },
  storage: { getKeys: vi.fn(), getData: vi.fn(), setData: vi.fn() },
}));
vi.mock("../frontend/src/platform/neutralino/process", () => ({
  recoverNativeProcesses: vi.fn(async () => {}),
}));
vi.mock("../frontend/src/platform/neutralino/proxyTest", () => ({
  testProxyConnection: vi.fn(),
}));

const key = "javm-download-settings-v1";
const current: DownloadSettings = {
  directory: "C:/JAVM-Safe/Downloads",
  concurrency: 2,
  ffmpegPath: "",
  curlPath: "",
};
const records = new Map<string, string>();
const listeners = new Map<string, (event: CustomEvent) => void>();
let legacy: unknown;
let tasks: DownloadTask[];
let methods: string[];

beforeEach(() => {
  vi.resetAllMocks();
  records.clear();
  listeners.clear();
  legacy = { ...current, directory: "C:/JAVM-Safe/Legacy", concurrency: 3 };
  tasks = [];
  methods = [];
  vi.stubGlobal("window", { NL_DATAPATH: "C:/JAVM-Safe" });
  vi.mocked(storage.getKeys).mockImplementation(async () => [...records.keys()]);
  vi.mocked(storage.getData).mockImplementation(async (name) => records.get(name)!);
  vi.mocked(storage.setData).mockImplementation(async (name, value) => {
    if (value === null) records.delete(name);
    else records.set(name, value);
  });
  vi.mocked(events.on).mockImplementation(async (name, listener) => {
    listeners.set(name, listener);
    return { success: true, message: "" };
  });
  vi.mocked(extensions.dispatch).mockImplementation(async (_id, _event, data) => {
    const { requestId, method } = data as { requestId: string; method: string };
    methods.push(method);
    if (!["hello", "downloads.load", "close"].includes(method))
      throw new Error(`意外写入数据库：${method}`);
    const result = method === "downloads.load" ? { tasks, settings: legacy, nextOffset: null } : {};
    listeners.get("javm.database.response")!(
      new CustomEvent("reply", { detail: { requestId, ok: true, result } }),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("普通应用设置统一使用官方 Storage", () => {
  it("已有官方配置优先，保存后重载仍使用它，任务记录和旧配置保持原样", async () => {
    records.set(key, JSON.stringify(current));
    const originalLegacy = structuredClone(legacy);
    tasks = createDownloadTasks(
      {
        urls: ["https://example.invalid/safe-fixture.mp4"],
        directory: current.directory,
        kind: "auto",
        headers: {},
      },
      [],
    );
    const repository = new NativeDownloadRepository();
    expect(await repository.load()).toEqual({ settings: current, tasks });
    expect(storage.setData).not.toHaveBeenCalled();
    const updated = { ...current, concurrency: 4 };
    await repository.saveSettings(updated);
    expect(storage.setData).toHaveBeenCalledExactlyOnceWith(key, JSON.stringify(updated));
    expect((await repository.load()).settings).toEqual(updated);
    expect(legacy).toEqual(originalLegacy);
    expect(methods).not.toContain("downloads.settings");
    expect(methods).not.toContain("downloads.save");
  });

  it("旧库设置只迁移一次，保留原记录，旧代理交给网络服务且丢弃停用字段", async () => {
    legacy = {
      directory: "/safe/downloads",
      concurrency: 3,
      ffmpegPath: "/safe/ffmpeg",
      curlPath: "",
      hlsPath: "/safe/retired-downloader",
      ffprobePath: "/safe/retired-probe",
      proxy: "http://127.0.0.1:7890",
    };
    const original = structuredClone(legacy);
    const proxy = vi.fn(async (_value: string) => {});
    const repository = new NativeDownloadRepository(proxy);
    const loaded = await repository.load();
    expect(loaded.settings).toEqual({
      directory: "/safe/downloads",
      concurrency: 3,
      ffmpegPath: "/safe/ffmpeg",
      curlPath: "",
    });
    expect(JSON.parse(records.get(key)!)).toEqual(loaded.settings);
    expect(proxy).toHaveBeenCalledWith("http://127.0.0.1:7890");
    expect(legacy).toEqual(original);
    await repository.load();
    expect(storage.setData).toHaveBeenCalledTimes(1);
    expect(methods).not.toContain("downloads.settings");
  });

  it("首次启动可迁移空配置，默认目录仍由下载引擎解析", async () => {
    legacy = {};
    vi.mocked(storage.getKeys).mockRejectedValueOnce({ code: "NE_ST_NOSTDIR" });
    vi.mocked(filesystem.getStats).mockRejectedValueOnce({ code: "NE_FS_NOPATHE" });
    const repository = new NativeDownloadRepository();
    expect((await repository.load()).settings).toEqual(defaultDownloadSettings);
    expect(JSON.parse(records.get(key)!)).toEqual(defaultDownloadSettings);
  });

  it("官方存储无法读取时拒绝回退旧库，不覆盖设置", async () => {
    vi.mocked(storage.getKeys).mockRejectedValueOnce(new Error("安全样例：拒绝访问"));
    const repository = new NativeDownloadRepository();
    await expect(repository.load()).rejects.toThrow("拒绝访问");
    expect(storage.setData).not.toHaveBeenCalled();
    expect(methods).not.toContain("downloads.load");
  });

  it.each(["{broken", "null", "[]", '{"directory":23}', '{"concurrency":0}'])(
    "官方记录损坏时不自动覆盖：%s",
    async (raw) => {
      records.set(key, raw);
      const repository = new NativeDownloadRepository();
      await expect(repository.load()).rejects.toThrow();
      expect(storage.setData).not.toHaveBeenCalled();
      expect(records.get(key)).toBe(raw);
      expect(methods).not.toContain("downloads.load");
    },
  );

  it("旧配置损坏时不创建新记录，也不修改旧库", async () => {
    legacy = { ...current, directory: "relative-path" };
    const original = structuredClone(legacy);
    await expect(new NativeDownloadRepository().load()).rejects.toThrow("绝对保存目录");
    expect(storage.setData).not.toHaveBeenCalled();
    expect(legacy).toEqual(original);
  });

  it("迁移写入失败保留旧配置，恢复服务后可以重试迁移", async () => {
    const original = structuredClone(legacy);
    vi.mocked(storage.setData).mockRejectedValueOnce(new Error("安全样例：磁盘不可写"));
    const repository = new NativeDownloadRepository();
    await expect(repository.load()).rejects.toThrow("磁盘不可写");
    expect(records.has(key)).toBe(false);
    expect(legacy).toEqual(original);
    const loaded = await repository.load();
    expect(JSON.parse(records.get(key)!)).toEqual(loaded.settings);
    expect(storage.setData).toHaveBeenCalledTimes(2);
    expect(methods).not.toContain("downloads.settings");
  });

  it("用户保存失败时仍使用最后成功的设置", async () => {
    records.set(key, JSON.stringify(current));
    const service = new DownloadService(new NativeDownloadRepository(), {
      defaultDirectory: async () => current.directory,
      outputSize: async () => null,
      run: vi.fn(),
      open: vi.fn(),
      checkTools: async () => [],
    });
    await service.initialize();
    expect(service.getSnapshot().error).toBe("");
    vi.mocked(storage.setData).mockRejectedValueOnce(new Error("安全样例：保存失败"));
    await expect(service.updateSettings({ ...current, concurrency: 4 })).rejects.toThrow(
      "保存失败",
    );
    expect(service.getSnapshot().settings).toEqual(current);
    expect(JSON.parse(records.get(key)!)).toEqual(current);
    expect(methods).not.toContain("downloads.settings");
  });
});
