import { afterEach, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MediaHost } from "./helpers/mediaHost";
import type { LegacyImportSnapshot } from "../frontend/src/contracts/legacyImport";
import type { NativeVideo } from "../frontend/src/contracts/library";

const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
const project = fileURLToPath(new URL("../", import.meta.url));
const schema = await fs.readFile(path.join(project, "tests/fixtures/legacy-0.5.3.sql"), "utf8");
const hosts: MediaHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});
async function fixture() {
  await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
  const root = await fs.mkdtemp(path.join(project, ".tmp/legacy-1.0-"));
  await fs.mkdir(path.join(root, "com.ddmoyu.javm"));
  await fs.mkdir(path.join(root, "JAVM"));
  const source = path.join(root, "com.ddmoyu.javm/javm.db");
  const old = new DatabaseSync(source);
  old.exec(schema);
  old.exec(
    "INSERT INTO actors(id,name) VALUES(1,'合成演员'); INSERT INTO genres(id,name) VALUES(1,'合成分类'); CREATE TABLE custom_bytes(content BLOB); INSERT INTO custom_bytes VALUES(X'00FF80');",
  );
  old
    .prepare(
      "INSERT INTO videos(id,local_id,title,video_path,dir_path,duration,rating,resolution) VALUES(?,?,?,?,?,6000,8,'1920x1080')",
    )
    .run(
      "old-1",
      "OLD-001",
      "旧版合成标题",
      path.join(root, "offline/movie.mp4"),
      path.join(root, "offline"),
    );
  old.exec(
    "INSERT INTO video_actors(video_id,actor_id,priority) VALUES('old-1',1,0); INSERT INTO video_genres VALUES('old-1',1);",
  );
  old.close();
  const host = new MediaHost();
  hosts.push(host);
  await host.start(path.join(root, "JAVM/downloads.sqlite3"));
  await host.request("library.status");
  return { host, source, target: path.join(root, "JAVM/library.sqlite3"), root };
}
async function finished(host: MediaHost) {
  for (let i = 0; i < 1000; i++) {
    const status = await host.request<LegacyImportSnapshot>("library.legacy.status");
    if (status.state !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("迁移超时");
}

describe.runIf(enabled)("0.5.3 独立迁移到 1.0", { timeout: 30000 }, () => {
  it("按作品与资源转换，保留关系、离线资源和全部原始字段；提交前后都有独立备份", async () => {
    const { host, source, target } = await fixture();
    expect(await host.request("library.legacy.check")).toMatchObject({ state: "available" });
    const before = await fs.readFile(source);
    await host.request("library.legacy.start");
    const result = await finished(host);
    expect(result.state, result.error).toBe("completed");
    const works = await host.request<NativeVideo[]>("library.videos");
    expect(works).toHaveLength(1);
    expect(works[0]).toMatchObject({
      local_id: "OLD-001",
      title: "旧版合成标题",
      availability: "unavailable",
      actors: ["合成演员"],
      genres: ["合成分类"],
      duration: 6000,
      rating: 8,
    });
    expect(works[0]!.media_files).toHaveLength(1);
    const db = new DatabaseSync(target, { readOnly: true });
    const backup = new DatabaseSync(result.backupPath!, { readOnly: true });
    const previous = new DatabaseSync(result.targetBackupPath!, { readOnly: true });
    try {
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        db.prepare("SELECT count(*) AS n FROM legacy_records WHERE table_name='custom_bytes'").get()
          ?.n,
      ).toBe(1);
      const archived = db
        .prepare(
          "SELECT hex(content) AS content FROM legacy_records WHERE table_name='custom_bytes'",
        )
        .get()?.content;
      expect(String(archived)).toContain("00FF80");
      expect(backup.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
      expect(backup.prepare("SELECT hex(content) AS value FROM custom_bytes").get()?.value).toBe(
        "00FF80",
      );
      expect(previous.prepare("SELECT count(*) AS n FROM works").get()?.n).toBe(0);
    } finally {
      db.close();
      backup.close();
      previous.close();
    }
    expect(before.length).toBeGreaterThan(0);
    expect(await host.request("library.legacy.check")).toMatchObject({ state: "none" });
    await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("未知旧版本拒绝导入，原库不动，新库无半成品", async () => {
    const { host, source, target } = await fixture();
    const old = new DatabaseSync(source);
    old.exec("PRAGMA user_version=99");
    old.close();
    const before = await fs.readFile(source);
    await host.request("library.legacy.start");
    const result = await finished(host);
    expect(result.state).toBe("failed");
    expect(result.error).toContain("0.5.3");
    expect(await fs.readFile(source)).toEqual(before);
    const db = new DatabaseSync(target, { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM works").get()?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("中途失败回滚作品及原始记录，保留原库和备份", async () => {
    const { host, source, target } = await fixture();
    const db = new DatabaseSync(target);
    db.exec(
      "CREATE TRIGGER fixture_fail BEFORE INSERT ON works BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
    );
    db.close();
    const before = await fs.readFile(source);
    await host.request("library.legacy.start");
    expect((await finished(host)).state).toBe("failed");
    expect(await fs.readFile(source)).toEqual(before);
    const check = new DatabaseSync(target, { readOnly: true });
    try {
      expect(check.prepare("SELECT count(*) AS n FROM works").get()?.n).toBe(0);
      expect(check.prepare("SELECT count(*) AS n FROM legacy_records").get()?.n).toBe(0);
      expect(check.prepare("SELECT count(*) AS n FROM javm_legacy_imports").get()?.n).toBe(0);
    } finally {
      check.close();
    }
  });

  it("旧路径匹配已存在资源时补充资料，保留新版标题、收藏和作品身份", async () => {
    const { host, source, target, root } = await fixture();
    const id = "00000000-0000-4000-8000-000000000001";
    const old = new DatabaseSync(source);
    old.exec("UPDATE videos SET local_id='OLD-001'");
    old.close();
    const db = new DatabaseSync(target);
    const file = path.join(root, "offline/movie.mp4");
    db.prepare(
      "INSERT INTO works(id,title,code,code_key,favorite) VALUES(?,'新版标题','OLD-001','old001',1)",
    ).run(id);
    db.prepare(
      "INSERT INTO media_files(id,work_id,path_key,path,dir_path,missing) VALUES('file',?,?,?,?,1)",
    ).run(id, file.replaceAll("\\", "/").toLowerCase(), file, path.dirname(file));
    db.close();
    await host.request("library.legacy.start");
    const result = await finished(host);
    expect(result.state, result.error).toBe("completed");
    const works = await host.request<NativeVideo[]>("library.videos");
    expect(works).toHaveLength(1);
    expect(works[0]).toMatchObject({
      id,
      title: "新版标题",
      favorite: 1,
      actors: ["合成演员"],
      rating: 8,
    });
  });

  it("旧库悬空关联拒绝导入，保留原库；临时开发库不自动升级或改写", async () => {
    const { host, source, target, root } = await fixture();
    const old = new DatabaseSync(source);
    old.exec("PRAGMA foreign_keys=OFF; UPDATE video_actors SET actor_id=99");
    old.close();
    const original = await fs.readFile(source);
    await host.request("library.legacy.start");
    expect((await finished(host)).error).toContain("关联记录缺失");
    expect(await fs.readFile(source)).toEqual(original);
    await host.close();
    const db = new DatabaseSync(target);
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA user_version=6");
    db.close();
    const before = await fs.readFile(target);
    const reopened = new MediaHost();
    hosts.push(reopened);
    await reopened.start(path.join(root, "JAVM/downloads.sqlite3"));
    await expect(reopened.request("library.status")).rejects.toThrow("这不是 JAVM 1.0 片库");
    await reopened.close();
    expect(await fs.readFile(target)).toEqual(before);
  });
});
