import { afterEach, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLibraryFixture } from "./helpers/libraryFixture";
import { MediaHost } from "./helpers/mediaHost";
import type { MaintenanceVideo, RemovalPlan } from "../frontend/src/contracts/maintenance";
import type { LibraryStatus } from "../frontend/src/contracts/library";

const project = fileURLToPath(new URL("../", import.meta.url));
const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
const hosts: MediaHost[] = [],
  databases: DatabaseSync[] = [];
const key = (value: string) => value.replaceAll("\\", "/").toLowerCase();
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const host of hosts.splice(0)) await host.close();
});
async function fixture(seed = true) {
  await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
  const root = await fs.mkdtemp(path.join(project, ".tmp/duplicate-quality-"));
  const media = path.join(root, "安全合成");
  await fs.mkdir(media);
  const databasePath = path.join(root, "library.sqlite3");
  const initial = createLibraryFixture(databasePath);
  if (seed) {
    initial.exec(
      "INSERT INTO works(id,title,code,code_key,favorite) VALUES('work','合成纪录片','TEST-001','test001',1)",
    );
    for (const id of ["keep", "copy"]) {
      const file = path.join(media, `${id}.mp4`);
      await fs.writeFile(file, "safe synthetic file removal fixture");
      initial
        .prepare(
          "INSERT INTO media_files(id,work_id,path,path_key,dir_path,file_size,width,height,duration_ms,codec) VALUES(?,'work',?,?,?,?,1920,1080,3600123,'AVC')",
        )
        .run(id, file, key(file), media, (await fs.stat(file)).size);
    }
  }
  expect(
    initial.prepare("SELECT name FROM sqlite_master WHERE name='media_quality'").get(),
  ).toBeUndefined();
  initial.close();
  const host = new MediaHost();
  hosts.push(host);
  await host.start(path.join(root, "downloads.sqlite3"));
  await host.request("library.status");
  const database = new DatabaseSync(databasePath);
  databases.push(database);
  return { root, media, host, database };
}
const read = (host: MediaHost) =>
  host.request<{ items: MaintenanceVideo[] }>("library.maintenance.read");
async function finish(host: MediaHost) {
  for (let count = 0; count < 1000; count++) {
    const status = await host.request<LibraryStatus>("library.status");
    if (status.scan?.state !== "scanning") return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("安全合成视频扫描超时");
}
describe.runIf(enabled)("重复视频画质：隔离原生验证", () => {
  it("已有片库增量补表并返回作品、分段、编码和实际码率，保留原有资料", async () => {
    const { host, database } = await fixture();
    expect((await read(host)).items.every((video) => video.bitrate === null)).toBe(true);
    database.exec(
      "INSERT INTO media_quality VALUES('keep',8000000); INSERT INTO media_parts VALUES('keep',1,2)",
    );
    expect((await read(host)).items.find((video) => video.id === "keep")).toMatchObject({
      workId: "work",
      bitrate: 8_000_000,
      codec: "AVC",
      duration: 3600.123,
      part: 1,
      parts: 2,
    });
    expect(database.prepare("SELECT title,favorite FROM works").get()).toEqual({
      title: "合成纪录片",
      favorite: 1,
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("原生拒绝跨分段替代，确认同分段副本后只删除选中的合成文件及其码率记录", async () => {
    const { host, database, root, media } = await fixture();
    database.exec(
      "INSERT INTO media_parts VALUES('keep',1,2),('copy',2,2); INSERT INTO media_quality VALUES('keep',8000000),('copy',4000000)",
    );
    const input = {
      token: crypto.randomUUID(),
      id: "copy",
      path: path.join(media, "copy.mp4"),
      metadataOnly: false,
      requireRetainedCopy: true,
      retained: { id: "keep", path: path.join(media, "keep.mp4") },
    };
    await expect(host.request("library.maintenance.prepare", input)).rejects.toThrow("不同分段");
    expect(await fs.stat(input.path)).toBeTruthy();
    database.exec("UPDATE media_parts SET part_number=1 WHERE media_id='copy'");
    const plan = await host.request<RemovalPlan>("library.maintenance.prepare", {
      ...input,
      token: crypto.randomUUID(),
    });
    expect(plan.files).toHaveLength(1);
    for (const file of plan.files) {
      expect(path.resolve(file.path).startsWith(path.resolve(root) + path.sep)).toBe(true);
      expect(
        (
          await host.request<{ exists: boolean }>("library.maintenance.checkFile", {
            token: plan.token,
            path: file.path,
          })
        ).exists,
      ).toBe(true);
      await fs.unlink(file.path);
    }
    await host.request("library.maintenance.complete", { token: plan.token });
    await host.request("library.maintenance.abort", { token: plan.token });
    expect(database.prepare("SELECT media_id FROM media_quality").all()).toEqual([
      { media_id: "keep" },
    ]);
    expect(await fs.stat(input.retained.path)).toBeTruthy();
    expect(database.prepare("SELECT favorite FROM works").get()).toEqual({ favorite: 1 });
  });
  it("合成视频实际探测码率并持久化，旧记录补探测一次后复用缓存", async () => {
    const { host, database, media } = await fixture(false);
    const video = path.join(media, "TEST-001.mp4");
    execFileSync(
      process.env.JAVM_FFMPEG || "ffmpeg.exe",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:duration=2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        video,
      ],
      { windowsHide: true },
    );
    const added = await host.request<{ directoryId: string }>("library.add", { path: media });
    await finish(host);
    const first = (await read(host)).items[0]!;
    expect(first.bitrate).toBeGreaterThan(0);
    expect(first.codec).toBe("AVC");
    database.exec("DELETE FROM media_quality");
    await host.request("library.scan", { id: added.directoryId });
    expect((await finish(host)).scan?.peakProbes).toBeGreaterThan(0);
    expect((await read(host)).items[0]).toMatchObject({
      id: first.id,
      workId: first.workId,
      bitrate: first.bitrate,
    });
    await host.request("library.scan", { id: added.directoryId });
    expect((await finish(host)).scan?.peakProbes).toBe(0);
    expect(database.prepare("SELECT count(*) AS n FROM works").get()).toEqual({ n: 1 });
  });
});
