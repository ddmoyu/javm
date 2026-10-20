import { describe, expect, it, vi } from "vite-plus/test";
import {
  PlaybackHistory,
  bindPlaybackProgress,
  readLegacyPlaybackHistory,
} from "../frontend/src/services/playback/PlaybackHistory";
import type { PlaybackBookmark } from "../frontend/src/services/playback/PlaybackHistory";
import { DatabasePlaybackHistoryStore } from "../frontend/src/services/playback/DatabasePlaybackHistoryStore";
import {
  PlayerHistoryStore,
  servePlaybackHistory,
} from "../frontend/src/services/playback/historyChannel";
import { playbackRequest } from "../frontend/src/services/playback/source";

function memory() {
  const records = new Map<string, PlaybackBookmark>();
  return {
    records,
    read: vi.fn(async (key: string): Promise<unknown> => records.get(key) ?? null),
    write: vi.fn(async (bookmark: PlaybackBookmark) => {
      records.set(bookmark.key, bookmark);
    }),
  };
}
const request = playbackRequest("C:/电影/A.mp4");

describe("逐视频保存播放位置", () => {
  it("跨会话恢复，Windows 路径统一，网络查询参数不同不串片", async () => {
    const store = memory();
    const history = new PlaybackHistory(store);
    const first = await history.session(request);
    first.update({ time: 30, duration: 100 });
    await first.flush();
    expect(
      (await new PlaybackHistory(store).session(playbackRequest("c:\\电影\\a.mp4"))).resumeAt,
    ).toBe(30);
    expect(JSON.stringify([...store.records.values()])).not.toContain("电影");
    const network = await history.session(playbackRequest("https://example.test/video?id=1"));
    network.update({ time: 20, duration: 100 });
    await network.flush();
    expect(
      (await history.session(playbackRequest("https://example.test/video?id=2"))).resumeAt,
    ).toBe(0);
  });
  it("保存超过 200 个视频仍保留最早位置，每次只读取所需记录", async () => {
    const store = memory();
    const history = new PlaybackHistory(store);
    for (let i = 0; i < 205; i++) {
      const session = await history.session(playbackRequest(`C:/${i}.mp4`));
      session.update({ time: 20, duration: 100 });
      await session.flush();
    }
    expect(store.records.size).toBe(205);
    expect((await history.session(playbackRequest("C:/0.mp4"))).resumeAt).toBe(20);
    expect(store.read).toHaveBeenCalledTimes(206);
  });
  it("多个窗口分别保存，片尾清零不会覆盖另一部影片", async () => {
    const store = memory();
    const history = new PlaybackHistory(store);
    const other = playbackRequest("C:/b.mp4");
    const a = await history.session(request);
    const b = await new PlaybackHistory(store).session(other);
    a.update({ time: 30, duration: 100 });
    b.update({ time: 40, duration: 100 });
    await Promise.all([a.flush(), b.flush()]);
    a.update({ time: 96, duration: 100 });
    await a.flush();
    expect((await history.session(request)).resumeAt).toBe(0);
    expect((await history.session(other)).resumeAt).toBe(40);
    expect(store.records.size).toBe(2);
  });
  it("直播和非法位置不覆盖历史，播放结束明确保存零位置", async () => {
    const store = memory();
    const history = new PlaybackHistory(store);
    const session = await history.session(request);
    session.update({ time: 20, duration: 100 });
    session.update({ time: NaN, duration: 100 });
    session.update({ time: 50, duration: Infinity });
    await session.flush();
    expect((await history.session(request)).resumeAt).toBe(20);
    session.update({ time: 40, duration: 100, ended: true });
    await session.flush();
    expect((await history.session(request)).resumeAt).toBe(0);
  });
  it("慢存储合并为最新位置，失败可重试，重复暂停不重复写入", async () => {
    const store = memory();
    const history = new PlaybackHistory(store);
    const session = await history.session(request);
    let release!: () => void;
    store.write.mockImplementationOnce(async (record) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      store.records.set(record.key, record);
    });
    session.update({ time: 10, duration: 100 });
    const saving = session.flush();
    for (let i = 11; i <= 30; i++) session.update({ time: i, duration: 100 });
    release();
    await saving;
    expect(store.write).toHaveBeenCalledTimes(2);
    expect((await history.session(request)).resumeAt).toBe(30);
    store.write.mockRejectedValueOnce(new Error("只读"));
    session.update({ time: 40, duration: 100 });
    await expect(session.flush()).rejects.toThrow("未能保存");
    await session.flush();
    const count = store.write.mock.calls.length;
    session.update({ time: 40, duration: 100 });
    await session.flush();
    expect(store.write).toHaveBeenCalledTimes(count);
    expect((await history.session(request)).resumeAt).toBe(40);
  });
  it("读取损坏记录时不覆盖数据库", async () => {
    const store = memory();
    store.read.mockResolvedValueOnce({ key: "坏记录" });
    await expect(new PlaybackHistory(store).session(request)).rejects.toThrow("无法读取");
    expect(store.write).not.toHaveBeenCalled();
  });
  it("HLS 尚不可定位时不覆盖位置，恢复一次后关闭捕获最新时间", async () => {
    const store = memory();
    const history = new PlaybackHistory(store);
    const previous = await history.session(request);
    previous.update({ time: 40, duration: 100 });
    await previous.flush();
    const session = await history.session(request);
    const video = Object.assign(new EventTarget(), {
      currentTime: 0,
      duration: 100,
      readyState: 1,
      seeking: false,
      ended: false,
      seekable: { length: 0, start: () => 0, end: () => 100 },
    });
    const detach = bindPlaybackProgress(video as unknown as HTMLVideoElement, session, vi.fn());
    video.dispatchEvent(new Event("loadedmetadata"));
    await session.flush();
    expect((await history.session(request)).resumeAt).toBe(40);
    video.seekable.length = 1;
    video.dispatchEvent(new Event("canplay"));
    expect(video.currentTime).toBe(40);
    video.currentTime = 60;
    video.dispatchEvent(new Event("canplay"));
    expect(video.currentTime).toBe(60);
    detach();
    await session.flush();
    expect((await new PlaybackHistory(store).session(request)).resumeAt).toBe(60);
  });
});

describe("旧进度导入与子窗口通信", () => {
  it("首次并发读取只导入一次，旧数据保留不改写", async () => {
    const records = [{ key: "a".repeat(64), time: 30, duration: 100, updated: 1 }];
    const legacy = { read: vi.fn(async () => records) };
    const database = {
      request: vi.fn(async <T>(_method: string, _params?: unknown): Promise<T> => null as T),
    };
    const store = new DatabasePlaybackHistoryStore(database, legacy);
    await Promise.all([store.read(records[0]!.key), store.read("b".repeat(64))]);
    expect(legacy.read).toHaveBeenCalledOnce();
    expect(database.request.mock.calls.map(([method]) => method)).toEqual([
      "library.playback.import",
      "library.playback.get",
      "library.playback.get",
    ]);
    expect(records[0]!.time).toBe(30);
    expect(() => readLegacyPlaybackHistory([{ key: "损坏" }])).toThrow("无效");
  });
  it("数据库导入失败后保留旧数据，下一次请求可以重试", async () => {
    const records = [{ key: "a".repeat(64), time: 30, duration: 100, updated: 1 }];
    const database = {
      request: vi.fn(async <T>(_method: string, _params?: unknown): Promise<T> => null as T),
    };
    database.request.mockRejectedValueOnce(new Error("只读"));
    const store = new DatabasePlaybackHistoryStore(database, { read: async () => records });
    await expect(store.read(records[0]!.key)).rejects.toThrow("只读");
    await expect(store.read(records[0]!.key)).resolves.toBeNull();
    expect(database.request).toHaveBeenCalledTimes(3);
  });
  it("子窗口通过所属主窗口读写并收到保存失败，关闭清理未完成请求", async () => {
    const store = memory();
    const id = crypto.randomUUID();
    const stop = servePlaybackHistory(id, store);
    const client = new PlayerHistoryStore(id);
    const record = { key: "a".repeat(64), time: 30, duration: 100, updated: 1 };
    try {
      await client.write(record);
      expect(await client.read(record.key)).toEqual(record);
      store.write.mockRejectedValueOnce(new Error("只读"));
      await expect(client.write({ ...record, time: 40 })).rejects.toThrow("只读");
      store.read.mockImplementationOnce(() => new Promise(() => {}));
      const reading = client.read(record.key);
      client.close();
      await expect(reading).rejects.toThrow("通道已关闭");
    } finally {
      client.close();
      stop();
    }
  });
});
