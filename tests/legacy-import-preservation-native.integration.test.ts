import { afterEach, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MediaHost } from "./helpers/mediaHost";
import type { NativeVideo } from "../frontend/src/contracts/library";
import type { LegacyImportSnapshot } from "../frontend/src/contracts/legacyImport";

const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
const project = fileURLToPath(new URL("../", import.meta.url));
const schema = await fs.readFile(path.join(project, "tests/fixtures/legacy-0.5.3.sql"), "utf8");
const hosts: MediaHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

function database<T>(file: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file);
  try {
    return action(db);
  } finally {
    db.close();
  }
}

async function fixture() {
  await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
  const root = await fs.mkdtemp(path.join(project, ".tmp/legacy-preservation-"));
  const source = path.join(root, "com.ddmoyu.javm/javm.db");
  const target = path.join(root, "JAVM/library.sqlite3");
  const file = path.join(root, "media/SAFE-001.mp4");
  await fs.mkdir(path.dirname(source));
  await fs.mkdir(path.dirname(file));
  database(source, (db) => {
    db.exec(schema);
    db.prepare(
      `INSERT INTO videos(id,local_id,title,original_title,video_path,dir_path,
        file_size,file_mtime,fast_hash,resolution,duration,scan_status)
       VALUES('legacy-work','SAFE-001','SAFE-001','SAFE-001',?,?,64,123,'old-hash','1280x720',60,1)`,
    ).run(file, path.dirname(file));
  });
  const host = new MediaHost();
  hosts.push(host);
  await host.start(path.join(root, "JAVM/downloads-v1.sqlite3"));
  await host.request("library.status");
  return { host, root, source, target, file };
}

function existingResource(target: string, file: string) {
  database(target, (db) => {
    db.exec(
      "INSERT INTO works(id,code,code_key,title,favorite,scan_status) VALUES('current-work','SAFE-001','safe001','新版合成标题',1,2)",
    );
    db.prepare(
      "INSERT INTO media_files(id,work_id,path,path_key,dir_path) VALUES('current-media','current-work',?,?,?)",
    ).run(file, file.replaceAll("\\", "/").toLowerCase(), path.dirname(file));
  });
}

async function importLegacy(host: MediaHost) {
  await host.request("library.legacy.start");
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const state = await host.request<LegacyImportSnapshot>("library.legacy.status");
    if (state.state !== "running") {
      expect(state.state, state.error).toBe("completed");
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("合成数据库迁移超时");
}

describe.runIf(enabled)("旧库迁移保留新版信息及资源可用性", { timeout: 30000 }, () => {
  it("同路径合并保留新版非空技术信息、签名、零时间戳和资料状态", async () => {
    const { host, source, target, file } = await fixture();
    // 安全字节占位文件，不探测、不播放，也不加载任何真实媒体。
    await fs.writeFile(file, Buffer.alloc(96));
    database(source, (db) => db.exec("UPDATE videos SET file_size=NULL"));
    existingResource(target, file);
    const expected = database(target, (db) => {
      db.exec(
        `UPDATE media_files SET file_size=4096,file_mtime=0,fast_hash='new-hash',
          file_stamp='retained-signature',width=3840,height=2160,duration_ms=72000,codec='AV1'`,
      );
      return db.prepare("SELECT * FROM media_files").get();
    });
    const result = await importLegacy(host);
    expect(database(target, (db) => db.prepare("SELECT * FROM media_files").get())).toEqual(
      expected,
    );
    expect(await host.request("library.video", { id: "current-work" })).toMatchObject({
      title: "新版合成标题",
      favorite: 1,
      scan_status: 2,
      resolution: "3840x2160",
    });
    expect(
      database(result.targetBackupPath!, (db) => db.prepare("SELECT * FROM media_files").get()),
    ).toEqual(expected);
  });

  it("同路径资源仅补空字段，离线视频继续保留资源关联", async () => {
    const { host, target, file } = await fixture();
    existingResource(target, file);
    await importLegacy(host);
    expect(database(target, (db) => db.prepare("SELECT * FROM media_files").get())).toMatchObject({
      id: "current-media",
      work_id: "current-work",
      file_size: 64,
      file_mtime: 123,
      fast_hash: "old-hash",
      width: 1280,
      height: 720,
      duration_ms: 60000,
      codec: "",
      file_stamp: "",
      missing: 1,
    });
    expect(await host.request("library.video", { id: "current-work" })).toMatchObject({
      availability: "unavailable",
      favorite: 1,
      scan_status: 2,
    });
  });

  it("新导入的可访问资源无需重扫即可保存截图和准备文件整理", async () => {
    const { host, target, file } = await fixture();
    const content = Buffer.alloc(96);
    await fs.writeFile(file, content);
    await importLegacy(host);
    const resource = database(target, (db) => db.prepare("SELECT * FROM media_files").get()!);
    expect(resource.file_stamp).toMatch(/^96:-?\d+$/);
    expect(resource.missing).toBe(0);
    expect(await host.request("library.artwork.pending")).toEqual([
      expect.objectContaining({ id: resource.work_id, file_stamp: resource.file_stamp }),
    ]);
    const artwork = await host.request<{ directory: string }>("library.artwork.prepare", {
      id: resource.work_id,
    });
    // 只用于原生签名校验的安全夹具，不含图像内容，不做解码或显示。
    const image = path.join(artwork.directory, `${randomUUID()}.jpg`);
    await fs.writeFile(image, Buffer.from([255, 216, 255, 217]));
    await host.request("library.artwork.commit", {
      id: resource.work_id,
      images: [{ path: image, kind: "screenshot", seconds: 1 }],
      video: { id: resource.id, file_stamp: resource.file_stamp },
    });
    const operation = await host.request<{ id: string; state: string }>("library.files.prepare", {
      mediaId: resource.id,
      source: file,
      target: path.join(path.dirname(file), "SAFE-001-copy.mp4"),
    });
    expect(operation.state).toBe("copying");
    await host.request("library.files.abort", { id: operation.id });
    expect(await fs.readFile(file)).toEqual(content);
  });

  it.each([0, 1, 2])("保留旧版资料完整性（旧状态 %i）及文件名标题来源", async (status) => {
    const { host, source, target } = await fixture();
    database(source, (db) => {
      db.prepare("UPDATE videos SET scan_status=?,title=?,nfo_mtime=?").run(
        status,
        status === 2 ? "已刮削合成标题" : "SAFE-001",
        status === 2 ? 123 : null,
      );
    });
    await importLegacy(host);
    const [work] = await host.request<NativeVideo[]>("library.videos");
    expect(work?.scan_status).toBe(status === 2 ? 2 : 1);
    const missing = await host.request<{ items: NativeVideo[] }>("library.query", {
      filters: { metadata: "missing" },
    });
    expect(missing.items).toHaveLength(status === 2 ? 0 : 1);
    const record = database(target, (db) => db.prepare("SELECT provenance FROM works").get()!);
    const provenance = JSON.parse(String(record.provenance));
    expect(provenance._filenameTitle).toBe(status === 2 ? undefined : "SAFE-001");
    expect(work?.title).toBe(status === 2 ? "已刮削合成标题" : "SAFE-001");
  });

  it("缺封面但已有 NFO 的标题不误标为文件名占位", async () => {
    const { host, source, target } = await fixture();
    database(source, (db) => db.exec("UPDATE videos SET nfo_mtime=123"));
    await importLegacy(host);
    const record = database(target, (db) =>
      db.prepare("SELECT scan_status,provenance FROM works").get()!,
    );
    expect(record.scan_status).toBe(1);
    expect(JSON.parse(String(record.provenance))).toMatchObject({ title: "SAFE-001" });
    expect(JSON.parse(String(record.provenance))).not.toHaveProperty("_filenameTitle");
  });
});
