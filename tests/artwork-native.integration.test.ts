import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
import { createLibraryFixture } from "./helpers/libraryFixture";
import type { ArtworkTarget } from "../frontend/src/services/library/ArtworkService";
import type { NativeVideo } from "../frontend/src/contracts/library";
const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
describe.runIf(enabled)("受管图片入库（安全签名 fixture，无图像内容）", () => {
  let host: MediaHost, root: string, directory: string, poster: string;
  const makeImage = async (folder: string) => {
    const file = path.join(folder, `${randomUUID()}.jpg`);
    await fs.writeFile(file, Buffer.from([255, 216, 255, 217]));
    return file;
  };
  beforeAll(async () => {
    root = path.resolve(await fs.mkdtemp(".tmp/artwork-"));
    const db = createLibraryFixture(path.join(root, "library.sqlite3"));
    db.exec("INSERT INTO works(id,code,title) VALUES('safe-work','SAFE-001','安全样例')");
    db.close();
    host = new MediaHost();
    await host.start(path.join(root, "downloads.sqlite3"));
    await host.request("library.status");
    directory = (await host.request<ArtworkTarget>("library.artwork.prepare", { id: "safe-work" }))
      .directory;
  });
  afterAll(async () => {
    await host?.close();
  });
  it("替换封面只返回旧受管文件，清空图库保留封面与作品", async () => {
    const old = await makeImage(directory),
      shot = await makeImage(directory);
    poster = await makeImage(directory);
    await host.request("library.artwork.commit", {
      id: "safe-work",
      expectedPoster: "",
      images: [
        { path: old, kind: "poster" },
        { path: shot, kind: "screenshot", seconds: 3 },
      ],
    });
    const result = await host.request<{ retired: string[] }>("library.artwork.commit", {
      id: "safe-work",
      expectedPoster: old,
      images: [{ path: poster, kind: "poster" }],
    });
    expect(result.retired).toEqual([old]);
    expect(await host.request("library.artwork.remove", { id: "safe-work", clear: true })).toEqual([
      shot,
    ]);
    const work = await host.request<NativeVideo>("library.video", { id: "safe-work" });
    expect(work.poster).toBe(poster);
    expect(work.screenshots).toHaveLength(0);
  });
  it("拒绝越界文件与过期封面修改", async () => {
    const outside = await makeImage(root),
      inside = await makeImage(directory);
    await expect(
      host.request("library.artwork.commit", {
        id: "safe-work",
        expectedPoster: poster,
        images: [{ path: outside, kind: "poster" }],
      }),
    ).rejects.toThrow();
    await expect(
      host.request("library.artwork.commit", {
        id: "safe-work",
        expectedPoster: "",
        images: [{ path: inside, kind: "poster" }],
      }),
    ).rejects.toThrow();
    expect((await host.request<NativeVideo>("library.video", { id: "safe-work" })).poster).toBe(
      poster,
    );
  });
});

describe.runIf(enabled)("扫描后自动封面（安全签名 fixture，无图像内容）", () => {
  let host: MediaHost, root: string;
  const makeImage = async (folder: string) => {
    const file = path.join(folder, `${randomUUID()}.jpg`);
    await fs.writeFile(file, Buffer.from([255, 216, 255, 217]));
    return file;
  };
  const video = (id: string, work: string, extra: string) =>
    `INSERT INTO media_files(id,work_id,path_key,path,dir_path,file_stamp,duration_ms,codec,missing) VALUES('${id}','${work}','k-${id}','C:/safe/${id}.mp4','C:/safe',${extra})`;
  beforeAll(async () => {
    root = path.resolve(await fs.mkdtemp(".tmp/auto-cover-"));
    const db = createLibraryFixture(path.join(root, "library.sqlite3"));
    db.exec(`INSERT INTO works(id,code,title) VALUES('a-ready','SAFE-101','可截帧');
INSERT INTO works(id,code,title,poster) VALUES('b-covered','SAFE-102','已有封面','C:/safe/poster.jpg');
INSERT INTO works(id,code,title) VALUES('c-zero','SAFE-103','时长为零');
INSERT INTO works(id,code,title) VALUES('d-missing','SAFE-104','文件缺失');
INSERT INTO works(id,code,title) VALUES('e-strm','SAFE-105','网络流');
INSERT INTO works(id,code,title,provenance) VALUES('f-retry','SAFE-106','视频已变化','{"_auto":{"failed":"old-stamp"}}');
INSERT INTO works(id,code,title) VALUES('g-thumb','SAFE-107','已有缩略图');
UPDATE works SET thumb='C:/safe/thumb.jpg' WHERE id='g-thumb';
${video("va", "a-ready", "'stamp-a',60000,'H264',0")};
${video("vb", "b-covered", "'stamp-b',60000,'H264',0")};
${video("vc", "c-zero", "'stamp-c',0,'H264',0")};
${video("vd", "d-missing", "'stamp-d',60000,'H264',1")};
${video("ve", "e-strm", "'stamp-e',60000,'STRM',0")};
${video("vf", "f-retry", "'new-stamp',60000,'H264',0")};
${video("vg", "g-thumb", "'stamp-g',60000,'H264',0")};`);
    db.close();
    host = new MediaHost();
    await host.start(path.join(root, "downloads.sqlite3"));
    await host.request("library.status");
  });
  afterAll(async () => {
    await host?.close();
  });
  type Pending = { id: string; video_id: string; file_stamp: string; duration_ms: number }[];
  it("只列出没有任何封面、视频可截帧且未因同一视频失败过的作品", async () => {
    const pending = await host.request<Pending>("library.artwork.pending", { limit: 50 });
    expect(pending.map((item) => item.id)).toEqual(["a-ready", "f-retry"]);
    expect(pending[0]).toMatchObject({ video_id: "va", file_stamp: "stamp-a", duration_ms: 60000 });
    // 分页游标按作品 ID 递增。
    expect(
      (await host.request<Pending>("library.artwork.pending", { after: "a-ready", limit: 1 })).map(
        (item) => item.id,
      ),
    ).toEqual(["f-retry"]);
  });
  it("记录截帧失败后不再列出，视频变化后才会重试", async () => {
    await host.request("library.artwork.failed", { id: "f-retry", fileStamp: "new-stamp" });
    const pending = await host.request<Pending>("library.artwork.pending", { limit: 50 });
    expect(pending.map((item) => item.id)).toEqual(["a-ready"]);
  });
  it("自动封面单独标记，已有封面时跳过，手动封面会替换并清除标记", async () => {
    const directory = (
      await host.request<ArtworkTarget>("library.artwork.prepare", { id: "a-ready" })
    ).directory;
    const automatic = await makeImage(directory);
    expect(
      await host.request("library.artwork.commit", {
        id: "a-ready",
        expectedPoster: "",
        automatic: true,
        images: [{ path: automatic, kind: "poster", seconds: 6 }],
      }),
    ).toMatchObject({ retired: [] });
    let work = await host.request<NativeVideo>("library.video", { id: "a-ready" });
    expect(work.poster).toBe(automatic);
    expect(work.poster_auto).toBe(true);
    expect(await host.request<Pending>("library.artwork.pending", { limit: 50 })).toEqual([]);

    // 作品已有其他封面时，自动封面不写入。
    const coveredDirectory = (
      await host.request<ArtworkTarget>("library.artwork.prepare", { id: "g-thumb" })
    ).directory;
    const skipped = await makeImage(coveredDirectory);
    expect(
      await host.request("library.artwork.commit", {
        id: "g-thumb",
        expectedPoster: "",
        automatic: true,
        images: [{ path: skipped, kind: "poster" }],
      }),
    ).toMatchObject({ skipped: true });
    expect((await host.request<NativeVideo>("library.video", { id: "g-thumb" })).poster).toBe("");

    // 自动封面一次只能提交一张封面。
    await expect(
      host.request("library.artwork.commit", {
        id: "a-ready",
        expectedPoster: automatic,
        automatic: true,
        images: [
          { path: await makeImage(directory), kind: "poster" },
          { path: await makeImage(directory), kind: "screenshot" },
        ],
      }),
    ).rejects.toThrow();

    const manual = await makeImage(directory);
    const replaced = await host.request<{ retired: string[] }>("library.artwork.commit", {
      id: "a-ready",
      expectedPoster: automatic,
      images: [{ path: manual, kind: "poster" }],
    });
    expect(replaced.retired).toEqual([automatic]);
    work = await host.request<NativeVideo>("library.video", { id: "a-ready" });
    expect(work.poster).toBe(manual);
    expect(work.poster_auto).toBe(false);
  });
});
