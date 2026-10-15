import { describe, expect, it, vi } from "vite-plus/test";
import {
  LIBRARY_CACHE_PAGES,
  LIBRARY_PAGE_SIZE,
  PagedQuery,
} from "../frontend/src/services/library/PagedQuery";
import type { QueryPage } from "../frontend/src/contracts/library";

const page = (offset: number, total = 50000): QueryPage<number> => ({
  offset,
  total,
  items: Array.from({ length: Math.max(0, Math.min(100, total - offset)) }, (_, i) => offset + i),
});
const idle = async <T, Q>(view: PagedQuery<T, Q>) => {
  await vi.waitFor(() => expect(view.getSnapshot().loading).toBe(false));
};

describe("有界媒体库分页", () => {
  it("首屏只读取一页，随机访问末尾不会读取中间五万条记录", async () => {
    const fetch = vi.fn(async (_: object, request: { offset: number }) => page(request.offset));
    const view = new PagedQuery(fetch);
    view.configure({}, true);
    await idle(view);
    expect(view.getSnapshot().items.size).toBe(100);
    view.loadRange(49980, 49999);
    await idle(view);
    expect(fetch.mock.calls.map((call) => call[1].offset)).toEqual([0, 49900]);
    expect(view.getSnapshot().items.get(49999)).toBe(49999);
  });
  it("滚动缓存始终有界，淘汰后回滚能够重新加载", async () => {
    const view = new PagedQuery(async (_: object, request) => page(request.offset));
    view.configure({}, true);
    await idle(view);
    for (let offset = 100; offset <= 2000; offset += 100) {
      view.loadRange(offset, offset + 20);
      await idle(view);
      expect(view.getSnapshot().items.size).toBeLessThanOrEqual(
        LIBRARY_CACHE_PAGES * LIBRARY_PAGE_SIZE,
      );
    }
    expect(view.getSnapshot().items.has(0)).toBe(false);
    view.loadRange(0, 30);
    await idle(view);
    expect(view.getSnapshot().items.get(0)).toBe(0);
  });
  it.each([false, true])("慢请求只保留最新查询，忽略过期响应（失败：%s）", async (fail) => {
    let release!: (value: QueryPage<string>) => void;
    let reject!: (error: Error) => void;
    const fetch = vi.fn(async (query: { text: string }) => {
      if (query.text === "old")
        return new Promise<QueryPage<string>>((resolve, rejectRequest) => {
          release = resolve;
          reject = rejectRequest;
        });
      return { offset: 0, total: 1, items: [query.text] };
    });
    const view = new PagedQuery(fetch);
    view.configure({ text: "old" }, true);
    view.configure({ text: "intermediate" }, true);
    view.configure({ text: "new" }, true);
    expect(fetch).toHaveBeenCalledTimes(1);
    if (fail) reject(new Error("过期请求失败"));
    else release({ offset: 0, total: 1, items: ["old"] });
    await idle(view);
    expect(fetch.mock.calls.map(([query]) => query.text)).toEqual(["old", "new"]);
    expect([...view.getSnapshot().items.values()]).toEqual(["new"]);
    expect(view.getSnapshot().error).toBe("");
  });
  it("慢滚动请求期间丢掉中间范围，最多一个请求在途", async () => {
    let release!: (value: QueryPage<number>) => void;
    const fetch = vi.fn(async (_: object, request: { offset: number }) =>
      request.offset === 100
        ? new Promise<QueryPage<number>>((resolve) => {
            release = resolve;
          })
        : page(request.offset),
    );
    const view = new PagedQuery(fetch);
    view.configure({}, true);
    await idle(view);
    view.loadRange(100, 120);
    view.loadRange(1000, 1030);
    view.loadRange(3000, 3040);
    expect(fetch).toHaveBeenCalledTimes(2);
    release(page(100));
    await idle(view);
    expect(fetch.mock.calls.map((call) => call[1].offset)).toEqual([0, 100, 3000]);
  });
  it("错误显示后不自动循环请求，重试能恢复", async () => {
    let fail = true;
    const fetch = vi.fn(async () => {
      if (fail) throw new Error("数据库忙");
      return page(0, 1);
    });
    const view = new PagedQuery<number, object>(fetch);
    view.configure({}, true);
    await idle(view);
    view.loadRange(0, 10);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(view.getSnapshot().error).toBe("数据库忙");
    fail = false;
    view.retry();
    await idle(view);
    expect(view.getSnapshot()).toMatchObject({ error: "", ready: true, total: 1 });
  });
  it("删除收藏造成末页消失时，收缩范围并加载有效页面", async () => {
    let total = 1200;
    const view = new PagedQuery(async (_: object, request) => page(request.offset, total));
    view.configure({}, true);
    await idle(view);
    view.loadRange(1150, 1180);
    await idle(view);
    total = 99;
    view.invalidate();
    await idle(view);
    expect(view.getSnapshot().items.get(0)).toBe(0);
    expect(view.getSnapshot().total).toBe(99);
  });
  it("隐藏视图不继续查询，重新激活后保持范围和维度总数", async () => {
    const fetch = vi.fn(async (_: object, request: { offset: number; includeTotal: boolean }) => ({
      ...page(request.offset, 500),
      ...(request.includeTotal ? { available: 600 } : { total: undefined }),
    }));
    const view = new PagedQuery(fetch);
    view.configure({}, true);
    await idle(view);
    view.setActive(false);
    view.loadRange(220, 260);
    expect(fetch).toHaveBeenCalledTimes(1);
    view.setActive(true);
    await idle(view);
    expect(view.getSnapshot().available).toBe(600);
    expect(view.getSnapshot().items.get(250)).toBe(250);
  });
});
