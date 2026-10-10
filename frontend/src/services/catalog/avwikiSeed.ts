import actressesUrl from "../../../../data/catalogs/avwikidb/actresses.csv?url";
import maleActorsUrl from "../../../../data/catalogs/avwikidb/male-actors.csv?url";
import directorsUrl from "../../../../data/catalogs/avwikidb/directors.csv?url";
import makersUrl from "../../../../data/catalogs/avwikidb/makers.csv?url";
import seriesUrl from "../../../../data/catalogs/avwikidb/series.csv?url";
import { parseAvwikiCsv } from "./avwikiCsv";
import type { AvwikiDimension, AvwikiEntry } from "./avwikiCsv";

const files = {
  actresses: actressesUrl,
  maleActors: maleActorsUrl,
  directors: directorsUrl,
  studios: makersUrl,
  series: seriesUrl,
};
let loading: Promise<Record<AvwikiDimension, AvwikiEntry[]>> | undefined;
export function loadAvwikiSeed() {
  return (loading ??= (async () => {
    // 开发服务器绝不把真实名单或头像交给预览页面。
    if (import.meta.env.DEV)
      return {
        actresses: [{ id: "1", name: "示例女演员甲", label: "示例女演员甲", aliases: [] }],
        maleActors: [{ id: "1", name: "示例男演员甲", label: "示例男演员甲", aliases: [] }],
        directors: [{ id: "1", name: "示例导演甲", label: "示例导演甲", aliases: [] }],
        studios: [{ id: "1", name: "示例制作商甲", label: "示例制作商甲", aliases: [] }],
        series: [{ id: "1", name: "示例系列甲", label: "示例系列甲", aliases: [] }],
      };
    const result = {} as Record<AvwikiDimension, AvwikiEntry[]>;
    // 逐文件读取、解析，限制峰值内存；全部工作留在 Worker。
    for (const dimension of Object.keys(files) as AvwikiDimension[]) {
      const response = await fetch(files[dimension]);
      if (!response.ok) throw new Error("内置目录读取失败，请重新安装。");
      result[dimension] = parseAvwikiCsv(await response.text(), dimension);
    }
    return result;
  })());
}
