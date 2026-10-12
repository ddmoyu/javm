import { expect, it, vi } from "vite-plus/test";
import { LibraryService } from "../frontend/src/services/library/LibraryService";
import { PagedQuery } from "../frontend/src/services/library/PagedQuery";
import { DiscoveryCatalogService } from "../frontend/src/services/catalog/DiscoveryCatalogService";
import { loadDiscovery } from "../frontend/src/services/catalog/discoveryData";
import { queryCatalog } from "../frontend/src/services/catalog/catalogData";
import { PortraitService } from "../frontend/src/services/catalog/PortraitService";
import type { PortraitPort } from "../frontend/src/services/catalog/PortraitService";
import type {
  CatalogProcessor,
  CatalogRequest,
} from "../frontend/src/services/catalog/workerClient";
import type { PageRequest } from "../frontend/src/contracts/library";

it("发现名单每次读取一百条，仅保留当前页，不预取相邻页", async () => {
  const names = Array.from({ length: 75303 }, (_, index) => `安全演员${index}`);
  const data = loadDiscovery(
    {
      genres: [],
      actors: [],
      entities: [],
      javbusEntries: names.map((name, index) => ({
        dimension: "actresses",
        lane: "censored",
        id: `safe-${index}`,
        name,
        label: name,
        aliases: [],
        translationStatus: "pending",
        category: "",
      })),
    },
    null,
    Date.now(),
  );
  const requests: PageRequest[] = [];
  const processor: CatalogProcessor = {
    run: (async (operation, payload) => {
      const request = { operation, payload } as CatalogRequest;
      if (request.operation === "discoveryLoad") return data;
      if (request.operation === "query") {
        requests.push(request.payload.page);
        return queryCatalog(request.payload.names, request.payload.query, request.payload.page);
      }
      throw new Error("Unexpected fixture operation");
    }) as CatalogProcessor["run"],
    close: vi.fn(),
  };
  const catalog = new DiscoveryCatalogService(processor);
  const library = new LibraryService(undefined, catalog);
  const view = library.createFacetQuery(true);
  try {
    await catalog.ready();
    view.configure({ dimension: "actresses", sort: "source" }, true);
    await vi.waitFor(() => expect(view.getSnapshot().loading).toBe(false));
    expect(requests.map(({ offset, limit }) => [offset, limit])).toEqual([[0, 100]]);
    expect(view.getSnapshot().items.size).toBe(100);
    view.loadRange(75200, 75299);
    await vi.waitFor(() => expect(view.getSnapshot().loading).toBe(false));
    expect(requests.map(({ offset, limit }) => [offset, limit])).toEqual([
      [0, 100],
      [75200, 100],
    ]);
    expect(view.getSnapshot().items.size).toBe(100);
    expect(view.getSnapshot().items.has(0)).toBe(false);
    expect(view.getSnapshot().items.get(75200)?.name).toBe("安全演员75200");
    view.loadRange(75300, 75399);
    await vi.waitFor(() => expect(view.getSnapshot().loading).toBe(false));
    expect(view.getSnapshot().items.size).toBe(3);
    expect(requests.at(-1)?.offset).toBe(75300);
  } finally {
    view.setActive(false);
    await library.shutdown();
  }
});

it("单页模式快速翻页时忽略旧页失败，只继续读取最新目标页", async () => {
  let rejectOld!: (error: Error) => void;
  const fetch = vi.fn(async (_query: object, page: PageRequest) => {
    if (page.offset === 100)
      return new Promise<{ offset: number; total: number; items: number[] }>((_resolve, reject) => {
        rejectOld = reject;
      });
    return { offset: page.offset, total: 1000, items: [page.offset] };
  });
  const view = new PagedQuery(fetch, 1);
  view.configure({}, true);
  await vi.waitFor(() => expect(view.getSnapshot().loading).toBe(false));
  view.loadRange(100, 199);
  view.loadRange(200, 299);
  view.loadRange(300, 399);
  rejectOld(new Error("Safe obsolete failure"));
  await vi.waitFor(() => expect(view.getSnapshot().loading).toBe(false));
  expect(fetch.mock.calls.map(([, page]) => page.offset)).toEqual([0, 100, 300]);
  expect([...view.getSnapshot().items.values()]).toEqual([300]);
  expect(view.getSnapshot().error).toBe("");
  view.setActive(false);
});

function portraitFixture(load: PortraitPort["load"]) {
  const run = vi.fn(async (_operation: string, payload: { names: string[] }) =>
    Object.fromEntries(
      payload.names.map((name) => [name, [`https://safe.example.invalid/${name}`]]),
    ),
  );
  const service = new PortraitService(
    { run: run as CatalogProcessor["run"], close: vi.fn() },
    { load, index: vi.fn(), shutdown: vi.fn() },
  );
  return { service, run };
}

it("一百条头像分两批读取，最多四个下载并发，进度覆盖整页", async () => {
  let active = 0,
    maximum = 0;
  const load = vi.fn(async (_url: string, _signal: AbortSignal, key: string) => {
    maximum = Math.max(maximum, ++active);
    await Promise.resolve();
    active--;
    return `safe:${key}`;
  });
  const { service, run } = portraitFixture(load);
  const names = Array.from({ length: 100 }, (_, index) => `安全演员${index}`);
  const progress = vi.fn();
  try {
    const result = await service.load("actresses", names, new AbortController().signal, progress);
    expect(run.mock.calls.map(([, payload]) => payload.names.length)).toEqual([50, 50]);
    expect(load).toHaveBeenCalledTimes(100);
    expect(maximum).toBeLessThanOrEqual(4);
    expect(Object.keys(result)).toEqual(names);
    expect(progress).toHaveBeenLastCalledWith(100, 100, result);
  } finally {
    await service.shutdown();
  }
});

it("离开当前页会取消头像余下批次，不再为旧页继续下载", async () => {
  const abort = new AbortController();
  const load = vi.fn(async (_url: string, signal: AbortSignal) => {
    abort.abort();
    signal.throwIfAborted();
    return "unreachable";
  });
  const { service, run } = portraitFixture(load);
  try {
    await expect(
      service.load(
        "actresses",
        Array.from({ length: 100 }, (_, index) => `安全演员${index}`),
        abort.signal,
      ),
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
    expect(load.mock.calls.length).toBeLessThanOrEqual(4);
  } finally {
    await service.shutdown();
  }
});
