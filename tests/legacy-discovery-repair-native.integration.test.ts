import { afterEach, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MediaHost } from "./helpers/mediaHost";
import type { LegacyImportSnapshot } from "../frontend/src/contracts/legacyImport";

const enabled = process.env.JAVM_MEDIA_INTEGRATION === "1";
const project = fileURLToPath(new URL("../", import.meta.url));
const schema = await fs.readFile(path.join(project, "tests/fixtures/legacy-0.5.3.sql"), "utf8");
const marker = "__javm_discovery_repair_v1";
const hosts: MediaHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});
async function start(root: string, executable?: string) {
  const host = new MediaHost();
  hosts.push(host);
  const previous = process.env.JAVM_DATABASE_EXE;
  try {
    if (executable) process.env.JAVM_DATABASE_EXE = executable;
    await host.start(path.join(root, "JAVM/downloads-v1.sqlite3"));
  } finally {
    if (previous === undefined) delete process.env.JAVM_DATABASE_EXE;
    else process.env.JAVM_DATABASE_EXE = previous;
  }
  return host;
}
async function finished(host: MediaHost) {
  const deadline = Date.now() + 110000;
  while (Date.now() < deadline) {
    const status = await host.request<LegacyImportSnapshot>("library.legacy.status");
    if (status.state !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("安全迁移夹具超时");
}
async function fixture(videos = 2, cacheRows = 20, executable?: string) {
  await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
  const root = await fs.mkdtemp(path.join(project, ".tmp/discovery-repair-"));
  const source = path.join(root, "com.ddmoyu.javm/javm.db");
  const target = path.join(root, "JAVM/library.sqlite3");
  await fs.mkdir(path.dirname(source), { recursive: true });
  const old = new DatabaseSync(source);
  old.exec(schema);
  old.exec(`CREATE TABLE actor_works(actor_id INTEGER,code TEXT,title TEXT,cover_url TEXT,release_date TEXT,local_video_id TEXT);
    CREATE TABLE facet_works(code TEXT,title TEXT,cover_url TEXT,release_date TEXT,local_video_id TEXT);
    INSERT INTO actors(id,name) VALUES(1,'安全虚构演员'); BEGIN;`);
  const video = old.prepare(
    "INSERT INTO videos(id,local_id,title,video_path,dir_path) VALUES(?,?,?,?,?)",
  );
  for (let i = 0; i < videos; i++)
    video.run(
      `video-${i}`,
      `SAFE-${i}`,
      `安全本地影片 ${i}`,
      path.join(root, `offline/${i}.mp4`),
      path.join(root, "offline"),
    );
  const actor = old.prepare("INSERT INTO actor_works VALUES(1,?,?,?,'2026-01-01',NULL)");
  const facet = old.prepare("INSERT INTO facet_works VALUES(?,?,?,'2026-01-01',NULL)");
  for (let i = 0; i < cacheRows; i++) {
    const args = [`CACHE-${i}`, `安全发现资料 ${i}`, `https://example.invalid/safe/${i}.jpg`];
    (i % 2 ? actor : facet).run(...args);
  }
  // 与真实片库同号的缓存也不能覆盖片库资料或扩充关系。
  old
    .prepare("INSERT INTO actor_works VALUES(1,'SAFE-0','缓存标题','','2026-01-01','video-0')")
    .run();
  old.exec("COMMIT;");
  old.close();
  const host = await start(root, executable);
  await host.request("library.status");
  return { host, root, source, target, cacheRows, videos };
}
async function importFixture(value: Awaited<ReturnType<typeof fixture>>) {
  await value.host.request("library.legacy.start");
  const result = await finished(value.host);
  expect(result.state, result.error).toBe("completed");
  return result;
}
async function polluted(cacheRows = 20) {
  const value = await fixture(2, cacheRows);
  const initial = await importFixture(value);
  await value.host.close();
  const db = new DatabaseSync(value.target);
  db.exec("BEGIN;");
  // 精确复现旧迁移器保存缓存时的 works/provenance 形态；来源归档由真实导入器生成。
  const insert =
    db.prepare(`INSERT INTO works(id,code,code_key,title,premiered,poster,scan_status,provenance,created_at,updated_at)
    VALUES(?,?,?,?,?,?,2,?,'2026-01-01 00:00:00','2026-01-01 00:00:00')`);
  for (let i = 0; i < cacheRows; i++) {
    const code = `CACHE-${i}`,
      title = `安全发现资料 ${i}`,
      poster = `https://example.invalid/safe/${i}.jpg`;
    insert.run(
      `cache-${i}`,
      code,
      `cache${i}`,
      title,
      "2026-01-01",
      poster,
      JSON.stringify({ num: code, title, premiered: "2026-01-01", _local_poster: poster }),
    );
  }
  db.prepare("DELETE FROM legacy_records WHERE table_name=?").run(marker);
  db.exec("COMMIT;");
  db.close();
  return { ...value, initial };
}

describe.runIf(enabled)("发现页缓存与旧库导入边界", { timeout: 120000 }, () => {
  it.each([20000, 200000])("600 部视频加 %i 条发现缓存，导入后仍为 600 部", async (cacheRows) => {
    const value = await fixture(600, cacheRows);
    await importFixture(value);
    expect(await value.host.request("library.summary")).toMatchObject({ total: 600 });
    const db = new DatabaseSync(value.target, { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM media_files WHERE missing=1").get()?.n).toBe(
        600,
      );
      expect(
        db
          .prepare(
            "SELECT count(*) AS n FROM legacy_records WHERE table_name IN ('actor_works','facet_works')",
          )
          .get()?.n,
      ).toBe(cacheRows + 1);
      expect(db.prepare("SELECT count(*) AS n FROM work_entities").get()?.n).toBe(0);
      expect(db.prepare("SELECT title FROM works WHERE code='SAFE-0'").get()?.title).toBe(
        "安全本地影片 0",
      );
    } finally {
      db.close();
    }
    expect(await value.host.request("library.legacy.check")).toMatchObject({ state: "none" });
  });

  it("修复已有误导入，保留离线视频、原有资料和用户后续操作；备份与归档可恢复，重复打开不重复修复", async () => {
    const value = await polluted();
    const db = new DatabaseSync(value.target);
    db.exec(`UPDATE works SET favorite=1 WHERE id='cache-1';
      UPDATE works SET provenance=json_set(provenance,'$._manual.title','用户编辑') WHERE id='cache-2';
      INSERT INTO media_files(id,work_id,path_key,path,dir_path,missing) VALUES('offline','cache-3','/safe/offline.mp4','/safe/offline.mp4','/safe',1);
      INSERT INTO work_sources VALUES('safe','source','cache-4');
      INSERT INTO nfo_documents(path_key,work_id,path) VALUES('/safe/movie.nfo','cache-5','/safe/movie.nfo');
      INSERT INTO saved_resources VALUES('resource','safe','CACHE-6','cache6','cache-6','safe','safe','{}',0);
      INSERT INTO work_artwork(id,work_id,path,kind) VALUES('art','cache-7','/safe/poster.jpg','poster');
      UPDATE works SET updated_at='2099-01-01 00:00:00' WHERE id='cache-8';
      INSERT INTO works(id,title) VALUES('new-metadata','新版主动保存的资料');`);
    db.close();
    const before = new DatabaseSync(value.initial.targetBackupPath!);
    before.exec("INSERT INTO works(id,title) VALUES('cache-0','导入前已有的资料')");
    before.close();
    const downloads = new DatabaseSync(path.join(value.root, "JAVM/downloads-v1.sqlite3"));
    downloads
      .prepare("INSERT INTO download_tasks VALUES('safe-download',1,?)")
      .run(JSON.stringify({ workId: "cache-9" }));
    downloads.close();
    const host = await start(value.root);
    // 原旧库已移除；首次 check 仍能在不初始化 Store 的只读路径发现修复候选。
    expect(await host.request("library.legacy.check")).toMatchObject({
      state: "available",
      operation: "repair",
    });
    await host.request("library.legacy.start");
    const result = await finished(host);
    expect(result, result.error).toMatchObject({
      state: "completed",
      operation: "repair",
      removedWorks: 10,
    });
    expect(await host.request("library.summary")).toMatchObject({ total: 13 });
    const check = new DatabaseSync(value.target, { readOnly: true });
    const rollback = new DatabaseSync(result.backupPath!, { readOnly: true });
    try {
      for (let i = 0; i < 10; i++)
        expect(check.prepare("SELECT id FROM works WHERE id=?").get(`cache-${i}`)).toBeDefined();
      expect(check.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        check
          .prepare(
            "SELECT count(*) AS n FROM legacy_records WHERE table_name IN ('actor_works','facet_works')",
          )
          .get()?.n,
      ).toBe(21);
      expect(rollback.prepare("SELECT count(*) AS n FROM works").get()?.n).toBe(23);
    } finally {
      check.close();
      rollback.close();
    }
    expect(await host.request("library.legacy.check")).toMatchObject({ state: "none" });
    await host.close();
    const reopened = await start(value.root);
    expect(await reopened.request("library.legacy.check")).toMatchObject({ state: "none" });
    expect(await reopened.request("library.summary")).toMatchObject({ total: 13 });
  });

  it("导入前备份缺失时拒绝猜测，不修改任何片库记录", async () => {
    const value = await polluted();
    await fs.rename(value.initial.targetBackupPath!, `${value.initial.targetBackupPath}.kept`);
    const host = await start(value.root);
    await host.request("library.legacy.start");
    expect((await finished(host)).error).toContain("导入前备份缺失");
    expect(await host.request("library.summary")).toMatchObject({ total: 22 });
    expect(await host.request("library.legacy.check")).toMatchObject({
      state: "available",
      operation: "repair",
    });
  });

  it("修复事务失败后完整回滚，仍能重试", async () => {
    const value = await polluted();
    // 使用外键失败模拟提交前校验失败；快照本身仍是结构完整的合法片库。
    const db = new DatabaseSync(value.target);
    db.exec(
      "CREATE TABLE repair_guard(id TEXT REFERENCES works(id) ON DELETE RESTRICT); INSERT INTO repair_guard VALUES('cache-19');",
    );
    db.close();
    const host = await start(value.root);
    await host.request("library.legacy.start");
    expect((await finished(host)).state).toBe("failed");
    expect(await host.request("library.summary")).toMatchObject({ total: 22 });
    expect(await host.request("library.legacy.check")).toMatchObject({ operation: "repair" });
  });

  it("取消大批修复后保留原数据，未写入完成标记", async () => {
    const value = await polluted(20000);
    const host = await start(value.root);
    await host.request("library.legacy.start");
    const deadline = Date.now() + 20000;
    while (true) {
      const status = await host.request<LegacyImportSnapshot>("library.legacy.status");
      expect(status.state, status.error).toBe("running");
      if (status.phase === "importing") break;
      if (Date.now() >= deadline) throw new Error("修复未进入可取消的合并阶段");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await host.request("library.legacy.cancel");
    expect((await finished(host)).state).toBe("cancelled");
    expect(await host.request("library.summary")).toMatchObject({ total: 20002 });
    expect(await host.request("library.legacy.check")).toMatchObject({ operation: "repair" });
    await host.request("library.legacy.start");
    const retried = await finished(host);
    expect(retried, retried.error).toMatchObject({ state: "completed", removedWorks: 20000 });
    expect(await host.request("library.summary")).toMatchObject({ total: 2 });
  });

  it.runIf(Boolean(process.env.JAVM_TEST_OLD_IMPORT_EXE))(
    "使用修复前原生程序重现膨胀，再由新版修复",
    async () => {
      const value = await fixture(6, 200, process.env.JAVM_TEST_OLD_IMPORT_EXE);
      await importFixture(value);
      expect(await value.host.request("library.summary")).toMatchObject({ total: 206 });
      await value.host.close();
      const host = await start(value.root);
      await host.request("library.legacy.start");
      const result = await finished(host);
      expect(result, result.error).toMatchObject({ state: "completed", removedWorks: 200 });
      expect(await host.request("library.summary")).toMatchObject({ total: 6 });
    },
  );
});
