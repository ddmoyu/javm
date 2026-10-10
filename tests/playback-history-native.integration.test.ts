import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { MediaHost } from "./helpers/mediaHost";
import type { PlaybackBookmark } from "../frontend/src/services/playback/PlaybackHistory";

const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
const project = fileURLToPath(new URL("../", import.meta.url));
const bookmark = (index: number): PlaybackBookmark => ({
  key: index.toString(16).padStart(64, "0"),
  time: 20,
  duration: 100,
  updated: 1000,
});

describe.runIf(enabled)("播放进度 SQLite 持久化", () => {
  let root: string;
  let host: MediaHost;
  beforeAll(async () => {
    await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
    root = await fs.mkdtemp(path.join(project, ".tmp/playback-db-"));
    host = new MediaHost();
    await host.start(path.join(root, "downloads-v1.sqlite3"));
    await host.request("library.status");
  });
  afterAll(async () => {
    await host?.close();
  });
  const read = (key: string) =>
    host.request<PlaybackBookmark | null>("library.playback.get", { key });
  const save = (record: PlaybackBookmark) =>
    host.request("library.playback.save", { records: [record] });

  it("逐行保存超过 200 个视频，扩展重启后仍能恢复最早记录", async () => {
    for (let i = 1; i <= 205; i++) await save(bookmark(i));
    await host.close();
    host = new MediaHost();
    await host.start(path.join(root, "downloads-v1.sqlite3"));
    expect(await read(bookmark(1).key)).toEqual(bookmark(1));
    expect(await read(bookmark(205).key)).toEqual(bookmark(205));
    const db = new DatabaseSync(path.join(root, "library.sqlite3"), { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS count FROM playback_progress").get()?.count).toBe(205);
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
      expect(db.prepare("SELECT count(*) AS count FROM works").get()?.count).toBe(0);
    } finally {
      db.close();
    }
  }, 30000);
  it("不同视频的并发更新互不覆盖，旧写入不能回退新位置", async () => {
    const a = { ...bookmark(1), time: 30, updated: 2000 };
    const b = { ...bookmark(2), time: 60, updated: 2000 };
    await Promise.all([save(a), save(b)]);
    await save(bookmark(1));
    expect(await read(a.key)).toEqual(a);
    expect(await read(b.key)).toEqual(b);
  });
  it("旧进度幂等导入，不能覆盖新进度或复活已看完的位置", async () => {
    const ended = { ...bookmark(3), time: 0, updated: 2000 };
    await save(ended);
    const params = { records: [bookmark(1), bookmark(3), bookmark(300)] };
    await host.request("library.playback.import", params);
    await host.request("library.playback.import", params);
    expect((await read(bookmark(1).key))?.time).toBe(30);
    expect(await read(ended.key)).toEqual(ended);
    expect(await read(bookmark(300).key)).toEqual(bookmark(300));
  });
  it("非法批次回滚且不损坏已有记录", async () => {
    await expect(
      host.request("library.playback.import", {
        records: [bookmark(301), { ...bookmark(302), time: -1 }],
      }),
    ).rejects.toThrow("进度数据无效");
    expect(await read(bookmark(301).key)).toBeNull();
    await expect(read("bad-key")).rejects.toThrow("标识无效");
    await expect(
      host.request("library.playback.import", {
        records: Array.from({ length: 201 }, (_, i) => bookmark(400 + i)),
      }),
    ).rejects.toThrow("批次无效");
    expect((await read(bookmark(1).key))?.time).toBe(30);
  });
});
