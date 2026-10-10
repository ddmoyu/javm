import { afterEach, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLibraryFixture } from "./helpers/libraryFixture";
import { MediaHost } from "./helpers/mediaHost";
import type { LibraryStatus, NativeVideo } from "../frontend/src/contracts/library";
import type { MaintenanceVideo, RemovalPlan } from "../frontend/src/contracts/maintenance";

const project = fileURLToPath(new URL("../", import.meta.url));
const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
const hosts: MediaHost[] = [];
const databases: DatabaseSync[] = [];
const key = (value: string) => value.replaceAll("\\", "/").toLowerCase();
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const host of hosts.splice(0)) await host.close();
});

async function fixture(seedRemoval = false) {
  await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
  const root = await fs.mkdtemp(path.join(project, ".tmp/directory-closure-"));
  const folder = path.join(root, "安全合成");
  await fs.mkdir(folder);
  const filename = path.join(root, "library.sqlite3");
  const seed = createLibraryFixture(filename);
  if (seedRemoval) {
    seed
      .prepare("INSERT INTO directories(id,path,path_key) VALUES('root',?,?)")
      .run(folder, key(folder));
    seed.exec(
      "INSERT INTO works(id,title,code,code_key,favorite) VALUES('work','合成纪录片','TEST-001','test001',1)",
    );
    for (const id of ["keep", "copy", "gone"]) {
      const file = path.join(folder, `${id}.mp4`);
      if (id !== "gone") await fs.writeFile(file, "safe synthetic fixture for file removal");
      seed
        .prepare(
          "INSERT INTO media_files(id,work_id,path,path_key,dir_path,file_size,missing) VALUES(?,'work',?,?,?,?,?)",
        )
        .run(id, file, key(file), folder, 38, Number(id === "gone"));
    }
    await fs.writeFile(path.join(folder, "copy.srt"), "safe synthetic subtitle");
    await fs.writeFile(path.join(folder, "copy.nfo"), "<movie><title>合成纪录片</title></movie>");
  }
  seed.close();
  const host = new MediaHost();
  hosts.push(host);
  await host.start(path.join(root, "downloads.sqlite3"));
  await host.request("library.status");
  const database = new DatabaseSync(filename);
  databases.push(database);
  return { root, folder, host, database };
}

const guarded = (folder: string, retained = "keep") => ({
  token: crypto.randomUUID(),
  id: "copy",
  path: path.join(folder, "copy.mp4"),
  metadataOnly: false,
  requireRetainedCopy: true,
  retained: { id: retained, path: path.join(folder, `${retained}.mp4`) },
});
async function finish(host: MediaHost) {
  for (let count = 0; count < 1000; count++) {
    const status = await host.request<LibraryStatus>("library.status");
    if (status.scan?.state !== "scanning") return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("合成扫描未按时结束");
}
function sample(file: string, size = "160x90") {
  execFileSync(
    process.env.JAVM_FFMPEG || "ffmpeg.exe",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=navy:s=${size}:d=1`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      file,
    ],
    { windowsHide: true, timeout: 20000 },
  );
}

describe.runIf(enabled)("目录清理修复：隔离原生文件与数据库", { timeout: 30000 }, () => {
  it("候选返回缺失状态，拒绝缺失或同一文件充当保留副本", async () => {
    const { host, folder, database } = await fixture(true);
    const result = await host.request<{ items: MaintenanceVideo[] }>("library.maintenance.read");
    expect(result.items.find((video) => video.id === "gone")?.missing).toBe(true);
    expect(result.items.find((video) => video.id === "copy")?.missing).toBe(false);
    await expect(
      host.request("library.maintenance.prepare", guarded(folder, "gone")),
    ).rejects.toThrow("已丢失");
    await expect(
      host.request("library.maintenance.prepare", guarded(folder, "copy")),
    ).rejects.toThrow("身份已变化");
    const { retained: _retained, ...withoutCopy } = guarded(folder);
    await expect(host.request("library.maintenance.prepare", withoutCopy)).rejects.toThrow(
      "需要保留",
    );
    expect(await fs.readFile(path.join(folder, "copy.mp4"), "utf8")).toContain("safe synthetic");
    expect(database.prepare("SELECT count(*) AS count FROM media_files").get()?.count).toBe(3);
  });

  it("生成删除清单后，保留文件变化或丢失会阻止后续文件删除", async () => {
    const { host, folder } = await fixture(true);
    const request = guarded(folder);
    const plan = await host.request<RemovalPlan>("library.maintenance.prepare", request);
    const keep = path.join(folder, "keep.mp4");
    await fs.appendFile(keep, " changed");
    await expect(
      host.request("library.maintenance.checkFile", {
        token: request.token,
        path: plan.files[0]!.path,
      }),
    ).rejects.toThrow("保留的视频已变化");
    await host.request("library.maintenance.abort", { token: request.token });
    const retry = guarded(folder);
    const second = await host.request<RemovalPlan>("library.maintenance.prepare", retry);
    await fs.rename(keep, `${keep}.hold`);
    await expect(
      host.request("library.maintenance.checkFile", {
        token: retry.token,
        path: second.files[0]!.path,
      }),
    ).rejects.toThrow("已丢失");
    await host.request("library.maintenance.abort", { token: retry.token });
    expect(await fs.readFile(path.join(folder, "copy.srt"), "utf8")).toContain("synthetic");
    expect(await fs.stat(path.join(folder, "copy.mp4"))).toBeTruthy();
  });

  it("保留副本可用时删除重复文件与独占字幕，作品资料和收藏仍保留", async () => {
    const { host, folder, root, database } = await fixture(true);
    const request = guarded(folder);
    const plan = await host.request<RemovalPlan>("library.maintenance.prepare", request);
    for (const file of plan.files) {
      expect(path.resolve(file.path).startsWith(path.resolve(root) + path.sep)).toBe(true);
      const checked = await host.request<{ exists: boolean }>("library.maintenance.checkFile", {
        token: request.token,
        path: file.path,
      });
      if (checked.exists) await fs.unlink(file.path);
    }
    await host.request("library.maintenance.complete", { token: request.token });
    expect(database.prepare("SELECT id FROM media_files WHERE id='copy'").get()).toBeUndefined();
    expect(database.prepare("SELECT favorite FROM works WHERE id='work'").get()?.favorite).toBe(1);
    expect(await fs.stat(path.join(folder, "keep.mp4"))).toBeTruthy();
    expect(await fs.stat(path.join(folder, "copy.nfo"))).toBeTruthy();
    expect((await host.request<LibraryStatus>("library.status")).directories[0]?.video_count).toBe(
      1,
    );
  });

  it("清理缺失记录时文件重新出现，不提交过时的数据库删除", async () => {
    const { host, folder, database } = await fixture(true);
    const token = crypto.randomUUID();
    const file = path.join(folder, "gone.mp4");
    await host.request("library.maintenance.prepare", {
      token,
      id: "gone",
      path: file,
      metadataOnly: false,
      requireRetainedCopy: true,
    });
    await fs.writeFile(file, "safe restored fixture");
    await expect(host.request("library.maintenance.complete", { token })).rejects.toThrow("已恢复");
    await host.request("library.maintenance.abort", { token });
    expect(database.prepare("SELECT id FROM media_files WHERE id='gone'").get()).toBeTruthy();
  });

  it("首次扫描损坏 NFO 仍保存真实视频参数，修复 NFO 后重扫复用视频记录", async () => {
    const { host, folder, database } = await fixture();
    const file = path.join(folder, "TEST-001.mp4");
    const nfo = path.join(folder, "TEST-001.nfo");
    sample(file);
    await fs.writeFile(nfo, "<movie><title>未闭合合成资料");
    const added = await host.request<{ directoryId: string }>("library.add", { path: folder });
    const first = await finish(host);
    expect(first.scan).toMatchObject({ state: "partial", imported: 1 });
    const before = database
      .prepare("SELECT id,work_id,width,height,duration_ms FROM media_files")
      .get();
    expect(before).toMatchObject({ width: 160, height: 90, duration_ms: 1000 });
    expect(database.prepare("SELECT count(*) AS count FROM nfo_documents").get()?.count).toBe(0);
    await fs.writeFile(nfo, "<movie><title>修复后的合成纪录片</title><num>TEST-001</num></movie>");
    await host.request("library.scan", { id: added.directoryId });
    expect((await finish(host)).scan?.state).toBe("completed");
    expect(database.prepare("SELECT id FROM media_files").get()?.id).toBe(before?.id);
    const work = await host.request<NativeVideo>("library.video", { id: before?.work_id });
    expect(work.title).toBe("修复后的合成纪录片");
    expect(work.width).toBe(160);
  });

  it("已有 NFO 损坏时保留资料和快照，同时更新变更视频的分辨率", async () => {
    const { host, folder, database } = await fixture();
    const file = path.join(folder, "TEST-002.mp4");
    const nfo = path.join(folder, "TEST-002.nfo");
    sample(file);
    await fs.writeFile(nfo, "<movie><title>已保存的合成资料</title><num>TEST-002</num></movie>");
    const added = await host.request<{ directoryId: string }>("library.add", { path: folder });
    await finish(host);
    const before = database.prepare("SELECT id,work_id FROM media_files").get();
    const snapshot = database.prepare("SELECT stamp,content FROM nfo_documents").get();
    await fs.writeFile(nfo, "<movie><title>损坏资料");
    sample(file, "320x180");
    await host.request("library.scan", { id: added.directoryId });
    expect((await finish(host)).scan?.state).toBe("partial");
    const work = await host.request<NativeVideo>("library.video", { id: before?.work_id });
    expect(work).toMatchObject({ title: "已保存的合成资料", width: 320, height: 180 });
    expect(database.prepare("SELECT id FROM media_files").get()?.id).toBe(before?.id);
    expect(database.prepare("SELECT stamp,content FROM nfo_documents").get()).toEqual(snapshot);
  });
});
