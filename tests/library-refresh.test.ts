import { describe, expect, it, vi } from "vite-plus/test";
import { PagedQuery } from "../frontend/src/services/library/PagedQuery";
import type { PageRequest, QueryPage } from "../frontend/src/contracts/library";

interface Item {
  id: string;
  cover: string;
}
const page = (offset: number, cover: string, total = 300): QueryPage<Item> => ({
  offset,
  total,
  items: Array.from({ length: Math.max(0, Math.min(100, total - offset)) }, (_, index) => ({
    id: `safe-film-${offset + index}`,
    cover,
  })),
});
const idle = async <Q>(view: PagedQuery<Item, Q>) => {
  await vi.waitFor(() => expect(view.getSnapshot().loading).toBe(false));
};
function fixture() {
  const requests: {
    query: { text: string };
    request: PageRequest;
    resolve: (result: QueryPage<Item>) => void;
    reject: (error: Error) => void;
  }[] = [];
  const fetch = vi.fn(
    (query: { text: string }, request: PageRequest) =>
      new Promise<QueryPage<Item>>((resolve, reject) => {
        requests.push({ query, request, resolve, reject });
      }),
  );
  return { view: new PagedQuery(fetch), requests };
}

describe("媒体库后台刷新保持卡片", () => {
  it("跨页封面刷新保留已有卡片，全部可见页就绪后一起替换", async () => {
    const { view, requests } = fixture();
    view.configure({ text: "" }, true);
    requests[0]!.resolve(page(0, "旧封面"));
    await idle(view);
    view.loadRange(90, 110);
    requests[1]!.resolve(page(100, "旧封面"));
    await idle(view);
    const previous = view.getSnapshot();
    const snapshots = [previous];
    view.subscribe(() => snapshots.push(view.getSnapshot()));

    view.invalidate();
    expect(view.getSnapshot().items).toBe(previous.items);
    expect(view.getSnapshot()).toMatchObject({ ready: true, loading: true, total: 300 });
    expect(requests[2]!.request).toMatchObject({ offset: 0, includeTotal: true });
    requests[2]!.resolve({ ...page(0, "新封面", 250), available: 400 });
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    expect(view.getSnapshot().items).toBe(previous.items);
    expect(view.getSnapshot().total).toBe(300);
    expect(requests[3]!.request).toMatchObject({ offset: 100, includeTotal: false });
    requests[3]!.resolve({ ...page(100, "新封面", 250), total: undefined });
    await idle(view);

    expect(view.getSnapshot()).toMatchObject({ ready: true, total: 250, available: 400 });
    expect(view.getSnapshot().items.get(90)?.cover).toBe("新封面");
    expect(view.getSnapshot().items.get(110)?.cover).toBe("新封面");
    expect(
      snapshots.every(
        (snapshot) => snapshot.ready && snapshot.items.has(90) && snapshot.items.has(110),
      ),
    ).toBe(true);
    expect(
      snapshots.every(
        (snapshot) => snapshot.items.get(90)?.cover === snapshot.items.get(110)?.cover,
      ),
    ).toBe(true);
  });

  it("刷新失败保留原卡片，显式重试后更新", async () => {
    const { view, requests } = fixture();
    view.configure({ text: "" }, true);
    requests[0]!.resolve(page(0, "旧封面"));
    await idle(view);
    const previous = view.getSnapshot().items;
    view.invalidate();
    requests[1]!.reject(new Error("模拟数据库忙"));
    await idle(view);
    expect(view.getSnapshot()).toMatchObject({ ready: true, error: "模拟数据库忙", total: 300 });
    expect(view.getSnapshot().items).toBe(previous);
    view.loadRange(0, 20);
    expect(requests).toHaveLength(2);

    view.retry();
    expect(view.getSnapshot().items).toBe(previous);
    requests[2]!.resolve(page(0, "新封面"));
    await idle(view);
    expect(view.getSnapshot().items.get(0)?.cover).toBe("新封面");
    expect(view.getSnapshot().error).toBe("");
  });

  it("刷新中滚回已就绪页时仍交付新封面，丢弃离开视野的迟到页", async () => {
    const { view, requests } = fixture();
    view.configure({ text: "" }, true);
    requests[0]!.resolve(page(0, "旧封面"));
    await idle(view);
    view.loadRange(90, 110);
    requests[1]!.resolve(page(100, "旧封面"));
    await idle(view);

    view.invalidate();
    requests[2]!.resolve(page(0, "新封面"));
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    view.loadRange(0, 20);
    requests[3]!.resolve({ ...page(100, "迟到封面"), total: undefined });
    await idle(view);
    expect(requests).toHaveLength(4);
    expect(view.getSnapshot().items.get(0)?.cover).toBe("新封面");
    expect(view.getSnapshot().items.has(100)).toBe(false);
  });

  it.each([false, true])("刷新在途切换筛选时清空旧内容并忽略迟到响应（失败：%s）", async (fail) => {
    const { view, requests } = fixture();
    view.configure({ text: "旧筛选" }, true);
    requests[0]!.resolve(page(0, "旧封面"));
    await idle(view);
    view.invalidate();
    view.configure({ text: "新筛选" }, true);
    expect(view.getSnapshot()).toMatchObject({ ready: false, total: 0, error: "" });
    expect(view.getSnapshot().items.size).toBe(0);
    expect(requests).toHaveLength(2);

    if (fail) requests[1]!.reject(new Error("过期刷新失败"));
    else requests[1]!.resolve(page(0, "过期封面"));
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]!.query.text).toBe("新筛选");
    expect(requests[2]!.request.includeTotal).toBe(true);
    requests[2]!.resolve(page(0, "新筛选封面", 1));
    await idle(view);
    expect(view.getSnapshot()).toMatchObject({ ready: true, total: 1, error: "" });
    expect(view.getSnapshot().items.get(0)?.cover).toBe("新筛选封面");
  });

  it("总数收缩后等有效末页就绪再替换，避免中途清空列表", async () => {
    const { view, requests } = fixture();
    view.configure({ text: "" }, true);
    requests[0]!.resolve(page(0, "旧封面"));
    await idle(view);
    view.loadRange(280, 290);
    requests[1]!.resolve(page(200, "旧封面"));
    await idle(view);
    const previous = view.getSnapshot().items;

    view.invalidate();
    requests[2]!.resolve(page(200, "新封面", 99));
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    expect(requests[3]!.request).toMatchObject({ offset: 0, includeTotal: false });
    expect(view.getSnapshot().items).toBe(previous);
    expect(view.getSnapshot().total).toBe(300);
    requests[3]!.resolve({ ...page(0, "新封面", 99), total: undefined });
    await idle(view);
    expect(view.getSnapshot()).toMatchObject({ total: 99, available: 99, ready: true });
    expect(view.getSnapshot().items.size).toBe(99);
    expect(view.getSnapshot().items.get(98)?.cover).toBe("新封面");
    expect(view.getSnapshot().items.has(280)).toBe(false);
  });

  it("刷新后结果为空时正确显示空状态，隐藏视图重新进入才刷新", async () => {
    const { view, requests } = fixture();
    view.configure({ text: "" }, true);
    requests[0]!.resolve(page(0, "旧封面"));
    await idle(view);
    const previous = view.getSnapshot().items;
    view.setActive(false);
    view.invalidate();
    expect(requests).toHaveLength(1);
    expect(view.getSnapshot().items).toBe(previous);
    view.setActive(true);
    requests[1]!.resolve(page(0, "", 0));
    await idle(view);
    expect(view.getSnapshot()).toMatchObject({ ready: true, total: 0, available: 0 });
    expect(view.getSnapshot().items.size).toBe(0);
  });
});
