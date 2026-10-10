import { describe, expect, it } from "vite-plus/test";
import { csvColumns, parseAvwikiCsv } from "../frontend/src/services/catalog/avwikiCsv";
import {
  loadDiscovery,
  mergeDiscovery,
  parseAvwikiDirectory,
} from "../frontend/src/services/catalog/discoveryData";
import type { DiscoverySeed } from "../frontend/src/services/catalog/discoveryData";
import { PortraitService } from "../frontend/src/services/catalog/PortraitService";
import type { CatalogProcessor } from "../frontend/src/services/catalog/workerClient";
import { validPortraitUrl } from "../frontend/src/services/catalog/portraitUrls";

const csv = (id: string, name: string, chinese = "", aliases = "") =>
  "\uFEFF" +
  [
    csvColumns,
    [
      "avwikidb",
      "actor",
      id,
      name,
      chinese,
      aliases,
      "pending",
      `https://avwikidb.com/actor/${id}/`,
    ],
  ]
    .map((row) => row.map((field) => `"${field.replaceAll('"', '""')}"`).join(","))
    .join("\r\n") +
  "\r\n";
const seed: DiscoverySeed = {
  genres: [],
  actors: [],
  entities: [{ dimension: "directors", name: "旧来源示例导演" }],
  avwikiDirectories: {
    actresses: parseAvwikiCsv(csv("n123", '示例,"演员"', "示例译名", "示例别名"), "actresses"),
    maleActors: [],
    directors: [{ id: "1", name: "示例导演", label: "示例导演", aliases: [] }],
    studios: [],
    series: [],
  },
};

describe("AVWikiDB 离线名单及头像兜底", () => {
  it("保留 CSV 原文编号和中文标签，拒绝错误来源、重复编号与截断引号", () => {
    const entries = parseAvwikiCsv(csv("n123", '示例,"演员"', "示例译名", "示例别名"), "actresses");
    expect(entries).toEqual([
      { id: "n123", name: '示例,"演员"', label: "示例译名", aliases: ["示例别名"] },
    ]);
    expect(() =>
      parseAvwikiCsv(csv("n123", "示例演员").replace('"avwikidb"', '"other"'), "actresses"),
    ).toThrow();
    expect(() => parseAvwikiCsv(csv("n123", "示例演员").slice(0, -4), "actresses")).toThrow();
    const row = csv("n123", "示例演员").split("\r\n")[1]!;
    expect(() => parseAvwikiCsv(csv("n123", "示例演员") + row + "\r\n", "actresses")).toThrow();
  });
  it("五类名单使用 AVWikiDB 内置数据，旧来源不混入，网络更新不覆盖人工中文标签", () => {
    const initial = loadDiscovery(seed, null, Date.now());
    expect(initial.catalogs.directors.names).toEqual(["示例导演"]);
    expect(initial.catalogs.actresses.labels?.['示例,"演员"']).toBe("示例译名");
    const old = JSON.parse(initial.cache);
    old.version = 3;
    old.catalogs.directors.names.push("旧来源示例导演");
    expect(loadDiscovery(seed, JSON.stringify(old), Date.now()).catalogs.directors.names).toEqual([
      "示例导演",
    ]);
    const updated = mergeDiscovery(
      seed,
      initial.cache,
      { directory: { dimension: "actresses", names: ["新增示例演员"], nextPage: 2 } },
      Date.now(),
    );
    expect(updated.directoryPages.actresses).toBe(2);
    expect(updated.catalogs.actresses.labels?.['示例,"演员"']).toBe("示例译名");
    expect(updated.catalogs.maleActors.names).toEqual([]);
  });
  it("只解析主列表，接受带前缀编号，不把侧栏条目混入名单", () => {
    const html =
      '<div>全 1 件</div><ul class="entity-grid"><li><a href="/actor/n123/">示例演员</a></li></ul>' +
      '<aside><a href="/actor/2/">侧栏示例</a></aside>';
    expect(parseAvwikiDirectory(html, "actresses", 1)).toEqual({
      names: ["示例演员"],
      nextPage: null,
    });
    expect(() =>
      parseAvwikiDirectory(html.replace("全 1 件", "全 101 件"), "actresses", 1),
    ).toThrow();
    expect(() =>
      parseAvwikiDirectory('<div>全 1 件</div><a href="/actor/1/">示例</a>', "actresses", 1),
    ).toThrow();
  });
  it("跳过来源无编号条目，保留新头像链接并持久化到目录缓存", () => {
    const photo = "https://pics.dmm.co.jp/mono/actjpgs/example.jpg";
    const html = `<div>全 2 件</div><ul class="entity-grid"><li><a href="/histrion/123/">示例男演员</a><img src="${photo}"></li><li><a href="/histrion/null/">无编号示例</a></li></ul>`;
    const parsed = parseAvwikiDirectory(html, "maleActors", 1);
    expect(parsed).toEqual({
      names: ["示例男演员"],
      nextPage: null,
      portraits: { 示例男演员: photo },
    });
    const updated = mergeDiscovery(
      seed,
      loadDiscovery(seed, null, Date.now()).cache,
      { directory: { dimension: "maleActors", ...parsed } },
      Date.now(),
    );
    expect(loadDiscovery(seed, updated.cache, Date.now()).directoryPortraits.maleActors).toEqual({
      示例男演员: photo,
    });
    expect(() =>
      parseAvwikiDirectory(html.replace("/histrion/null/", "/histrion/broken/"), "maleActors", 1),
    ).toThrow();
  });
  it("头像先读 AVWikiDB，缺失或失败后才使用镜像兜底，索引只准备一次", async () => {
    const image = "https://pics.dmm.co.jp/mono/actjpgs/example.jpg";
    const mirror = "https://cdn.jsdelivr.net/gh/xinxin8816/gfriends/Content/Example/Example.jpg";
    const requests: string[] = [];
    let indexReads = 0;
    const processor = {
      run: async (operation: string, payload: { fallback?: boolean }) =>
        operation === "portraitIndex"
          ? true
          : payload.fallback
            ? { 示例乙: [mirror] }
            : { 示例甲: [image] },
    } as unknown as CatalogProcessor;
    const service = new PortraitService(processor, {
      load: async (url) => {
        requests.push(url);
        return `local:${url.endsWith("example.jpg") ? "a" : "b"}`;
      },
      index: async () => {
        indexReads++;
        return "{}";
      },
      shutdown: async () => {},
    });
    expect(
      await service.load("actresses", ["示例甲", "示例乙"], new AbortController().signal),
    ).toEqual({ 示例甲: "local:a", 示例乙: "local:b" });
    await service.load("actresses", ["示例乙"], new AbortController().signal);
    expect(indexReads).toBe(1);
    expect(requests).toEqual([image, mirror, mirror]);
    await service.shutdown();
  });
  it("并发总数上限为四，取消后停止下载，拒绝越界地址", async () => {
    let concurrent = 0,
      maximum = 0;
    const names = Array.from({ length: 12 }, (_, i) => `安全示例${i}`);
    const processor = {
      run: async () =>
        Object.fromEntries(
          names.map((name) => [name, ["https://pics.dmm.co.jp/mono/actjpgs/example.jpg"]]),
        ),
    } as unknown as CatalogProcessor;
    const service = new PortraitService(processor, {
      load: async (_url, signal) => {
        concurrent++;
        maximum = Math.max(maximum, concurrent);
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          signal.throwIfAborted();
          return "local:safe";
        } finally {
          concurrent--;
        }
      },
      index: async () => "{}",
      shutdown: async () => {},
    });
    await Promise.all([
      service.load("actresses", names, new AbortController().signal),
      service.load("maleActors", names, new AbortController().signal),
    ]);
    expect(maximum).toBe(4);
    const abort = new AbortController();
    abort.abort();
    await expect(service.load("actresses", names, abort.signal)).rejects.toThrow();
    await service.shutdown();
    expect(validPortraitUrl("https://pics.dmm.co.jp/mono/actjpgs/example.jpg")).toBe(true);
    expect(
      validPortraitUrl(
        "https://cdn.jsdelivr.net/gh/xinxin8816/gfriends/Content/Example/Example.jpg",
      ),
    ).toBe(true);
    expect(validPortraitUrl("https://example.invalid/secret.jpg")).toBe(false);
    expect(
      validPortraitUrl(
        "https://cdn.jsdelivr.net/gh/xinxin8816/gfriends/Content/%2e%2e/Example.jpg",
      ),
    ).toBe(false);
  });
});
