import type { FilmFacet } from "../films/filmMetadata";
import type { CatalogDimension, CatalogList } from "../../services/catalog/discoveryData";

// 导演、系列尚无已保存的 JavBus 链接，暂不作为发现入口；元数据仍可浏览。
export const discoverCategories = ["女演员", "男演员", "制作商", "发行商", "分类"] as const;
export type DiscoverCategory = (typeof discoverCategories)[number];
export const discoverDimensions = {
  女演员: "actresses",
  男演员: "maleActors",
  制作商: "studios",
  发行商: "labels",
  分类: "genres",
} as const satisfies Record<DiscoverCategory, CatalogDimension>;
export const metadataDimensions = {
  演员: "actors",
  导演: "directors",
  制作商: "studios",
  发行商: "labels",
  系列: "series",
  分类: "genres",
} as const satisfies Record<FilmFacet, CatalogDimension>;

export function categoryForFacet(
  facet: FilmFacet,
  name: string,
  catalogs?: Record<CatalogDimension, CatalogList>,
): DiscoverCategory | undefined {
  if (facet === "演员") {
    const female = catalogs?.actresses.names.includes(name) ?? false;
    const male = catalogs?.maleActors.names.includes(name) ?? false;
    if (female === male) return undefined;
    return female ? "女演员" : "男演员";
  }
  return discoverCategories.find((category) => category === facet);
}
