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
