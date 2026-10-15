import { filesystem, resources } from "@neutralinojs/lib";
import { applicationDataPath } from "./applicationPaths";
import seedUrl from "../../../../data/catalogs/javbus/catalog.sqlite3?url";
import manifest from "../../../../data/catalogs/javbus/catalog.sqlite3.json";
import type { JavbusCatalogEntry } from "../../services/catalog/javbusCatalog";
import type { LibraryPort } from "../../services/library/LibraryService";

export function createCatalogSeedPort(native: LibraryPort) {
  let extracted: Promise<string> | undefined;
  const extract = () =>
    (extracted ??= (async () => {
      const directory = await applicationDataPath("catalogs", "javbus");
      try {
        await filesystem.createDirectory(directory);
      } catch (error) {
        if (!(await filesystem.getStats(directory).catch(() => null))?.isDirectory) throw error;
      }
      const path = `${directory}/seed-${manifest.sha256}.sqlite3`;
      const existing = await filesystem.getStats(path).catch(() => null);
      if (existing) {
        if (!existing.isFile || existing.size !== manifest.bytes)
          throw new Error("内置目录副本无效，原文件已保留。");
        return path;
      }
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        if (!/^\/assets\/[\w.-]+\.sqlite3$/.test(seedUrl))
          throw new Error("内置目录资源路径无效。");
        await resources.extractFile(`/dist/frontend${seedUrl}`, temporary);
        if ((await filesystem.getStats(temporary)).size !== manifest.bytes)
          throw new Error("内置目录提取不完整。");
        try {
          await filesystem.move(temporary, path);
        } catch (error) {
          // 同版本多个窗口可能同时提取；只接受完整的已存在副本。
          const winner = await filesystem.getStats(path).catch(() => null);
          if (!winner?.isFile || winner.size !== manifest.bytes) throw error;
        }
        return path;
      } finally {
        await filesystem.remove(temporary).catch(() => {});
      }
    })().catch((error: unknown) => {
      extracted = undefined;
      throw error;
    }));
  const ensureSeed = async () => {
    await native.request("library.catalogSeed", { path: await extract() });
  };
  return {
    ensureSeed,
    async loadSeed(
      append: (entries: JavbusCatalogEntry[], reset: boolean, done: boolean) => Promise<unknown>,
    ) {
      await ensureSeed();
      let after = 0,
        count = 0;
      for (let page = 0; page <= 200; page++) {
        const result = await native.request<{
          items: JavbusCatalogEntry[];
          after: number;
          done: boolean;
        }>("library.catalogEntries", { after, limit: 500 });
        count += result.items.length;
        if (count > 100_000 || (!result.done && result.after <= after))
          throw new Error("内置目录分页无效。");
        await append(result.items, page === 0, result.done);
        if (result.done) {
          if (count !== manifest.rows) throw new Error("内置目录数量与构建清单不符。");
          return;
        }
        after = result.after;
      }
      throw new Error("内置目录分页超过限制。");
    },
  };
}
