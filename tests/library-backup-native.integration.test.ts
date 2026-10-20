import { afterEach, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
import type { BackupStatus } from "../frontend/src/contracts/libraryBackup";

const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
const hosts: MediaHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});
async function fixture() {
  await fs.mkdir(".tmp", { recursive: true });
  const root = path.resolve(await fs.mkdtemp(".tmp/backup-safe-"));
  const host = new MediaHost();
  hosts.push(host);
  await host.start(path.join(root, "downloads.sqlite3"));
  await host.request("library.status");
  const database = path.join(root, "library.sqlite3");
  const db = new DatabaseSync(database);
  db.exec("INSERT INTO works(id,code,title,favorite) VALUES('safe-1','SAFE-001','安全合成作品',1)");
  db.close();
  return { root, host, database };
}
async function finish(host: MediaHost) {
  for (let i = 0; i < 2000; i++) {
    const state = await host.request<BackupStatus>("library.backup.status");
    if (state.state !== "running") return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("安全备份任务超时");
}
async function run(host: MediaHost, operation: string, params: object) {
  await host.request("library.backup.start", { id: crypto.randomUUID(), operation, ...params });
  return finish(host);
}
describe.runIf(enabled)("片库一致性备份恢复", { timeout: 40000 }, () => {
  it("归档后进程中断且主库缺失时不会新建空库，可再次选择备份完成恢复", async () => {
    const { root, host, database } = await fixture();
    const created = await run(host, "create", { directory: root });
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    const archived = path.join(root, "interrupted-original.sqlite3");
    await fs.rename(database, archived);
    const original = await fs.readFile(archived);
    await fs.writeFile(`${database}.restore-pending`, root);
    const restart = new MediaHost();
    hosts.push(restart);
    await restart.start(path.join(root, "downloads.sqlite3"));
    expect(await restart.request("library.status")).toHaveProperty("recoveryError");
    expect(await fs.stat(database).catch(() => null)).toBeNull();
    const restored = await run(restart, "restore", { path: created.result!.path });
    expect(restored.state, restored.error).toBe("completed");
    expect(await restart.request("library.summary")).toMatchObject({ total: 1 });
    expect(await fs.readFile(archived)).toEqual(original);
  });
  it("损坏片库仍可进入恢复入口，原文件归档且下次启动读取已恢复数据", async () => {
    const { root, host, database } = await fixture();
    const created = await run(host, "create", { directory: root });
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    const original = Buffer.from("safe damaged database, must preserve these bytes");
    await fs.writeFile(database, original);
    const broken = new MediaHost();
    hosts.push(broken);
    await broken.start(path.join(root, "downloads.sqlite3"));
    expect(await broken.request("library.instance.claim", { args: [] })).toMatchObject({
      primary: true,
    });
    expect(await broken.request("library.status")).toHaveProperty("recoveryError");
    expect((await run(broken, "inspect", { path: created.result!.path })).state).toBe("completed");
    const result = await run(broken, "restore", { path: created.result!.path });
    expect(result.state, result.error).toBe("completed");
    expect(await fs.readFile(path.join(result.result!.rollbackPath!, "library.sqlite3"))).toEqual(
      original,
    );
    expect(await broken.request("library.summary")).toMatchObject({ total: 1 });
    await broken.close();
    hosts.splice(hosts.indexOf(broken), 1);
    const restarted = new MediaHost();
    hosts.push(restarted);
    await restarted.start(path.join(root, "downloads.sqlite3"));
    expect(await restarted.request("library.summary")).toMatchObject({ total: 1 });
    expect(await fs.stat(`${database}.restore-pending`).catch(() => null)).toBeNull();
  });
  it("备份包含 WAL 提交，恢复替换资料且保留恢复前副本，并清除旧启动请求", async () => {
    const { root, host, database } = await fixture();
    const created = await run(host, "create", { directory: root });
    expect(created.state, created.error).toBe("completed");
    expect(created.result).toMatchObject({ works: 1, favorites: 1 });
    const db = new DatabaseSync(database);
    db.exec(
      "UPDATE works SET title='恢复前修改'; INSERT INTO works(id,title) VALUES('safe-2','后续新增');",
    );
    db.close();
    const selected = new DatabaseSync(created.result!.path);
    selected.exec("INSERT INTO app_launches(payload) VALUES('[\"javm://search?code=SAFE-001\"]')");
    selected.close();
    expect((await run(host, "inspect", { path: created.result!.path })).state).toBe("completed");
    const restored = await run(host, "restore", { path: created.result!.path });
    expect(restored.state, restored.error).toBe("completed");
    const current = new DatabaseSync(database, { readOnly: true });
    const previous = new DatabaseSync(restored.result!.rollbackPath!, { readOnly: true });
    try {
      expect(current.prepare("SELECT title,favorite FROM works").all()).toEqual([
        { title: "安全合成作品", favorite: 1 },
      ]);
      expect(previous.prepare("SELECT count(*) AS n FROM works").get()?.n).toBe(2);
      expect(current.prepare("SELECT count(*) AS n FROM app_launches").get()?.n).toBe(0);
      expect(current.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
      expect(current.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      current.close();
      previous.close();
    }
    expect((await fs.readdir(root)).some((file) => file.endsWith(".partial"))).toBe(false);
    expect(await host.request("library.summary")).toMatchObject({ total: 1 });
  });
  it("损坏、缺失结构和同一数据库均拒绝恢复，原片库保留", async () => {
    const { root, host, database } = await fixture();
    const bad = path.join(root, "bad.sqlite3");
    await fs.writeFile(bad, "safe invalid database");
    expect((await run(host, "restore", { path: bad })).state).toBe("failed");
    const created = await run(host, "create", { directory: root });
    const incomplete = new DatabaseSync(created.result!.path);
    incomplete.exec("DROP TABLE playback_progress");
    incomplete.close();
    expect((await run(host, "restore", { path: created.result!.path })).error).toContain("结构");
    expect((await run(host, "restore", { path: database })).error).toContain("正在使用");
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      expect(db.prepare("SELECT title FROM works").get()?.title).toBe("安全合成作品");
    } finally {
      db.close();
    }
  });
  it("同一请求重放不重复创建；取消和状态查询不等待数据库锁", async () => {
    const { root, host, database } = await fixture();
    const db = new DatabaseSync(database);
    db.exec(
      "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<12000) INSERT INTO works(id,title,plot) SELECT 'bulk-'||i,'安全样例',hex(zeroblob(2048)) FROM n",
    );
    db.close();
    const input = { id: crypto.randomUUID(), operation: "create", directory: root };
    await host.request("library.backup.start", input);
    const start = Date.now();
    await host.request("library.backup.cancel");
    expect(Date.now() - start).toBeLessThan(3000);
    const state = await finish(host);
    expect(["cancelled", "completed"]).toContain(state.state);
    await host.request("library.backup.start", input);
    expect((await finish(host)).id).toBe(input.id);
    const names = await fs.readdir(root);
    expect(names.filter((name) => name.startsWith("javm-library-")).length).toBe(
      state.state === "completed" ? 1 : 0,
    );
  });
});
