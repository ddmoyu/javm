import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
import { createLibraryFixture } from "./helpers/libraryFixture";
import type { NativeVideo } from "../frontend/src/contracts/library";
const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
describe.runIf(enabled)("NFO 导出与 STRM 导入（安全虚构文件）", () => {
  let host: MediaHost, root: string;
  const url = "https://safe.example.invalid/fiction.m3u8";
  beforeAll(async () => {
    await fs.mkdir(".tmp", { recursive: true });
    root = path.resolve(await fs.mkdtemp(".tmp/library-documents-"));
    const db = createLibraryFixture(path.join(root, "library.sqlite3"));
    db.exec(
      "INSERT INTO works(id,code,code_key,title,rating,favorite) VALUES('safe-work','SAFE-001','safe001','虚构 A & B',8,1)",
    );
    db.close();
    host = new MediaHost();
    await host.start(path.join(root, "downloads.sqlite3"));
    await host.request("library.status");
  });
  afterAll(async () => {
    await host?.close();
  });
  it("规范 NFO 保留作品身份、转义文本与评分，不伪造来源", async () => {
    const document = await host.request<{ content: string }>("library.documents.nfo", {
      id: "safe-work",
    });
    expect(document.content).toContain("虚构 A &amp; B");
    expect(document.content).toContain('type="javm-work"');
    expect(document.content).not.toContain('type="metatube"');
    expect(document.content).toContain("<value>8</value>");
    await fs.writeFile(path.join(root, "movie.nfo"), document.content);
    await fs.writeFile(path.join(root, "movie.strm"), `${url}\n`);
  });
  it("重复导入幂等，网络地址关联作品且从不探测远端内容", async () => {
    const input = { path: path.join(root, "movie.strm"), content: `${url}\n`, url };
    await host.request("library.documents.importStream", input);
    await host.request("library.documents.importStream", input);
    const work = await host.request<NativeVideo>("library.video", { id: "safe-work" });
    expect(work.media_files).toHaveLength(1);
    expect(work.media_files?.[0]?.stream_url).toBe(url);
    expect(work.favorite).toBe(1);
    const health = await host.request<{ items: { issues: string[] }[] }>(
      "library.maintenance.read",
      { health: true },
    );
    expect(health.items[0]?.issues).not.toContain("视频探测资料不完整");
  });
  it("导入期间文件变化和带凭据地址会被拒绝", async () => {
    await expect(
      host.request("library.documents.importStream", {
        path: path.join(root, "movie.strm"),
        content: `${url}\nchanged`,
        url,
      }),
    ).rejects.toThrow();
    const privateUrl = "https://user:key@safe.example.invalid/video";
    await fs.writeFile(path.join(root, "private.strm"), privateUrl);
    await expect(
      host.request("library.documents.importStream", {
        path: path.join(root, "private.strm"),
        content: privateUrl,
        url: privateUrl,
      }),
    ).rejects.toThrow();
  });
});
