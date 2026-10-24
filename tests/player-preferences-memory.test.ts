import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  fitPlayerPosition,
  PlayerPreferences,
  storedPlayerPreferences,
} from "../frontend/src/services/playback/PlayerPreferences";
import type { PlayerPreferencesValue } from "../frontend/src/services/playback/PlayerPreferences";
import {
  PlayerPreferencesClient,
  servePlayerPreferences,
} from "../frontend/src/services/playback/preferencesChannel";
import { bindPlayerVolume } from "../frontend/src/services/playback/playerVolume";

function memory(value: unknown = null) {
  return {
    value,
    read: vi.fn(async function (this: { value: unknown }) {
      return this.value;
    }),
    write: vi.fn(async function (this: { value: unknown }, next: PlayerPreferencesValue) {
      this.value = structuredClone(next);
    }),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

describe("播放器位置与音量记忆", () => {
  it("缺失时不写默认值，保存后新会话恢复零音量和负坐标", async () => {
    const store = memory();
    const preferences = storedPlayerPreferences(store);
    expect(await preferences.read()).toEqual({ volume: 1 });
    expect(store.write).not.toHaveBeenCalled();
    await preferences.update({ volume: 0, position: { x: -1500, y: 120 } });
    expect(await storedPlayerPreferences(store).read()).toEqual({
      volume: 0,
      position: { x: -1500, y: 120 },
    });
  });

  it("慢写入只保留最新修改，关闭等待的 flush 包含最后一笔", async () => {
    const store = memory({ volume: 0.5 });
    const blocked = deferred<void>();
    store.write.mockImplementationOnce(async (value) => {
      await blocked.promise;
      store.value = value;
    });
    const preferences = storedPlayerPreferences(store);
    const first = preferences.update({ volume: 0.1 });
    await tick();
    for (let volume = 20; volume <= 90; volume++) void preferences.update({ volume: volume / 100 });
    void preferences.update({ position: { x: 300, y: 240 } });
    expect(store.write).toHaveBeenCalledTimes(1);
    let flushed = false;
    const flushing = preferences.flush().then(() => {
      flushed = true;
    });
    await tick();
    expect(flushed).toBe(false);
    blocked.resolve();
    await Promise.all([first, flushing]);
    expect(store.write).toHaveBeenCalledTimes(2);
    expect(store.value).toEqual({ volume: 0.9, position: { x: 300, y: 240 } });
  });

  it("多个子窗口通过主窗口合并字段，重开客户端读取已保存值", async () => {
    const preferences = storedPlayerPreferences(memory());
    const clients = [crypto.randomUUID(), crypto.randomUUID()].map((id) => {
      cleanups.push(servePlayerPreferences(id, preferences));
      const client = new PlayerPreferencesClient(id);
      cleanups.push(() => client.close());
      return new PlayerPreferences(client);
    });
    await Promise.all([
      clients[0]!.update({ volume: 0.35 }),
      clients[1]!.update({ position: { x: -1200, y: 45 } }),
    ]);
    expect(await clients[0]!.read()).toEqual({ volume: 0.35, position: { x: -1200, y: 45 } });
    expect(await clients[1]!.read()).toEqual(await preferences.read());
  });

  it("读取损坏记录时拒绝覆盖，保存失败保留上次提交值且允许重试", async () => {
    const broken = memory({ volume: 9 });
    const invalid = storedPlayerPreferences(broken);
    await expect(invalid.update({ position: { x: 1, y: 2 } })).rejects.toThrow("格式无效");
    expect(broken.write).not.toHaveBeenCalled();
    const store = memory({ volume: 0.45 });
    const preferences = storedPlayerPreferences(store);
    store.write.mockRejectedValueOnce(new Error("safe mock storage failure"));
    await expect(preferences.update({ volume: 0.8 })).rejects.toThrow("storage failure");
    expect(await preferences.read()).toEqual({ volume: 0.45 });
    await preferences.update({ position: { x: 60, y: 80 } });
    expect(store.value).toEqual({ volume: 0.45, position: { x: 60, y: 80 } });
  });

  it("离屏窗口回到主屏，负坐标副屏保留且边缘位置受到限制", () => {
    const primary = { x: 0, y: 0, width: 1920, height: 1040 };
    const secondary = { x: -1920, y: -200, width: 1920, height: 1040 };
    const displays = [
      { primary: true, bounds: primary, workArea: primary },
      { primary: false, bounds: secondary, workArea: secondary },
    ];
    expect(fitPlayerPosition({ x: -1500, y: -120 }, displays)).toEqual({ x: -1500, y: -120 });
    expect(fitPlayerPosition({ x: -3000, y: 0 }, displays.slice(0, 1))).toEqual({ x: 480, y: 220 });
    expect(fitPlayerPosition({ x: 1800, y: 900 }, displays)).toEqual({ x: 960, y: 440 });
  });

  it("关闭客户端会结束在途请求并拒绝后续请求", async () => {
    const client = new PlayerPreferencesClient(crypto.randomUUID());
    const waiting = expect(client.read()).rejects.toThrow("通道已关闭");
    client.close();
    await waiting;
    await expect(client.read()).rejects.toThrow("通道已关闭");
  });
});

class SafeMedia extends EventTarget {
  volume = 1;
  muted = false;
  change(volume: number) {
    this.volume = volume;
    this.dispatchEvent(new Event("volumechange"));
  }
}
const asMedia = (value: SafeMedia) => value as unknown as HTMLMediaElement;

describe("媒体音量绑定", () => {
  it("等待保存音量后才就绪，恢复本身与临时静音不触发写入", async () => {
    const store = memory();
    const loading = deferred<unknown>();
    store.read.mockReturnValueOnce(loading.promise);
    const media = new SafeMedia();
    const binding = bindPlayerVolume(asMedia(media), storedPlayerPreferences(store), vi.fn());
    cleanups.push(binding.dispose);
    let ready = false;
    void binding.ready.then(() => {
      ready = true;
    });
    await tick();
    expect(ready).toBe(false);
    loading.resolve({ volume: 0.24 });
    await binding.ready;
    expect(media.volume).toBe(0.24);
    media.muted = true;
    media.dispatchEvent(new Event("volumechange"));
    await tick();
    expect(store.write).not.toHaveBeenCalled();
  });

  it("调整音量后另一部视频恢复相同音量，零音量也保留", async () => {
    const store = memory({ volume: 0.5 });
    const preferences = storedPlayerPreferences(store);
    const media = new SafeMedia();
    const first = bindPlayerVolume(asMedia(media), preferences, vi.fn());
    await first.ready;
    media.change(0);
    await preferences.flush();
    first.dispose();
    const next = new SafeMedia();
    const second = bindPlayerVolume(asMedia(next), preferences, vi.fn());
    cleanups.push(second.dispose);
    await second.ready;
    expect(next.volume).toBe(0);
  });

  it("晚到的读取不能修改已卸载的媒体，也不写入默认音量", async () => {
    const store = memory();
    const loading = deferred<unknown>();
    store.read.mockReturnValueOnce(loading.promise);
    const media = new SafeMedia();
    const binding = bindPlayerVolume(asMedia(media), storedPlayerPreferences(store), vi.fn());
    binding.dispose();
    loading.resolve({ volume: 0.3 });
    await binding.ready;
    media.change(0.7);
    expect(store.write).not.toHaveBeenCalled();
    expect(media.volume).toBe(0.7);
  });

  it("合并写入部分成功后失败，回滚到实际保存值而非初始音量", async () => {
    const store = memory({ volume: 0.5 });
    const blocked = deferred<void>();
    store.write.mockImplementationOnce(async (value) => {
      await blocked.promise;
      store.value = value;
    });
    store.write.mockRejectedValueOnce(new Error("safe mock write failure"));
    const preferences = storedPlayerPreferences(store);
    const media = new SafeMedia();
    const report = vi.fn();
    const binding = bindPlayerVolume(asMedia(media), preferences, report);
    cleanups.push(binding.dispose);
    await binding.ready;
    media.change(0.2);
    await tick();
    media.change(0.3);
    blocked.resolve();
    await preferences.flush().catch(() => {});
    await tick();
    expect(media.volume).toBe(0.2);
    expect(store.value).toEqual({ volume: 0.2 });
    expect(report).toHaveBeenCalledWith(expect.stringContaining("保存失败"));
    media.change(0.4);
    await preferences.flush();
    await tick();
    expect(store.value).toEqual({ volume: 0.4 });
    expect(report).toHaveBeenLastCalledWith("");
  });
});
