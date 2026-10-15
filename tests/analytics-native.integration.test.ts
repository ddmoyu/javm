import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
import { createLibraryFixture } from "./helpers/libraryFixture";
import { readAnalytics } from "../frontend/src/services/analytics/contract";
import type { AnalyticsLoad, AnalyticsState } from "../frontend/src/services/analytics/contract";

const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
describe.runIf(enabled)("使用统计 SQLite 迁移（隔离虚构旧库）", () => {
  let host: MediaHost, database: string, legacy: string, original: Buffer;
  const start = async () => {
    host = new MediaHost();
    await host.start(database);
    await host.request("library.status");
  };
  const load = () => host.request<AnalyticsLoad>("library.analytics.load");
  const save = (state: AnalyticsState, expectedRevision: number) =>
    host.request("library.analytics.save", { state, expectedRevision });
  beforeAll(async () => {
    await fs.mkdir(".tmp", { recursive: true });
    const root = path.resolve(await fs.mkdtemp(".tmp/analytics-"));
    await fs.mkdir(path.join(root, "current"));
    await fs.mkdir(path.join(root, "com.ddmoyu.javm"));
    database = path.join(root, "current", "downloads.sqlite3");
    const current = createLibraryFixture(path.join(root, "current", "library.sqlite3"));
    current.exec(
      "INSERT INTO works(id,code,code_key,title) VALUES('safe-work','SAFE-001','safe001','虚构纪录片')",
    );
    current.close();
    legacy = path.join(root, "com.ddmoyu.javm", "javm.db");
    const old = new DatabaseSync(legacy);
    old.exec(`
      CREATE TABLE analytics_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO analytics_meta VALUES('analytics_user_id','00000000-0000-4000-8000-000000000001');
      CREATE TABLE analytics_daily(user_id TEXT,stat_date TEXT,os TEXT,cpu_arch TEXT,system_language TEXT,app_version TEXT,
        play_video_count INTEGER,download_video_count INTEGER,app_launch_count INTEGER,active_duration_seconds INTEGER,
        search_designation_count INTEGER,search_resource_link_count INTEGER,current_video_total_count INTEGER,needs_sync INTEGER);
      INSERT INTO analytics_daily VALUES('00000000-0000-4000-8000-000000000001','2026-10-14','windows','x86_64','zh-CN','0.5.3',2,3,1,60,4,5,6,1);
    `);
    old.close();
    original = await fs.readFile(legacy);
    await start();
  });
  afterAll(async () => {
    await host?.close();
  });
  it("只读旧统计并沿用身份，不将纯资料作品计为视频文件", async () => {
    const data = await load();
    expect(data.state).toBeNull();
    const state = readAnalytics(data);
    expect(state.userId).toBe("00000000-0000-4000-8000-000000000001");
    expect(state.days[0]!.payload).toMatchObject({
      video_total_count: 6,
      search_resource_link_count: 5,
      download_video_failed_count: 0,
    });
    expect(await host.request("library.analytics.context")).toEqual({ videoCount: 0 });
    expect(await fs.readFile(legacy)).toEqual(original);
  });
  it("原子保存可重放同一快照，拒绝过期覆盖，重启继续沿用旧身份", async () => {
    const state = readAnalytics(await load());
    await save(state, 0);
    await save(state, 0);
    const changed = structuredClone(state);
    changed.days[0]!.payload.play_video_count++;
    await expect(save(changed, 0)).rejects.toThrow("使用统计已变化");
    await save(changed, 1);
    await host.close();
    await start();
    const result = await load();
    expect(result.revision).toBe(2);
    expect(result.state).toEqual(changed);
    expect(result.legacyDays).toEqual([]);
    expect(await fs.readFile(legacy)).toEqual(original);
  });
  it("超大统计写入被拒绝，已保存内容保持不变", async () => {
    const before = await load();
    const invalid = { ...(before.state as AnalyticsState), excess: "x".repeat(65536) };
    await expect(save(invalid, before.revision)).rejects.toThrow("使用统计记录无效");
    expect((await load()).state).toEqual(before.state);
  });
});
