import { afterEach, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MediaHost } from "./helpers/mediaHost";
import type { LibraryStatus, NativeVideo } from "../frontend/src/contracts/library";
import type { ScrapeTarget } from "../frontend/src/services/scraping/ScrapeService";
import { toFilm } from "../frontend/src/services/library/LibraryService";

const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
const project = fileURLToPath(new URL("../", import.meta.url));
const candidate = { provider: "Fixture", id: "001", code: "TEST-001", title: "合成资料作品" };
const details = {
  ...candidate,
  homepage: "https://example.invalid/001",
  fields: {
    code: candidate.code,
    title: candidate.title,
    actors: ["合成演员"],
    genres: ["合成分类"],
    plot: "合成简介",
    rating: 4,
    duration: 100,
  },
};
const hosts: MediaHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});
async function fixture() {
  await fs.mkdir(path.join(project, ".tmp"), { recursive: true });
  const root = await fs.mkdtemp(path.join(project, ".tmp/metadata-library-"));
  const current = path.join(root, "JAVM");
  await fs.mkdir(current);
  const host = new MediaHost();
  hosts.push(host);
  await host.start(path.join(current, "downloads.sqlite3"));
  await host.request("library.status");
  return { root, current, host };
}
const prepare = async (host: MediaHost, params: Record<string, unknown>) => {
  const jobId = crypto.randomUUID();
  return {
    ...(await host.request<ScrapeTarget>("library.scrape.prepare", { jobId, ...params })),
    jobId,
  };
};
const commit = (host: MediaHost, target: ScrapeTarget) =>
  host.request<{ nfoPath: string }>("library.scrape.commit", {
    ...target,
    details,
  });
const video = (host: MediaHost, id: string) => host.request<NativeVideo>("library.video", { id });
async function finish(host: MediaHost) {
  for (let n = 0; n < 1000; n++) {
    const status = await host.request<LibraryStatus>("library.status");
    if (status.scan?.state !== "scanning") return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("扫描超时");
}
async function sample(file: string) {
  execFileSync(
    process.env.JAVM_FFMPEG || "ffmpeg.exe",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=navy:s=160x90:d=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      file,
    ],
    { windowsHide: true, timeout: 20000 },
  );
}

describe.runIf(enabled)("1.0 资料与视频独立闭环", { timeout: 30000 }, () => {
  it("无视频收藏落 NFO，重试保持身份，后补多个视频，删除后仍保留资料和收藏", async () => {
    const { host, current, root } = await fixture();
    const target = await prepare(host, { candidate, collect: true });
    expect(target.path).toBe("");
    const saved = await commit(host, target);
    const nfo = await fs.readFile(saved.nfoPath, "utf8");
    expect(nfo).toContain('type="javm-work"');
    expect(nfo).not.toContain("<fileinfo>");
    expect(await video(host, target.id)).toMatchObject({
      availability: "metadata_only",
      video_path: null,
      favorite: 1,
      scan_status: 2,
      actors: ["合成演员"],
    });
    const film = toFilm(await video(host, target.id), (p) => p);
    expect(film.files?.filter((file) => file.kind === "video")).toHaveLength(0);
    expect(film.files?.filter((file) => file.kind === "metadata")).toHaveLength(1);
    expect((await prepare(host, { candidate, collect: true })).id).toBe(target.id);
    const folder = path.join(root, "media");
    await fs.mkdir(folder);
    const first = path.join(folder, "TEST-001-cd1.mp4"),
      second = path.join(folder, "TEST-001-cd2.mp4");
    await sample(first);
    await fs.copyFile(first, second);
    expect((await prepare(host, { workId: target.id, path: first })).id).toBe(target.id);
    await host.request("library.add", { path: folder });
    expect((await finish(host)).scan?.state).toBe("completed");
    let work = await video(host, target.id);
    expect(work.media_files).toHaveLength(2);
    expect(work.nfo_path).toBe(saved.nfoPath);
    expect(work.availability).toBe("available");
    expect(await host.request("library.summary")).toMatchObject({ total: 1, favorites: 1 });
    const conflict = path.join(folder, "WRONG-002.mp4");
    await fs.copyFile(first, conflict);
    await expect(prepare(host, { workId: target.id, path: conflict })).rejects.toThrow("不一致");
    await fs.rm(conflict);
    for (const file of work.media_files!) {
      const token = crypto.randomUUID();
      const plan = await host.request<{ files: { path: string }[] }>(
        "library.maintenance.prepare",
        { token, id: file.id, path: file.path, metadataOnly: false },
      );
      expect(plan.files.map((entry) => entry.path)).not.toContain(saved.nfoPath);
      for (const entry of plan.files) await fs.rm(entry.path);
      await host.request("library.maintenance.complete", { token });
    }
    work = await video(host, target.id);
    expect(work).toMatchObject({ availability: "metadata_only", favorite: 1, media_files: [] });
    expect(await fs.readFile(saved.nfoPath, "utf8")).toBe(nfo);
    const db = new DatabaseSync(path.join(current, "library.sqlite3"), { readOnly: true });
    try {
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE name IN ('videos','javm_scan_files')")
          .all(),
      ).toEqual([]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  }, 60000);

  it("独立 NFO 可重复扫描，清空简介不会复活旧别名，视频缺失与未下载分开", async () => {
    const { host, root } = await fixture();
    const folder = path.join(root, "standalone");
    await fs.mkdir(folder);
    const nfo = path.join(folder, "movie.nfo");
    await fs.writeFile(
      nfo,
      "<movie><title>合成资料作品</title><num>TEST-001</num><outline>旧简介</outline><review>旧评论</review><rating>4</rating><runtime>30</runtime><custom>保留</custom></movie>",
    );
    const dir = await host.request<{ directoryId: string }>("library.add", { path: folder });
    expect((await finish(host)).scan?.state).toBe("completed");
    const works = await host.request<NativeVideo[]>("library.videos");
    expect(works).toHaveLength(1);
    const id = works[0]!.id;
    await fs.writeFile(
      nfo,
      (await fs.readFile(nfo, "utf8"))
        .replace("<rating>4</rating>", "<rating>9</rating>")
        .replace("<runtime>30</runtime>", "<runtime>40</runtime>"),
    );
    await host.request("library.scan", { id: dir.directoryId });
    await finish(host);
    expect(await video(host, id)).toMatchObject({ rating: 9, duration: 2400 });
    expect(await host.request("library.summary")).toMatchObject({ total: 1 });
    await host.request("library.updateMetadata", {
      id,
      patch: { plot: "" },
      expected: { plot: "旧简介" },
    });
    await commit(host, await prepare(host, { workId: id }));
    const text = await fs.readFile(nfo, "utf8");
    expect(text).not.toContain("<outline>");
    expect(text).not.toContain("<review>");
    expect(text).toContain("<custom>保留</custom>");
    const file = path.join(folder, "TEST-001.mp4");
    await sample(file);
    await prepare(host, { workId: id, path: file });
    await fs.rm(file);
    await host.request("library.scan", { id: dir.directoryId });
    await finish(host);
    expect(await video(host, id)).toMatchObject({
      availability: "unavailable",
      missing: 1,
      plot: "",
    });
    expect(await host.request("library.query", { availability: "metadata_only" })).toMatchObject({
      total: 0,
    });
    expect(await host.request("library.query", { availability: "unavailable" })).toMatchObject({
      total: 1,
    });
    await host.request("library.removeDirectory", { id: dir.directoryId });
    expect(await host.request("library.summary")).toMatchObject({ total: 1 });
    expect(await fs.readFile(nfo, "utf8")).toBe(text);
  }, 30000);

  it("资料写入前检查外部改动，拒绝覆盖已修改的 NFO", async () => {
    const { host } = await fixture();
    const target = await prepare(host, { candidate, collect: true });
    const saved = await commit(host, target);
    const second = await prepare(host, { workId: target.id });
    await fs.appendFile(saved.nfoPath, "<!-- external -->");
    const modified = await fs.readFile(saved.nfoPath, "utf8");
    await expect(commit(host, second)).rejects.toThrow("NFO 已被修改");
    expect(await fs.readFile(saved.nfoPath, "utf8")).toBe(modified);
  });

  it("人工修正番号及清空时长后，旧 NFO 不恢复旧身份或视频时长", async () => {
    const { host, root } = await fixture();
    const target = await prepare(host, { candidate });
    await commit(host, target);
    const file = path.join(root, "TEST-001.mp4");
    await sample(file);
    await prepare(host, { workId: target.id, path: file });
    await host.request("library.updateMetadata", {
      id: target.id,
      patch: { code: "NEW-002", duration: 0 },
      expected: { code: "TEST-001", duration: 100 },
    });
    const refreshed = await prepare(host, { workId: target.id });
    expect(refreshed.code).toBe("NEW-002");
    await host.request("library.scrape.commit", {
      ...refreshed,
      details: { ...details, id: "002", fields: { ...details.fields, code: "NEW-002" } },
    });
    expect(await video(host, target.id)).toMatchObject({
      local_id: "NEW-002",
      duration: 0,
      availability: "available",
    });
    expect(await host.request("library.summary")).toMatchObject({ total: 1 });
  });

  it("目录挂载按真实祖先合并，不受名称相近的兄弟目录影响", async () => {
    const { host, root } = await fixture();
    const main = path.join(root, "a"),
      sibling = path.join(root, "a-neighbor"),
      child = path.join(main, "child");
    for (const folder of [main, sibling, child]) await fs.mkdir(folder, { recursive: true });
    await host.request("library.add", { path: main });
    await finish(host);
    await host.request("library.add", { path: sibling });
    await finish(host);
    const file = path.join(child, "TEST-001.mp4");
    await sample(file);
    await prepare(host, { path: file });
    const status = await host.request<LibraryStatus>("library.status");
    expect(status.assetRoots?.map((entry) => entry.path).sort()).toEqual([main, sibling].sort());
  });
});
