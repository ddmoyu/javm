import { describe, expect, it } from "vite-plus/test";
import {
  categoryForFacet,
  discoverCategories,
} from "../frontend/src/features/discover/discoverCategories";
import { facetNames } from "../frontend/src/features/films/filmMetadata";
import { loadDiscovery } from "../frontend/src/services/catalog/discoveryData";
import type { DiscoverySeed } from "../frontend/src/services/catalog/discoveryData";
import type { JavbusCatalogEntry } from "../frontend/src/services/catalog/javbusCatalog";

const actress = (name: string): JavbusCatalogEntry => ({
  dimension: "actresses",
  lane: "censored",
  id: "safe-1",
  name,
  label: name,
  aliases: [],
  translationStatus: "pending",
  category: "",
});
const seed: DiscoverySeed = {
  actors: ["未分类合成人员"],
  genres: [],
  entities: [{ dimension: "studios", name: "合成制作商" }],
  javbusEntries: [actress("合成女演员")],
};

describe("发现分类", () => {
  it("只显示 JavBus 可提供的维度，未知演员不猜测目录，原元数据字段仍可浏览", () => {
    const { catalogs } = loadDiscovery(seed, null, Date.now());
    expect(discoverCategories).toEqual(["女演员", "制作商", "发行商", "分类"]);
    expect(categoryForFacet("演员", "合成女演员", catalogs)).toBe("女演员");
    expect(categoryForFacet("演员", "未分类合成人员", catalogs)).toBeUndefined();
    expect(categoryForFacet("发行商", "合成发行商", catalogs)).toBe("发行商");
    expect(categoryForFacet("分类", "安全示例分类", catalogs)).toBe("分类");
    expect(facetNames).toContain("发行商");
    expect(facetNames).toContain("分类");
  });
  it("升级时丢弃旧离线名单写入的目录名称，保留 JavBus 记录及其他名单", () => {
    const old = JSON.parse(loadDiscovery(seed, null, Date.now()).cache);
    old.version = 6;
    old.catalogs.actresses.names = ["旧名单合成女演员", "合成女演员"];
    old.catalogs.maleActors.names = ["旧名单合成男演员"];
    old.catalogs.series.names = ["旧名单合成系列"];
    old.catalogs.labels.names = ["旧缓存合成发行商"];
    const current = loadDiscovery(seed, JSON.stringify(old), Date.now());
    expect(current.catalogs.actresses.names).toEqual(["合成女演员"]);
    expect(current.catalogs.maleActors.names).toEqual([]);
    expect(current.catalogs.series.names).toEqual([]);
    expect(current.catalogs.labels.names).toContain("旧缓存合成发行商");
    expect(current.catalogs.studios.names).toContain("合成制作商");
    expect(JSON.parse(current.cache).version).toBe(7);
    // 新版本缓存保留 JavBus 目录的网站顺序。
    const saved = JSON.parse(current.cache);
    saved.catalogs.actresses.names = ["合成女演员", "已读取合成女演员"];
    expect(loadDiscovery(seed, JSON.stringify(saved), Date.now()).catalogs.actresses.names).toEqual(
      ["合成女演员", "已读取合成女演员"],
    );
  });
});
