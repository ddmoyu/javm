import { describe, expect, it, vi } from "vite-plus/test";
import {
  PlaybackSettingsService,
  defaultPlaybackSettings,
  validatePlaybackSettings,
} from "../frontend/src/services/playback/PlaybackSettingsService";
import type {
  PlaybackStore,
  PlaybackSettings,
} from "../frontend/src/services/playback/PlaybackSettingsService";
import type { PlaybackRequest } from "../frontend/src/services/playback/source";
import { PreferredPlaybackController } from "../frontend/src/services/playback/PreferredPlaybackController";
import { PlaybackService } from "../frontend/src/services/playback/PlaybackService";

function memory<T>(): PlaybackStore<T> & { value: unknown } {
  return {
    value: null,
    async read() {
      return structuredClone(this.value);
    },
    async write(value) {
      this.value = structuredClone(value);
    },
  };
}

describe("播放设置的持久化与真实失败语义", () => {
  it("旧设置默认复用窗口，非法窗口模式不能写入", async () => {
    const store = memory<PlaybackSettings>();
    store.value = { defaultPlayer: "internal", externalPlayerPath: "", rememberProgress: false };
    const settings = new PlaybackSettingsService(store);
    await settings.initialize();
    expect(settings.getSnapshot().settings).toMatchObject({
      windowMode: "reuse",
    });
    expect(settings.getSnapshot().settings).not.toHaveProperty("rememberProgress");
    expect(settings.getSnapshot().error).toBe("");
    expect(() =>
      validatePlaybackSettings({ ...defaultPlaybackSettings, windowMode: "invalid" }),
    ).toThrow("格式无效");
  });
  it("保存后新实例读到偏好，取消文件选择不制造路径", async () => {
    const store = memory<PlaybackSettings>();
    const settings = new PlaybackSettingsService(store, true, async () => undefined);
    await settings.initialize();
    expect(settings.getSnapshot().settings).toEqual(defaultPlaybackSettings);
    await settings.update({
      defaultPlayer: "external",
      windowMode: "new",
      externalPlayerPath: "C:\\播放器\\player.exe",
    });
    const restarted = new PlaybackSettingsService(store);
    await restarted.initialize();
    expect(restarted.getSnapshot().settings).toMatchObject({
      defaultPlayer: "external",
      windowMode: "new",
    });
    expect(await settings.choosePlayer()).toBeUndefined();
  });
  it("路径检查和写入失败均不发布成功或覆盖原偏好", async () => {
    const store = memory<PlaybackSettings>();
    const settings = new PlaybackSettingsService(store, true, undefined, async () => {
      throw new Error("文件不存在");
    });
    await settings.initialize();
    await expect(
      settings.update({ ...defaultPlaybackSettings, externalPlayerPath: "C:/missing.exe" }),
    ).rejects.toThrow("文件不存在");
    store.write = vi.fn().mockRejectedValue(new Error("磁盘满"));
    await expect(
      settings.update({ ...defaultPlaybackSettings, windowMode: "new" }),
    ).rejects.toThrow("磁盘满");
    expect(settings.getSnapshot().settings).toEqual(defaultPlaybackSettings);
    expect(store.value).toBeNull();
  });
  it("坏设置保留错误，显式保存后恢复；浏览器不能写入", async () => {
    const store = memory<PlaybackSettings>();
    store.value = { defaultPlayer: "unknown" };
    const settings = new PlaybackSettingsService(store);
    await settings.initialize();
    expect(settings.getSnapshot().error).not.toBe("");
    await settings.update(defaultPlaybackSettings);
    expect(settings.getSnapshot().error).toBe("");
    await expect(
      new PlaybackSettingsService(store, false).update(defaultPlaybackSettings),
    ).rejects.toThrow("桌面端");
  });
  it.each([
    "player.exe",
    "C:/player.exe --fullscreen",
    "C:/player.cmd",
    "https://host/player.exe",
    "C:/a\n.exe",
  ])("拒绝不是单一可执行文件路径的配置 %s", (path) => {
    expect(() =>
      validatePlaybackSettings({ ...defaultPlaybackSettings, externalPlayerPath: path }),
    ).toThrow();
  });
});

function playerFixture(settingsStore = memory<PlaybackSettings>()) {
  const prepare = vi.fn(async (request) => ({
    request,
    url: request.source,
    format: "video" as const,
    dispose: vi.fn(async () => {}),
  }));
  const internal = new PlaybackService({ prepare });
  const settings = new PlaybackSettingsService(settingsStore);
  const external = vi.fn(async (_request: PlaybackRequest) => {});
  return {
    internal,
    prepare,
    settings,
    external,
    player: new PreferredPlaybackController(internal, settings, external),
  };
}

describe("业务播放入口遵循偏好", () => {
  it("内置模式准备视频，外部模式交接原始地址且关闭旧内置会话", async () => {
    const { player, settings, prepare, external, internal } = playerFixture();
    await player.play("C:/测试 & 100% #1.mp4");
    expect(prepare).toHaveBeenCalledOnce();
    await settings.update({ ...defaultPlaybackSettings, defaultPlayer: "external" });
    await player.play("https://example.test/a.mp4?key=a&x=%22hello%22");
    expect(external.mock.calls[0]?.[0]).toMatchObject({
      source: "https://example.test/a.mp4?key=a&x=%22hello%22",
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(internal.getSnapshot().opened).toBe(false);
  });
  it("外部程序失败不关闭当前内置影片，也不伪装启动成功", async () => {
    const { player, settings, external, internal } = playerFixture();
    await player.play("C:/a.mp4");
    await settings.update({
      ...defaultPlaybackSettings,
      defaultPlayer: "external",
      externalPlayerPath: "C:/missing.exe",
    });
    external.mockRejectedValueOnce(new Error("启动失败"));
    await expect(player.play("C:/b.mp4")).rejects.toThrow("启动失败");
    expect(internal.getSnapshot().opened).toBe(true);
    await player.shutdown();
  });
  it("初始化未结束时关闭或退出不会迟到打开播放器", async () => {
    const store = memory<PlaybackSettings>();
    let resolve!: (value: unknown) => void;
    store.read = () =>
      new Promise((done) => {
        resolve = done;
      });
    const { player, prepare, external } = playerFixture(store);
    const opening = player.play("C:/a.mp4");
    const closing = player.shutdown();
    resolve(null);
    await Promise.all([opening, closing]);
    expect(prepare).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
  });
});
