import { describe, expect, it } from "vite-plus/test";
import {
  loadDiscovery,
  mergeDiscovery,
  parseAvwikiDirectory,
} from "../frontend/src/services/catalog/discoveryData";
import type { DiscoverySeed } from "../frontend/src/services/catalog/discoveryData";
import { avwikiSources } from "../frontend/src/services/catalog/avwikiCsv";
import type { AvwikiDimension } from "../frontend/src/services/catalog/avwikiCsv";
import { queryCatalog } from "../frontend/src/services/catalog/catalogData";

const now = 1_790_000_000_000;
const names = ["Z-示例优先", "A-示例靠后", "#示例符号"];
const dimensions = Object.keys(avwikiSources) as AvwikiDimension[];
const entries = names.map((name, index) => ({
  id: String(index + 1),
  name,
  label: name,
  aliases: [],
}));
const seed: DiscoverySeed = {
  genres: [],
  actors: [],
  entities: [],
  avwikiDirectories: {
    actresses: entries,
    maleActors: entries,
    directors: entries,
    studios: entries,
    series: entries,
  },
};

describe("发现目录来源顺序", () => {
  it("五类内置名单及网页主列表保持来源顺序，数字 ID 和符号不重排", () => {
    const initial = loadDiscovery(seed, null, now);
    for (const dimension of dimensions) {
      expect(initial.catalogs[dimension].names).toEqual(names);
      const kind = new URL(avwikiSources[dimension]).pathname;
      const html = `<div>全 3 件</div><ul class="entity-grid">${names
        .map((name, index) => `<li><a href="${kind}${3 - index}/">${name}</a></li>`)
        .join("")}</ul>`;
      expect(parseAvwikiDirectory(html, dimension, 1).names).toEqual(names);
    }
  });

  it("旧字母缓存恢复快照顺序，保留增量身份和名称并从首页重建", () => {
    const old = JSON.parse(loadDiscovery(seed, null, now).cache);
    old.version = 4;
    old.catalogs.actresses.names = ["#示例符号", "A-示例靠后", "Z-示例优先", "旧缓存示例"];
    old.directoryPages.actresses = 9;
    old.directoryEntries = { actresses: { "9": "旧缓存示例" } };
    const restored = loadDiscovery(seed, JSON.stringify(old), now);
    expect(restored.catalogs.actresses.names).toEqual([...names, "旧缓存示例"]);
    expect(restored.directoryEntries?.actresses).toEqual({ "9": "旧缓存示例" });
    expect(restored.directoryPages.actresses).toBe(1);
    expect(JSON.parse(restored.cache).version).toBe(5);
  });

  it("续页、重启及新一轮更新保持顺序，跨页重复去重且保留未刷新条目", () => {
    const initial = loadDiscovery(seed, null, now);
    const first = mergeDiscovery(
      seed,
      initial.cache,
      { directory: { dimension: "actresses", names: ["B-新增示例", names[1]!], nextPage: 9 } },
      now,
    );
    expect(first.catalogs.actresses.names).toEqual(["B-新增示例", names[1], names[0], names[2]]);
    const restarted = loadDiscovery(seed, first.cache, now);
    expect(restarted.directoryPages.actresses).toBe(9);
    const second = mergeDiscovery(
      seed,
      restarted.cache,
      { directory: { dimension: "actresses", names: [names[1]!, names[2]!], nextPage: null } },
      now,
    );
    expect(loadDiscovery(seed, second.cache, now).catalogs.actresses.names).toEqual([
      "B-新增示例",
      names[1],
      names[2],
      names[0],
    ]);
    const next = mergeDiscovery(
      seed,
      second.cache,
      { directory: { dimension: "actresses", names: [names[2]!], nextPage: 2 } },
      now,
    );
    expect(next.catalogs.actresses.names).toEqual([names[2], "B-新增示例", names[1], names[0]]);
    expect(next.catalogs.studios.names).toEqual(names);
  });

  it("搜索及深页保留来源顺序，名称排序在全量过滤后分页且不改变来源名单", () => {
    const source = ["Z-示例20", "B-示例2", "A-示例10", "A-示例2"];
    const page = { offset: 1, limit: 2, includeTotal: true };
    const bySource = queryCatalog(
      source,
      { dimension: "series", sort: "source", query: "示例" },
      page,
    );
    expect(bySource.items.map((item) => item.name)).toEqual(source.slice(1, 3));
    const byName = queryCatalog(source, { dimension: "series", sort: "name" }, page);
    expect(byName.items.map((item) => item.name)).toEqual(["A-示例10", "B-示例2"]);
    expect(queryCatalog(source, { dimension: "series", sort: "source" }, page)).toEqual(bySource);
  });

  it("损坏的续页顺序位置不写回缓存", () => {
    const cache = JSON.parse(loadDiscovery(seed, null, now).cache);
    cache.directoryOrderSize = { actresses: names.length + 1 };
    expect(() => loadDiscovery(seed, JSON.stringify(cache), now)).toThrow("名单缓存无效");
  });
});
