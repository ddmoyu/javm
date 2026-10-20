import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { OnlineActorSearchService } from "../frontend/src/services/catalog/OnlineActorSearchService";
import { OnlineWorksService } from "../frontend/src/services/catalog/OnlineWorksService";
import {
  javbusSearchUrl,
  parseJavbusActorSearch,
  parseJavbusWorks,
} from "../frontend/src/services/catalog/javbusWorks";
import type {
  CatalogProcessor,
  CatalogRequest,
} from "../frontend/src/services/catalog/workerClient";

// 所有 HTML 为安全虚构内容；域名仅参与 URL 校验，绝不进行真实请求。
const card = (id: string, name: string) =>
  `<a class="avatar-box" href="/star/${id}"><img title="${name}"></a>`;
const empty = "<p>No actresses found</p>";
const query = "示例";
const url = javbusSearchUrl("actresses", query, "censored");
function processor(): CatalogProcessor {
  return {
    run: (async (operation, payload) => {
      const task = { operation, payload } as CatalogRequest;
      if (task.operation === "javbusActorSearch")
        return parseJavbusActorSearch(task.payload.html, task.payload.url, task.payload.page);
      if (task.operation === "javbusWorks")
        return parseJavbusWorks(task.payload.html, task.payload.url, task.payload.page);
      throw new Error("搜索不得依赖 CSV 或名单初始化");
    }) as CatalogProcessor["run"],
    close() {},
  };
}
const services: { shutdown(): Promise<void> }[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  vi.useRealTimers();
});
function fixture(fetch: (url: string, signal: AbortSignal) => Promise<string>) {
  const service = new OnlineActorSearchService(processor(), fetch);
  services.push(service);
  return service;
}
const ready = (service: OnlineActorSearchService) =>
  vi.waitFor(() => expect(service.getSnapshot()).toMatchObject({ ready: true, loading: false }), {
    interval: 5,
  });

describe("在线演员搜索", () => {
  it("返回未收录演员及部分名称匹配，保留网站顺序并识别下一页", () => {
    const result = parseJavbusActorSearch(
      card("z", "Z 示例演员") + card("a", "A 示例演员") + `<a href="${url}/2">下一页</a>`,
      url,
      1,
    );
    expect(result.items.map((item) => item.name)).toEqual(["Z 示例演员", "A 示例演员"]);
    expect(result.nextPage).toBe(2);
    expect(() => parseJavbusActorSearch(card("z", "示例"), url, 2)).toThrow("页码");
    expect(() => parseJavbusActorSearch("<html>结构变化</html>", url, 1)).toThrow();
  });
  it("分页跳过已结束的分区，返回上一页复用缓存", async () => {
    const fetch = vi.fn(async (address: string) =>
      address.includes("/uncensored/")
        ? empty
        : address.endsWith("/2")
          ? card("second", "示例第二页")
          : card("first", "示例第一页") + `<a href="${url}/2">下一页</a>`,
    );
    const service = fixture(fetch);
    service.search(query);
    await ready(service);
    expect(service.getSnapshot().items[0]?.id).toBe("star:first");
    service.search(query, 2);
    await ready(service);
    expect(service.getSnapshot().items[0]?.id).toBe("star:second");
    expect(fetch.mock.calls.map(([address]) => address)).toEqual([
      url,
      javbusSearchUrl("actresses", query, "uncensored"),
      `${url}/2`,
    ]);
    service.search(query);
    await ready(service);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("一个分区失败仍保留另一个结果，重试可恢复", async () => {
    let failing = true;
    const service = fixture(async (address) => {
      if (address.includes("/uncensored/")) {
        if (failing) throw new Error("安全模拟断网");
        return empty;
      }
      return card("safe", "未收录示例演员");
    });
    service.search(query);
    await ready(service);
    expect(service.getSnapshot().items).toHaveLength(1);
    expect(service.getSnapshot().errors.uncensored).toBe("安全模拟断网");
    failing = false;
    service.retry();
    await ready(service);
    expect(service.getSnapshot().errors).toEqual({});
  });
  it("快速更换关键词只执行最后一个待办，过期结果不能覆盖新结果", async () => {
    let finish!: (value: string) => void;
    let previousSignal!: AbortSignal;
    const fetch = vi.fn(async (address: string, signal: AbortSignal) => {
      if (address === javbusSearchUrl("actresses", "旧查询", "censored")) {
        previousSignal = signal;
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      }
      return address.includes("/uncensored/") ? empty : card("new", "新查询示例演员");
    });
    const service = fixture(fetch);
    service.search("旧查询");
    service.search("中间查询");
    service.search("新查询");
    expect(previousSignal.aborted).toBe(true);
    finish(card("old", "旧查询示例演员"));
    await ready(service);
    expect(service.getSnapshot().items.map((item) => item.id)).toEqual(["star:new"]);
    expect(
      fetch.mock.calls.some(([address]) => decodeURIComponent(address).includes("中间查询")),
    ).toBe(false);
    service.cancel();
    expect(service.getSnapshot().ready).toBe(false);
    service.retry();
    await ready(service);
  });
  it("超时终止请求并可重试，不出现永久加载", async () => {
    vi.useFakeTimers();
    const service = fixture(
      async (_, signal) =>
        new Promise<string>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
    );
    service.search(query);
    await vi.advanceTimersByTimeAsync(60001);
    expect(service.getSnapshot()).toMatchObject({
      loading: false,
      ready: true,
      errors: { censored: expect.stringContaining("超时") },
    });
  });
  it("点击搜索结果直接按来源身份查作品，不再次按名称或 CSV 解析", async () => {
    const fetch = vi.fn(
      async () =>
        '<a class="movie-box" href="/SAFE-001"><img title="安全合成纪录片"><date>SAFE-001</date></a>',
    );
    const prepare = vi.fn(async () => {
      throw new Error("不应读取 CSV");
    });
    const service = new OnlineWorksService(processor(), fetch, prepare);
    services.push(service);
    service.selectEntity("actresses", {
      id: "star:unlisted",
      name: "未收录示例演员",
      url: "https://www.javbus.com/star/unlisted",
    });
    await vi.waitFor(() => expect(service.getSnapshot().result?.items[0]?.code).toBe("SAFE-001"));
    expect(prepare).not.toHaveBeenCalled();
    expect(fetch.mock.calls).toHaveLength(1);
  });
});
