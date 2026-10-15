import type { PageRequest, QueryPage } from "../../contracts/library";

export const LIBRARY_PAGE_SIZE = 100;
export const LIBRARY_CACHE_PAGES = 6;
export interface QuerySnapshot<T> {
  items: ReadonlyMap<number, T>;
  total: number;
  available: number;
  ready: boolean;
  loading: boolean;
  error: string;
}

// 一个视图只有一个在途请求和一个最新可见范围。换条件即废弃旧结果，
// 不把快速滚动/打字产生的中间请求排入扩展队列，也不分配整库长度的数组。
export class PagedQuery<T, Q> {
  private snapshot: QuerySnapshot<T> = {
    items: new Map(),
    total: 0,
    available: 0,
    ready: false,
    loading: false,
    error: "",
  };
  private listeners = new Set<() => void>();
  private pages = new Map<number, T[]>();
  private query?: Q;
  private key = "";
  private generation = 0;
  private active = false;
  private running = false;
  private counts?: { total: number; available: number };
  private retainingResults = false;
  private wanted = [0];
  constructor(
    private fetch: (query: Q, page: PageRequest) => Promise<QueryPage<T>>,
    private readonly cachePages = LIBRARY_CACHE_PAGES,
  ) {}
  getSnapshot = () => this.snapshot;
  isActive = () => this.active;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(change: Partial<QuerySnapshot<T>>) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
  configure(query: Q, active: boolean) {
    const key = JSON.stringify(query);
    if (key !== this.key) {
      this.key = key;
      this.query = query;
      this.wanted = [0];
      this.reset(false);
    }
    this.setActive(active);
  }
  setActive(active: boolean) {
    this.active = active;
    if (active) void this.pump();
  }
  private reset(preserveResults: boolean) {
    ++this.generation;
    this.pages.clear();
    this.counts = undefined;
    this.retainingResults = preserveResults && this.snapshot.ready;
    this.publish({
      error: "",
      loading: this.active,
      ...(preserveResults ? {} : { items: new Map(), ready: false, total: 0, available: 0 }),
    });
  }
  invalidate = () => {
    this.reset(true);
    if (this.active) void this.pump();
  };
  retry = () => {
    this.publish({ error: "" });
    void this.pump();
  };
  loadRange = (first: number, last: number) => {
    const start = Math.floor(Math.max(0, first) / LIBRARY_PAGE_SIZE);
    const end = Math.min(
      start + this.cachePages - 1,
      Math.floor(Math.max(first, last) / LIBRARY_PAGE_SIZE),
    );
    this.wanted = Array.from({ length: end - start + 1 }, (_, index) => start + index);
    // 可见范围命中的页成为最近使用页；不因回滚访问被后续请求提前淘汰。
    for (const page of this.wanted) {
      const items = this.pages.get(page);
      if (items) {
        this.pages.delete(page);
        this.pages.set(page, items);
      }
    }
    void this.pump();
  };
  private publishPages() {
    if (!this.counts) return;
    this.retainingResults = false;
    const items = new Map<number, T>();
    for (const [index, values] of this.pages)
      values.forEach((item, offset) => items.set(index * LIBRARY_PAGE_SIZE + offset, item));
    this.publish({ items, ...this.counts, ready: true, error: "" });
  }
  private async pump() {
    if (this.running || !this.active || this.query === undefined || this.snapshot.error) return;
    this.running = true;
    try {
      while (this.active && this.query !== undefined && !this.snapshot.error) {
        const page = this.wanted.find(
          (index) =>
            !this.pages.has(index) &&
            (!this.counts || index * LIBRARY_PAGE_SIZE < this.counts.total),
        );
        if (page === undefined) {
          // 滚动回已经刷新的页时，迟到的其他页会被丢弃，仍需交付当前结果。
          if (this.retainingResults) this.publishPages();
          break;
        }
        const generation = this.generation;
        this.publish({ loading: true });
        try {
          const result = await this.fetch(this.query, {
            offset: page * LIBRARY_PAGE_SIZE,
            limit: LIBRARY_PAGE_SIZE,
            includeTotal: !this.counts,
          });
          if (generation !== this.generation) continue;
          // 快速滚动时迟到且已离开可见范围的页不再写回，避免挤掉当前页。
          if (!this.wanted.includes(page)) continue;
          if (result.items.length > LIBRARY_PAGE_SIZE || result.offset !== page * LIBRARY_PAGE_SIZE)
            throw new Error("片库分页响应无效，请重试。");
          const total = result.total ?? this.counts?.total;
          if (total === undefined) throw new Error("片库计数响应无效，请重试。");
          this.counts = {
            total,
            available:
              result.available ?? (result.total !== undefined ? total : this.counts!.available),
          };
          this.pages.set(page, result.items);
          while (this.pages.size > this.cachePages) {
            const oldest =
              [...this.pages.keys()].find((key) => !this.wanted.includes(key)) ??
              this.pages.keys().next().value!;
            this.pages.delete(oldest);
          }
          if (this.wanted[0]! * LIBRARY_PAGE_SIZE >= total)
            this.wanted = [Math.max(0, Math.ceil(total / LIBRARY_PAGE_SIZE) - 1)];
          // 同条件后台刷新保留卡片，等可见范围的所有页就绪后一起替换，
          // 避免骨架闪烁、封面重新挂载，以及跨页排序变化时混入新旧记录。
          if (
            this.retainingResults &&
            this.wanted.some((index) => index * LIBRARY_PAGE_SIZE < total && !this.pages.has(index))
          )
            continue;
          this.publishPages();
        } catch (error) {
          if (generation === this.generation && this.wanted.includes(page))
            this.publish({
              error: error instanceof Error ? error.message : "片库读取失败，请重试。",
            });
        }
      }
    } finally {
      this.running = false;
      this.publish({ loading: false });
    }
  }
}
