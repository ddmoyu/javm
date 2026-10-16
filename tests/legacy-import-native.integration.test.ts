import { afterEach, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { MediaHost } from "./helpers/mediaHost";
import type { LegacyImportSnapshot } from "../frontend/src/contracts/legacyImport";

const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
const project = fileURLToPath(new URL("../", import.meta.url));
const schema = await fs.readFile(path.join(project, "tests/fixtures/legacy-0.5.3.sql"), "utf8");

describe.runIf(enabled)("旧库启动引导与合并导入", () => {
  const hosts: MediaHost[] = [];
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
  });
  async function hostAt(root: string) {
    const host = new MediaHost();
    hosts.push(host);
    await host.start(path.join(root, "JAVM/downloads-v1.sqlite3"));
    await host.request("library.status");
    return host;
  }
  async function fixture(extra = "") {
    await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
    const root = await fs.mkdtemp(path.join(project, ".tmp/legacy-import-"));
    const source = path.join(root, "com.ddmoyu.javm/javm.db");
    await fs.mkdir(path.dirname(source), { recursive: true });
    const old = new DatabaseSync(source);
    old.exec(schema);
    old.exec(`INSERT INTO directories(id,path) VALUES('old-directory','C:/synthetic');
      INSERT INTO videos(id,title,video_path,dir_path) VALUES('old-video','旧资料','C:/synthetic/legacy.mp4','C:/synthetic');`);
    if (extra) old.exec(extra);
    old.close();
    return { root, source, target: path.join(root, "JAVM/library.sqlite3") };
  }
  async function finished(host: MediaHost) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const status = await host.request<LegacyImportSnapshot>("library.legacy.status");
      if (status.state !== "running") return status;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error("导入任务未在预期时间内结束");
  }
  it("无旧库时不提示；发现旧库只返回候选，不自动导入或删除", async () => {
    const { root, source, target } = await fixture();
    const host = await hostAt(root);
    const candidate = await host.request<LegacyImportSnapshot>("library.legacy.check");
    expect(candidate.state).toBe("available");
    expect(path.normalize(candidate.sourcePath!)).toBe(source);
    expect((await fs.stat(source)).isFile()).toBe(true);
    const db = new DatabaseSync(target, { readOnly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM works").get()?.n).toBe(0);
    db.close();
    await fs.rename(source, `${source}.kept`);
    expect((await host.request<LegacyImportSnapshot>("library.legacy.check")).state).toBe("none");
  });
  it("旧程序持有数据库写句柄时拒绝导入，关闭后可以重试", async () => {
    const { root, source } = await fixture();
    const host = await hostAt(root);
    const old = new DatabaseSync(source);
    try {
      await host.request("library.legacy.start");
      expect((await finished(host)).error).toContain("退出旧版");
      expect((await fs.stat(source)).isFile()).toBe(true);
    } finally {
      old.close();
    }
    await host.request("library.legacy.start");
    expect((await finished(host)).state).toBe("completed");
  });
  it("无效关联使整次合并回滚，保留旧库且允许再次提示", async () => {
    const { root, source, target } = await fixture(
      "PRAGMA foreign_keys=OFF; INSERT INTO video_actors(video_id,actor_id) VALUES('old-video',999);",
    );
    const host = await hostAt(root);
    await host.request("library.legacy.start");
    const result = await finished(host);
    expect(result.state).toBe("failed");
    expect(result.error).toContain("关联记录缺失");
    const db = new DatabaseSync(target, { readOnly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM works").get()?.n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM javm_legacy_imports").get()?.n).toBe(0);
    db.close();
    expect((await fs.stat(source)).isFile()).toBe(true);
    expect((await host.request<LegacyImportSnapshot>("library.legacy.check")).state).toBe(
      "available",
    );
  });
  it("取消后台导入后保留新旧库，不写成功记录", async () => {
    const { root, source, target } = await fixture(
      "CREATE TABLE synthetic_payload(bytes BLOB); INSERT INTO synthetic_payload VALUES(zeroblob(16777216));",
    );
    const host = await hostAt(root);
    await host.request("library.legacy.start");
    await host.request("library.legacy.cancel");
    expect((await finished(host)).state).toBe("cancelled");
    expect((await fs.stat(source)).isFile()).toBe(true);
    const db = new DatabaseSync(target, { readOnly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM works").get()?.n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM javm_legacy_imports").get()?.n).toBe(0);
    db.close();
  });
  it("合并已经写入部分记录后取消，事务回滚且扩展仍可查询", async () => {
    const { root, source, target } =
      await fixture(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5000)
      INSERT INTO videos(id,title,video_path,dir_path) SELECT 'row-'||x,'合成影片','C:/synthetic/'||x||'.mp4','C:/synthetic' FROM n;`);
    const host = await hostAt(root);
    await host.request("library.legacy.start");
    let observed = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const state = await host.request<LegacyImportSnapshot>("library.legacy.status");
      if (state.phase === "importing" && (state.processed ?? 0) > 128) {
        observed = true;
        break;
      }
      if (state.state !== "running") throw new Error(JSON.stringify(state));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(observed).toBe(true);
    await host.request("library.legacy.cancel");
    expect((await finished(host)).state).toBe("cancelled");
    expect(await host.request("library.summary")).toMatchObject({ total: 0 });
    expect((await fs.stat(source)).isFile()).toBe(true);
    const db = new DatabaseSync(target, { readOnly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM javm_legacy_imports").get()?.n).toBe(0);
    db.close();
  }, 30000);
  it("旧版异常退出遗留 WAL 时，连同已提交的新数据一起备份导入", async () => {
    const { root, source, target } = await fixture();
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.env.JAVM_LEGACY_FIXTURE); db.exec(\"PRAGMA journal_mode=WAL; INSERT INTO videos(id,title,video_path,dir_path) VALUES('wal-video','WAL 合成影片','C:/synthetic/wal.mp4','C:/synthetic');\"); console.log('ready'); setInterval(()=>{},1000);",
      ],
      {
        windowsHide: true,
        env: { ...process.env, JAVM_LEGACY_FIXTURE: source },
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
    });
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill();
    });
    expect((await fs.stat(`${source}-wal`)).size).toBeGreaterThan(0);
    const host = await hostAt(root);
    await host.request("library.legacy.start");
    const result = await finished(host);
    expect(result.error).toBeFalsy();
    expect(result.state).toBe("completed");
    const db = new DatabaseSync(target, { readOnly: true });
    expect(db.prepare("SELECT title FROM works WHERE title='WAL 合成影片'").get()?.title).toBe(
      "WAL 合成影片",
    );
    db.close();
    await expect(fs.stat(source)).rejects.toThrow();
    await expect(fs.stat(`${source}-wal`)).rejects.toThrow();
    await expect(fs.stat(`${source}-shm`)).rejects.toThrow();
  });
  it("成功后旧文件无法移除时保存完成记录，重启也不重复导入", async () => {
    const { root, source, target } = await fixture();
    let host = await hostAt(root);
    // 只读占用允许备份，但不给删除共享权；模拟清理阶段文件仍被其他程序使用。
    const holder = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "$file = [System.IO.File]::Open($env:JAVM_LEGACY_FIXTURE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read); [Console]::WriteLine('ready'); [Console]::ReadLine() | Out-Null; $file.Dispose()",
      ],
      {
        windowsHide: true,
        env: { ...process.env, JAVM_LEGACY_FIXTURE: source },
      },
    );
    await new Promise<void>((resolve, reject) => {
      holder.stdout.once("data", () => resolve());
      holder.once("error", reject);
      holder.once("exit", (code) => {
        if (code) reject(new Error("无法持有测试文件"));
      });
    });
    try {
      await host.request("library.legacy.start");
      const result = await finished(host);
      expect(result.state).toBe("completed");
      expect(result.warning).toContain("原数据库及配套文件已保留");
      expect((await fs.stat(source)).isFile()).toBe(true);
      await host.close();
      host = await hostAt(root);
      expect((await host.request<LegacyImportSnapshot>("library.legacy.check")).state).toBe("none");
      const db = new DatabaseSync(target, { readOnly: true });
      expect(db.prepare("SELECT COUNT(*) AS n FROM works").get()?.n).toBe(1);
      db.close();
    } finally {
      holder.stdin.end("\n");
    }
  });
});
