import { afterAll, describe, expect, it, vi } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
import { LibraryService } from "../frontend/src/services/library/LibraryService";
import type { LibraryPort } from "../frontend/src/services/library/LibraryService";
import { ArtworkService } from "../frontend/src/services/library/ArtworkService";
import type { ArtworkTools } from "../frontend/src/services/library/ArtworkService";
import type { MovieDetails } from "../frontend/src/services/metadata/MetaTubeService";

const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
describe.runIf(enabled)("发现收藏图片落库与重启恢复（隔离数据库和安全签名夹具）", () => {
  let host: MediaHost | undefined;
  let library: LibraryService | undefined;
  afterAll(async () => {
    await library?.shutdown();
    await host?.close();
  });

  it("保存本地封面与预览路径，重复收藏不重复下载，扩展重启后仍能读取", async () => {
    await fs.mkdir(path.resolve(".tmp"), { recursive: true });
    const root = await fs.mkdtemp(path.resolve(".tmp/discovery-collection-artwork-"));
    const database = path.join(root, "downloads.sqlite3");
    host = new MediaHost();
    await host.start(database);
    const port: LibraryPort = {
      request: (method, params) => host!.request(method, params),
      // 验证应用的路径转换与刷新，不模拟真实 Neutralino 资源服务器。
      mount: async () => (file) => `/safe-assets/${encodeURIComponent(file)}`,
    };
    library = new LibraryService(port);
    // 沿用图片原生接口的签名夹具，无真实图像内容，不进行展示。
    const signature = Uint8Array.from([255, 216, 255, 217]);
    const tools = {
      mkdir: async (folder: string) => {
        await fs.mkdir(folder);
      },
      read: async () => signature.slice().buffer,
      write: async (file: string, bytes: ArrayBuffer) => {
        await fs.writeFile(file, new Uint8Array(bytes));
      },
      remove: async (file: string) => {
        if ((await fs.stat(file)).isDirectory()) await fs.rmdir(file);
        else await fs.unlink(file);
      },
      frame: async () => {},
      transform: async () => signature.slice().buffer,
      download: vi.fn<ArtworkTools["download"]>(async () => {}),
      details: async () => {
        throw new Error("不能请求真实来源");
      },
    } satisfies ArtworkTools;
    library.artwork = new ArtworkService(port, tools, () => library!.refreshAfterImport());
    const details: MovieDetails = {
      provider: "JavBus",
      id: "SAFE-001",
      homepage: "https://www.javbus.com/SAFE-001_2026-01-01",
      fields: { code: "SAFE-001", title: "安全自然纪录片" },
      coverUrl: "https://images.example.invalid/cover.jpg",
      previewImages: [
        "https://images.example.invalid/preview-1.jpg",
        "https://images.example.invalid/preview-2.jpg",
      ],
    };
    const warning = vi.fn();
    const saved = await library.collectMetadata(details, warning);
    expect(warning).not.toHaveBeenCalled();
    expect(saved.favorite).toBe(true);
    expect(saved.coverUrl).toBeDefined();
    expect(saved.screenshots).toHaveLength(2);
    for (const image of [...(saved.artwork ?? []), ...(saved.screenshots ?? [])]) {
      expect(image.path).toBeDefined();
      expect(path.resolve(image.path!).startsWith(`${path.resolve(root)}${path.sep}`)).toBe(true);
      expect(await fs.readFile(image.path!)).toEqual(Buffer.from(signature));
    }
    const again = await library.collectMetadata(details, warning);
    expect(again.id).toBe(saved.id);
    expect(again.artwork).toEqual(saved.artwork);
    expect(again.screenshots).toEqual(saved.screenshots);
    expect(tools.download).toHaveBeenCalledTimes(3);
    expect(library.getSnapshot().total).toBe(1);

    await library.shutdown();
    library = undefined;
    await host.close();
    host = new MediaHost();
    await host.start(database);
    library = new LibraryService(port);
    await library.initialize();
    await library.openWork(String(saved.id));
    expect(library.getSnapshot().selectedFilm).toMatchObject({
      id: saved.id,
      favorite: true,
      availability: "metadata_only",
      coverUrl: saved.coverUrl,
      screenshots: saved.screenshots,
    });
  }, 30_000);
});
