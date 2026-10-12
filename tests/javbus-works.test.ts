import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  JAVBUS_ORIGIN as origin,
  isJavbusCatalogUrl,
  javbusEntityUrl,
  javbusSearchUrl,
  parseJavbusActors,
  parseJavbusFacets,
  parseJavbusWorks,
  parseJavbusWorkDetails,
  planJavbusLookup,
} from "../frontend/src/services/catalog/javbusWorks";
import { OnlineWorksService } from "../frontend/src/services/catalog/OnlineWorksService";
import type {
  CatalogProcessor,
  CatalogRequest,
} from "../frontend/src/services/catalog/workerClient";
import type { GenreEntry } from "../frontend/src/services/catalog/catalogData";
import { catalogEntries, loadCatalog } from "../frontend/src/services/catalog/catalogData";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";
import {
  categoryForFacet,
  discoverCategories,
} from "../frontend/src/features/discover/discoverCategories";

// 全部页面为手写安全样例。网址仅作为 mock 路由，不打开网页或下载图片。
const name = "示例演员甲";
const entry = { name: `${name}（示例旧名）` };
const genres: GenreEntry[] = [
  { lane: "censored", id: "safe", name: "安全示例分类", category: "示例" },
];
const entity = { id: "star:sample", name, url: `${origin}/star/sample` };
const actors = (sameName = false) => `<div id="waterfall">
  <a class="avatar-box" href="/star/wrong"><img title="${name}相似" /></a>
  <a class="avatar-box" href="/star/sample"><img title="${name}" /></a>
  ${sameName ? `<a class="avatar-box" href="/star/second"><img title="${name}" /></a>` : ""}
  <a class="avatar-box" href="https://safe.invalid/star/external"><img title="${name}" /></a>
</div>`;
const empty = '<div id="waterfall"><div class="alert">沒有您要的結果!</div></div>';
const card = (code: string, suffix = "") =>
  `<a class="movie-box" href="/${code}${suffix}"><div class="photo-frame"><img src="https://safe.invalid/placeholder.jpg" title="安全旅行纪录片" /></div><div class="photo-info"><date>${code}</date><date>2026-01-01</date></div></a>`;
const listing = (page = 1, base = "/star/sample") =>
  `<div id="waterfall">${card(`TEST-00${page}`, "_2026-01-01")}</div>${page === 1 ? `<ul class="pagination"><li id="next"><a href="${base}/2">下一頁</a></li></ul>` : ""}`;
const detail = (code = "TEST-001") => `<h3>${code} 安全旅行纪录片</h3>
<a class="bigImage" href="https://safe.invalid/large-placeholder.jpg"><img /></a>
<div class="col-md-3 info"><p><span class="header">識別碼:</span> <span>${code}</span></p>
<p>發行日期: 2026-01-01</p><p>長度: 80分鐘</p><p>製作商: <a href="/studio/safe">示例制作商</a></p>
<p>導演: <a href="/director/safe">示例导演</a></p><p>系列: <a href="/series/safe">示例系列</a></p>
<p>發行商: <a href="/label/safe">示例发行商</a></p>
<div><span class="genre"><a href="/genre/safe">安全示例分类</a></span></div>
<span class="star-name"><a href="/star/sample">${name}</a></span></div>
<a href="/studio/wrong">示例制作商</a><script>${card("WRONG-001")}</script>`;
const work = { code: "TEST-001", title: "安全旅行纪录片", url: `${origin}/TEST-001_2026-01-01` };

function processor(): CatalogProcessor {
  const run = async (
    operation: CatalogRequest["operation"],
    payload: CatalogRequest["payload"],
  ) => {
    const task = { operation, payload } as CatalogRequest;
    if (task.operation === "javbusPlan")
      return planJavbusLookup(task.payload.dimension, task.payload.name, genres);
    if (task.operation === "javbusActors")
      return parseJavbusActors(task.payload.html, task.payload.names);
    if (task.operation === "javbusFacets")
      return parseJavbusFacets(task.payload.html, task.payload.dimension, task.payload.names);
    if (task.operation === "javbusWorks")
      return parseJavbusWorks(task.payload.html, task.payload.url, task.payload.page);
    if (task.operation === "javbusDetails")
      return parseJavbusWorkDetails(task.payload.html, task.payload.work);
    throw new Error("未配置的安全 mock 操作");
  };
  return { run: run as CatalogProcessor["run"], close() {} };
}
const services: OnlineWorksService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  vi.useRealTimers();
});
const fetchPage = async (url: string, signal: AbortSignal) => {
  signal.throwIfAborted();
  if (url.includes("/uncensored/search")) return empty;
  if (url.includes("/searchstar/")) return actors();
  if (url.includes("/search/")) return listing();
  if (url.includes("/TEST-")) return detail();
  return listing(url.endsWith("/2") ? 2 : 1, new URL(url).pathname.replace(/\/2$/, ""));
};
function fixture(fetch = vi.fn(fetchPage)) {
  const service = new OnlineWorksService(processor(), fetch, async () => {});
  services.push(service);
  return { service, fetch };
}
const ready = async (service: OnlineWorksService) =>
  vi.waitFor(() => {
    expect(service.getSnapshot().loading).toBe(false);
    expect(service.getSnapshot().error).toBe("");
    expect(service.getSnapshot().result).not.toBeNull();
  });

describe("JavBus 作品路径（安全合成数据）", () => {
  it("只接受已知同源路径、有限分页和编码名称", () => {
    for (const path of [
      "/",
      "/genre",
      "/uncensored/genre",
      "/actresses",
      "/actresses/2",
      "/page/2",
      "/star/123",
      "/star/sample/1000",
      "/uncensored/genre/safe/2",
      "/TEST-001_2026-01-01",
    ])
      expect(isJavbusCatalogUrl(`${origin}${path}`)).toBe(true);
    expect(isJavbusCatalogUrl(javbusSearchUrl("actresses", "示例 空格", "uncensored"))).toBe(true);
    for (const url of [
      "/genre",
      `${origin}/star/sample/1001`,
      `${origin}/searchstar/a%2Fb`,
      `${origin}/search/a%255Cb`,
      `${origin}/searchstar/a?x=1`,
      `${origin}/star/a#b`,
      "https://user@www.javbus.com/star/a",
      "https://safe.invalid/star/a",
      `${origin}/ajax/uncledatoolsbyajax.php`,
    ])
      expect(isJavbusCatalogUrl(url)).toBe(false);
    expect(() => javbusEntityUrl(entity, 0)).toThrow("地址无效");
  });
  it("名称括号内的别名参与匹配，但不从名称推测 JavBus 编号", () => {
    const plan = planJavbusLookup("actresses", `${name}（示例旧名、示例别名）`);
    expect(plan.names).toEqual(expect.arrayContaining([name, "示例旧名", "示例别名"]));
    expect(plan.entities).toEqual([]);
    expect(plan.queries.length).toBeLessThanOrEqual(3);
    expect(parseJavbusActors(actors(), plan.names)).toEqual([entity]);
    expect(parseJavbusActors(actors(), ["完全不同姓名"])).toEqual([]);
    expect(parseJavbusActors(empty, plan.names)).toEqual([]);
    expect(() => parseJavbusActors("<main>需要验证</main>", plan.names)).toThrow("未识别");
  });
  it("分类复用经过校验的来源编号，增加分类入口而不替换 CSV 名单", () => {
    const cached = loadCatalog(genres, null, Date.now());
    expect(catalogEntries([], cached.cache, Date.now())).toEqual(genres);
    const plan = planJavbusLookup("genres", genres[0]!.name, genres);
    expect(plan.entities[0]?.url).toBe(`${origin}/genre/safe`);
    expect(discoverCategories).toContain("分类");
    expect(categoryForFacet("分类", genres[0]!.name)).toBe("分类");
  });
  it("保留带发行日期的作品 URL，仅接受当前实体下一页，忽略脚本", () => {
    const result = parseJavbusWorks(
      `${listing()}<script>${card("BAD-001")}</script><a href="/star/other/2">下一页</a>`,
      entity.url,
      1,
    );
    expect(result).toMatchObject({ page: 1, nextPage: 2, items: [work] });
    expect(parseJavbusWorks(listing(1, "/star/other"), entity.url, 1).nextPage).toBeNull();
    expect(parseJavbusWorks(listing(1, "/star/123"), `${origin}/star/123`, 1).nextPage).toBe(2);
    expect(parseJavbusWorks(empty, entity.url, 1).items).toEqual([]);
    expect(() => parseJavbusWorks("<main>验证中</main>", entity.url, 1)).toThrow("未识别");
    expect(() =>
      parseJavbusWorks(
        listing().replace("<date>TEST-001</date>", "<date>WRONG-001</date>"),
        entity.url,
        1,
      ),
    ).toThrow("完整");
  });
  it("详情确认番号并只取信息区关系链接，不执行脚本和磁力请求", () => {
    expect(parseJavbusWorkDetails(detail(), work)).toMatchObject({
      provider: "JavBus",
      homepage: work.url,
      fields: {
        code: work.code,
        duration: 80,
        premiered: "2026-01-01",
        actors: [name],
        director: "示例导演",
        studio: "示例制作商",
        series: "示例系列",
        genres: ["安全示例分类"],
      },
    });
    expect(parseJavbusFacets(detail(), "studios", ["示例制作商"])).toEqual([
      { id: "studio:safe", name: "示例制作商", url: `${origin}/studio/safe` },
    ]);
    expect(parseJavbusFacets(detail(), "studios", ["示例"])).toEqual([]);
    expect(() => parseJavbusWorkDetails(detail("WRONG-001"), work)).toThrow("身份不一致");
    expect(() => parseJavbusWorks("x".repeat(2097153), entity.url, 1)).toThrow("大小限制");
  });
  it("CSV 名称到作品和详情闭环，并复用分页与身份缓存", async () => {
    const { service, fetch } = fixture();
    service.select("actresses", entry.name);
    await ready(service);
    expect(service.getSnapshot().entity?.id).toBe("star:sample");
    service.loadPage(2);
    await vi.waitFor(() => expect(service.getSnapshot().result?.page).toBe(2));
    service.loadPage(1);
    await ready(service);
    expect(fetch.mock.calls.filter(([url]) => url === entity.url)).toHaveLength(1);
    service.open(service.getSnapshot().result!.items[0]!);
    await vi.waitFor(() => expect(service.getSnapshot().detail?.value?.provider).toBe("JavBus"));
    service.closeDetail();
    service.select("genres", genres[0]!.name);
    await ready(service);
    service.select("actresses", entry.name);
    await ready(service);
    expect(fetch.mock.calls.filter(([url]) => url.includes("/searchstar/"))).toHaveLength(2);
    expect(fetch.mock.calls.some(([url]) => url.includes("a987"))).toBe(false);
  });
  it("同名多个身份须先选择，搜索结果不匹配时不会取第一项", async () => {
    const { service, fetch } = fixture(
      vi.fn(async (url, signal) =>
        url.includes("/searchstar/") ? actors(true) : fetchPage(url, signal),
      ),
    );
    service.select("actresses", name);
    await vi.waitFor(() => expect(service.getSnapshot().loading).toBe(false));
    expect(service.getSnapshot().entities).toHaveLength(2);
    expect(service.getSnapshot().result).toBeNull();
    expect(fetch.mock.calls.some(([url]) => url.includes("/star/"))).toBe(false);
    service.choose("star:sample");
    await ready(service);
    service.select("actresses", "完全不同姓名");
    await vi.waitFor(() => expect(service.getSnapshot().error).toContain("未找到"));
    expect(service.getSnapshot().result).toBeNull();
  });
  it("导演和制作商先由候选详情确认名称，再使用对应维度路径", async () => {
    const { service, fetch } = fixture();
    for (const [dimension, label, route] of [
      ["directors", "示例导演", "director"],
      ["studios", "示例制作商", "studio"],
    ] as const) {
      service.select(dimension, label);
      await ready(service);
      expect(service.getSnapshot().entity?.url).toBe(`${origin}/${route}/safe`);
    }
    expect(fetch.mock.calls.some(([url]) => url.includes("/studio/wrong"))).toBe(false);
  });
  it("候选详情总量有上限，查不到不会持续抓取更多页面", async () => {
    const { service, fetch } = fixture(
      vi.fn(async (url, _signal) =>
        url.includes("/search/")
          ? Array.from({ length: 20 }, (_, i) => card(`TEST-${i + 100}`)).join("")
          : detail(new URL(url).pathname.slice(1)),
      ),
    );
    service.select("directors", "不存在的示例导演");
    await vi.waitFor(() => expect(service.getSnapshot().error).toContain("未找到"));
    expect(fetch.mock.calls.filter(([url]) => url.includes("/TEST-"))).toHaveLength(2);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(10);
  });
  it("快速切换会取消旧搜索，旧响应不能覆盖当前分类", async () => {
    let release!: (value: string) => void;
    const { service, fetch } = fixture(
      vi.fn(async (url, signal) =>
        url.includes("/searchstar/")
          ? new Promise<string>((resolve) => {
              release = resolve;
            })
          : fetchPage(url, signal),
      ),
    );
    service.select("actresses", name);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const signal = fetch.mock.calls[0]![1];
    service.select("genres", genres[0]!.name);
    expect(signal.aborted).toBe(true);
    release(actors());
    await ready(service);
    expect(service.getSnapshot().selection?.dimension).toBe("genres");
    expect(service.getSnapshot().entity?.url).toBe(`${origin}/genre/safe`);
  });
  it("403 保留上一页，重试请求原目标页；退出等待清理完成", async () => {
    const { service, fetch } = fixture();
    service.select("genres", genres[0]!.name);
    await ready(service);
    fetch.mockRejectedValueOnce(new Error("安全 mock HTTP 403"));
    service.loadPage(2);
    await vi.waitFor(() => expect(service.getSnapshot().error).toContain("403"));
    expect(service.getSnapshot().result?.page).toBe(1);
    service.retry();
    await vi.waitFor(() => expect(service.getSnapshot().result?.page).toBe(2));
    const stop = vi.fn(async () => {});
    fetch.mockRejectedValueOnce(new StopUnconfirmedError(stop));
    service.retry();
    await vi.waitFor(() => expect(service.getSnapshot().error).toContain("清理"));
    await service.shutdown();
    expect(stop).toHaveBeenCalledOnce();
  });
  it("整条定位链到达时限即取消，超时后不保留后台任务", async () => {
    vi.useFakeTimers();
    const { service, fetch } = fixture(
      vi.fn(
        async (_url, signal) =>
          new Promise<string>((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          ),
      ),
    );
    service.select("actresses", name);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000);
    expect(service.getSnapshot().error).toContain("读取超时");
    expect(service.getSnapshot().loading).toBe(false);
    expect(fetch.mock.calls[0]![1].aborted).toBe(true);
  });
});
