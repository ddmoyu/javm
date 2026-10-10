import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
import { LibraryService } from "../frontend/src/services/library/LibraryService";
import {
  parseAvwikiWorks,
  parseAvwikiWorkDetails,
} from "../frontend/src/services/catalog/avwikiWorks";
import { editableMetadata } from "../frontend/src/contracts/metadata";
import { details, listing } from "./fixtures/discover-works/data";

describe.runIf(process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1")(
  "发现作品保存到隔离片库",
  () => {
    let host: MediaHost, library: LibraryService;
    beforeAll(async () => {
      await fs.mkdir(path.resolve(".tmp"), { recursive: true });
      const root = await fs.mkdtemp(path.resolve(".tmp/avwiki-works-"));
      host = new MediaHost();
      await host.start(path.join(root, "downloads.sqlite3"));
      library = new LibraryService({
        request: (method, params) => host.request(method, params),
        mount: async () => () => undefined,
      });
      await library.initialize();
    });
    afterAll(async () => {
      await library?.shutdown();
      await host?.close();
    });
    it("在线结果可保存 NFO 并返回本地作品；重复保存复用身份且保留手动修改", async () => {
      const work = parseAvwikiWorks(
        listing(),
        { id: "1", name: "示例女演员甲", url: "https://avwikidb.com/actor/1/" },
        1,
      ).items[0]!;
      const metadata = parseAvwikiWorkDetails(details(), work);
      const saved = await library.collectMetadata(metadata);
      expect(saved.code).toBe("TEST-001");
      expect(saved.favorite).toBe(true);
      expect(saved.availability).toBe("metadata_only");
      expect(saved.files?.some((file) => file.kind === "video")).toBe(false);
      const nfo = saved.files?.find((file) => file.kind === "metadata");
      expect(nfo).toBeDefined();
      expect(await fs.readFile(nfo!.path, "utf8")).toContain("AVWikiDB");
      await library.updateMetadata(
        saved.id,
        { title: "手动保留的安全标题" },
        editableMetadata(saved),
      );
      const again = await library.collectMetadata(metadata);
      expect(again.id).toBe(saved.id);
      expect(again.title).toBe("手动保留的安全标题");
      expect(library.getSnapshot().total).toBe(1);
      const view = library.createFilmQuery();
      view.configure({ facet: { dimension: "actors", value: "示例女演员甲" } }, true);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error("本地作品刷新超时"));
        }, 2000);
        const unsubscribe = view.subscribe(() => {
          if (view.getSnapshot().ready) {
            clearTimeout(timer);
            unsubscribe();
            resolve();
          }
        });
      });
      expect(view.getSnapshot().total).toBe(1);
      view.setActive(false);
    });
  },
);
