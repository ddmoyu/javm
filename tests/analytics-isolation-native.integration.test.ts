import { afterEach, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
import { createLibraryFixture } from "./helpers/libraryFixture";
import { emptyPayload } from "../frontend/src/services/analytics/contract";
import type { AnalyticsLoad, AnalyticsState } from "../frontend/src/services/analytics/contract";
import type { BackupStatus } from "../frontend/src/contracts/libraryBackup";
const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
const hosts: MediaHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});
const state: AnalyticsState = {
  version: 1,
  userId: "00000000-0000-4000-8000-000000000001",
  days: [],
};
state.days.push({
  payload: {
    ...emptyPayload(state.userId, "2026-10-15", {
      os: "windows",
      cpu_arch: "x86_64",
      system_language: "zh-CN",
      app_version: "1.0.7",
    }),
    play_video_count: 7,
  },
  pending: true,
});
async function fixture() {
  await fs.mkdir(".tmp", { recursive: true });
  const root = path.resolve(await fs.mkdtemp(".tmp/analytics-isolation-"));
  const library = path.join(root, "library.sqlite3");
  const db = createLibraryFixture(library);
  db.exec(
    "CREATE TABLE usage_analytics_state(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL)",
  );
  db.prepare("INSERT INTO usage_analytics_state VALUES(1,4,?)").run(JSON.stringify(state));
  db.close();
  const host = new MediaHost();
  hosts.push(host);
  await host.start(path.join(root, "downloads.sqlite3"));
  await host.request("library.status");
  return { root, library, host };
}
async function backup(host: MediaHost, operation: string, params: object) {
  await host.request("library.backup.start", { id: crypto.randomUUID(), operation, ...params });
  for (let i = 0; i < 1000; i++) {
    const result = await host.request<BackupStatus>("library.backup.status");
    if (result.state !== "running") {
      expect(result.state, result.error).toBe("completed");
      return result.result!;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("备份测试超时");
}
describe.runIf(enabled)("统计与片库恢复隔离（虚构 SQLite）", () => {
  it("迁移片库快照后，恢复旧片库不回滚身份、计数和 revision，可继续保存", async () => {
    const { root, host, library } = await fixture();
    expect(await host.request<AnalyticsLoad>("library.analytics.load")).toMatchObject({
      revision: 4,
      state,
    });
    expect(await fs.stat(path.join(root, "analytics.sqlite3"))).toBeDefined();
    const created = await backup(host, "create", { directory: root });
    const next = structuredClone(state);
    next.days[0]!.payload.play_video_count = 9;
    await host.request("library.analytics.save", { state: next, expectedRevision: 4 });
    await backup(host, "restore", { path: created.path });
    expect(await host.request<AnalyticsLoad>("library.analytics.load")).toMatchObject({
      revision: 5,
      state: next,
    });
    next.days[0]!.payload.download_video_failed_count = 2;
    await host.request("library.analytics.save", { state: next, expectedRevision: 5 });
    expect(await host.request<AnalyticsLoad>("library.analytics.load")).toMatchObject({
      revision: 6,
      state: next,
    });
    const source = new DatabaseSync(library, { readOnly: true });
    expect(source.prepare("SELECT revision FROM usage_analytics_state").get()?.revision).toBe(4);
    source.close();
  });
  it("独立统计库损坏时保留文件，不从旧片库重新生成身份或覆盖它", async () => {
    const { root, host } = await fixture();
    const target = path.join(root, "analytics.sqlite3");
    const original = Buffer.from("safe damaged statistics fixture");
    await fs.writeFile(target, original);
    await expect(host.request("library.analytics.load")).rejects.toThrow();
    expect(await fs.readFile(target)).toEqual(original);
  });
  it("片库损坏仍可使用已迁移统计；尚未迁移时等待恢复而不重建身份", async () => {
    for (const migrated of [true, false]) {
      const { root, host, library } = await fixture();
      if (migrated) await host.request("library.analytics.load");
      await host.close();
      hosts.splice(hosts.indexOf(host), 1);
      const original = Buffer.from("safe broken library fixture");
      await fs.writeFile(library, original);
      const restarted = new MediaHost();
      hosts.push(restarted);
      await restarted.start(path.join(root, "downloads.sqlite3"));
      await restarted.request("library.status");
      if (migrated) {
        expect(await restarted.request("library.analytics.load")).toMatchObject({
          revision: 4,
          state,
        });
        await restarted.request("library.analytics.save", { state, expectedRevision: 4 });
      } else {
        await expect(restarted.request("library.analytics.load")).rejects.toThrow("先恢复片库");
      }
      expect(await fs.readFile(library)).toEqual(original);
    }
  });
});
