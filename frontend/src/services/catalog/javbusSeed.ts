import actressesUrl from "../../../../data/catalogs/javbus/actresses.csv?url";
import maleActorsUrl from "../../../../data/catalogs/javbus/male-actors.csv?url";
import directorsUrl from "../../../../data/catalogs/javbus/directors.csv?url";
import studiosUrl from "../../../../data/catalogs/javbus/studios.csv?url";
import labelsUrl from "../../../../data/catalogs/javbus/labels.csv?url";
import seriesUrl from "../../../../data/catalogs/javbus/series.csv?url";
import genresUrl from "../../../../data/catalogs/javbus/genres.csv?url";
import { parseJavbusCsv } from "./javbusCatalog";
import type { JavbusCatalogDimension, JavbusCatalogEntry } from "./javbusCatalog";

const files = {
  actresses: actressesUrl,
  maleActors: maleActorsUrl,
  directors: directorsUrl,
  studios: studiosUrl,
  labels: labelsUrl,
  series: seriesUrl,
  genres: genresUrl,
};
let loading: Promise<JavbusCatalogEntry[]> | undefined;
export function loadJavbusSeed() {
  return (loading ??= (async () => {
    // 采集快照仅用于生产包；开发界面不读取真实名称与资料。
    if (import.meta.env.DEV) return [];
    const entries: JavbusCatalogEntry[] = [];
    let size = 0;
    for (const [dimension, url] of Object.entries(files)) {
      const response = await fetch(url);
      if (!response.ok) throw new Error("内置目录读取失败，请重新安装。");
      const csv = await response.text();
      size += csv.length;
      if (size > 16 * 1024 * 1024) throw new Error("内置目录超过大小限制。");
      const parsed = parseJavbusCsv(csv, dimension as JavbusCatalogDimension, Date.now());
      if (entries.length + parsed.length > 100_000) throw new Error("内置目录数量超过限制。");
      // 数万条记录不能展开为函数参数，桌面 WebView2 的 Worker 会触发调用栈溢出。
      for (const entry of parsed) entries.push(entry);
    }
    return entries;
  })().catch((error: unknown) => {
    loading = undefined;
    throw error;
  }));
}
