import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  avwikiEntityUrl,
  isAvwikiWorksUrl,
  parseAvwikiWorks,
  parseAvwikiWorkDetails,
  resolveAvwikiEntities,
} from "../frontend/src/services/catalog/avwikiWorks";
import { AvwikiWorksService } from "../frontend/src/services/catalog/AvwikiWorksService";
import type {
  CatalogProcessor,
  CatalogRequest,
} from "../frontend/src/services/catalog/workerClient";
import {
  loadDiscovery,
  mergeDiscovery,
  parseAvwikiDirectory,
} from "../frontend/src/services/catalog/discoveryData";
import { StopUnconfirmedError } from "../frontend/src/services/downloads/ports";
import { listing, details } from "./fixtures/discover-works/data";

const entity = { id: "1", name: "示例女演员甲", url: avwikiEntityUrl("actresses", "1") };
const services: AvwikiWorksService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
});
function fixture(
  fetch = vi.fn(async (url: string, _signal: AbortSignal) =>
    url.includes("/work/") ? details(url.split("/")[4]) : listing(url.includes("page=2") ? 2 : 1),
  ),
  entities = [entity],
) {
  const run = async (
    operation: CatalogRequest["operation"],
    payload: CatalogRequest["payload"],
  ) => {
    const task = { operation, payload } as CatalogRequest;
    if (task.operation === "workEntities") return entities;
    if (task.operation === "works")
      return parseAvwikiWorks(task.payload.html, task.payload.entity, task.payload.page);
    if (task.operation === "workDetails")
      return parseAvwikiWorkDetails(task.payload.html, task.payload.work);
    throw new Error("测试未配置操作");
  };
  const processor = { run: run as CatalogProcessor["run"], close: vi.fn() };
  const service = new AvwikiWorksService(processor, fetch, async () => {});
  services.push(service);
  return { service, fetch };
}
const ready = async (service: AvwikiWorksService) =>
  vi.waitFor(() => {
    expect(service.getSnapshot().loading).toBe(false);
    expect(service.getSnapshot().result).not.toBeNull();
  });

describe("发现页 AVWikiDB 作品闭环（仅合成页面）", () => {
  it("五类目录使用来源 ID，译名和明确别名可定位，同名身份不自动合并", () => {
    const entries = [
      { id: "a12", name: "合成姓名", label: "中文合成姓名", aliases: ["合成别名"] },
      { id: "13", name: "合成姓名", label: "合成姓名", aliases: [] },
    ];
    for (const dimension of [
      "actresses",
      "maleActors",
      "directors",
      "studios",
      "series",
    ] as const) {
      expect(resolveAvwikiEntities(entries, dimension, "合成姓名")).toHaveLength(2);
      expect(resolveAvwikiEntities(entries, dimension, "合成别名")[0]?.url).toBe(
        avwikiEntityUrl(dimension, "a12"),
      );
      expect(resolveAvwikiEntities(entries, dimension, "不明确的姓名")).toEqual([]);
      expect(isAvwikiWorksUrl(avwikiEntityUrl(dimension, "a12", 1000))).toBe(true);
    }
    for (const url of [
      "https://avwikidb.com/actor/null/",
      "https://other.invalid/actor/1/",
      "https://user@avwikidb.com/work/TEST-001/",
      `${entity.url}?page=1001`,
      `${entity.url}?redirect=1`,
    ])
      expect(isAvwikiWorksUrl(url)).toBe(false);
  });
  it("目录更新保留来源身份，旧缓存也可加载，不依赖头像索引", () => {
    const parsed = parseAvwikiDirectory(
      '<div>全 2 件</div><ul class="entity-grid"><li><a href="/actor/1/">同名示例</a></li><li><a href="/actor/a2/">同名示例</a></li></ul>',
      "actresses",
      1,
    );
    expect(parsed.entries).toEqual({ "1": "同名示例", a2: "同名示例" });
    const seed = { genres: [], actors: [], entities: [] };
    const original = loadDiscovery(seed, null, Date.now());
    const merged = mergeDiscovery(
      seed,
      original.cache,
      { directory: { dimension: "actresses", ...parsed } },
      Date.now(),
    );
    expect(loadDiscovery(seed, merged.cache, Date.now()).directoryEntries?.actresses).toEqual(
      parsed.entries,
    );
    expect(
      resolveAvwikiEntities([], "actresses", "同名示例", merged.directoryEntries?.actresses),
    ).toHaveLength(2);
  });
  it("解析实际作品路径、当前实体分页；脚本及其他实体分页不参与结果", () => {
    const parsed = parseAvwikiWorks(
      listing() + '<script><a href="/work/WRONG-001/">广告</a></script>',
      entity,
      1,
    );
    expect(parsed.items.map((work) => work.code)).toEqual(["TEST-001", "TEST-002"]);
    expect(parsed).toMatchObject({ page: 1, nextPage: 2, total: 3 });
    expect(parseAvwikiWorks(listing(1, "/actor/999/"), entity, 1).nextPage).toBeNull();
    expect(parseAvwikiWorks("<main>全 0 件</main>", entity, 1).items).toEqual([]);
    expect(() => parseAvwikiWorks("<main>请验证</main>", entity, 1)).toThrow("未识别");
    expect(() => parseAvwikiWorks("x".repeat(2 * 1024 * 1024 + 1), entity, 1)).toThrow("大小限制");
  });
  it("详情使用来源结构化数据并校验番号，不执行脚本或误用另一作品", () => {
    const work = parseAvwikiWorks(listing(), entity, 1).items[0]!;
    expect(parseAvwikiWorkDetails(details(), work)).toMatchObject({
      provider: "AVWikiDB",
      fields: { code: "TEST-001", duration: 90, actors: ["示例女演员甲"], studio: "示例制作商甲" },
    });
    expect(() => parseAvwikiWorkDetails(details("TEST-009"), work)).toThrow("身份不一致");
  });
  it("同名多个来源必须明确选择，不会先读取其中一个条目的作品", async () => {
    const { service, fetch } = fixture(undefined, [
      entity,
      { ...entity, id: "2", url: avwikiEntityUrl("actresses", "2") },
    ]);
    service.select("actresses", entity.name);
    await vi.waitFor(() => expect(service.getSnapshot().entities).toHaveLength(2));
    expect(fetch).not.toHaveBeenCalled();
    expect(service.getSnapshot().entity).toBeNull();
    service.choose("2");
    await ready(service);
    expect(fetch).toHaveBeenCalledWith(avwikiEntityUrl("actresses", "2"), expect.any(AbortSignal));
  });
  it("没有本地影片也能获取作品，分页缓存与详情闭环工作", async () => {
    const { service, fetch } = fixture();
    service.select("actresses", entity.name);
    await ready(service);
    service.loadPage(2);
    await vi.waitFor(() => expect(service.getSnapshot().result?.page).toBe(2));
    service.loadPage(1);
    await vi.waitFor(() => expect(service.getSnapshot().result?.page).toBe(1));
    expect(fetch).toHaveBeenCalledTimes(2);
    service.open(service.getSnapshot().result!.items[0]!);
    await vi.waitFor(() =>
      expect(service.getSnapshot().detail?.value?.fields.code).toBe("TEST-001"),
    );
    service.closeDetail();
    expect(service.getSnapshot().detail).toBeNull();
  });
  it("首次挂载取消后重新挂载会恢复请求，旧响应不会覆盖新选择", async () => {
    const { service } = fixture();
    service.select("actresses", entity.name);
    service.cancel();
    service.select("actresses", entity.name);
    await ready(service);
    expect(service.getSnapshot().error).toBe("");
  });
  it("快速切换只保留一个最新待办，取消后旧页不得回写", async () => {
    let release!: (html: string) => void;
    const fetch = vi.fn(async (url: string, _signal: AbortSignal) => {
      if (url.includes("page=2"))
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      return listing();
    });
    const { service } = fixture(fetch);
    service.select("actresses", entity.name);
    await ready(service);
    service.loadPage(2);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    service.loadPage(3);
    service.loadPage(1);
    release(listing(2));
    await ready(service);
    expect(service.getSnapshot().result?.page).toBe(1);
    expect(fetch.mock.calls.some(([url]) => url.includes("page=3"))).toBe(false);
  });
  it("失败保留上一页，重试请求目标页；退出等待取数进程确认停止", async () => {
    const cleanup = vi.fn(async () => {});
    const { service, fetch } = fixture();
    service.select("actresses", entity.name);
    await ready(service);
    fetch.mockRejectedValueOnce(new Error("安全模拟网络故障"));
    service.loadPage(2);
    await vi.waitFor(() => expect(service.getSnapshot().error).toContain("模拟网络故障"));
    expect(service.getSnapshot().result?.page).toBe(1);
    service.retry();
    await vi.waitFor(() => expect(service.getSnapshot().result?.page).toBe(2));
    fetch.mockRejectedValueOnce(new StopUnconfirmedError(cleanup));
    service.retry();
    await vi.waitFor(() => expect(service.getSnapshot().error).toContain("清理"));
    await service.shutdown();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
