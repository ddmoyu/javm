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
  private countKnown = false;
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
  private reset(preserveCount: boolean) {
    ++this.generation;
    this.pages.clear();
    this.countKnown = false;
    this.publish({
      items: new Map(),
      ready: false,
      error: "",
      loading: this.active,
      ...(preserveCount ? {} : { total: 0, available: 0 }),
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
  private async pump() {
    if (this.running || !this.active || this.query === undefined || this.snapshot.error) return;
    this.running = true;
    try {
      while (this.active && this.query !== undefined && !this.snapshot.error) {
        const page = this.wanted.find(
          (index) =>
            !this.pages.has(index) &&
            (!this.countKnown || index * LIBRARY_PAGE_SIZE < this.snapshot.total),
        );
        if (page === undefined) break;
        const generation = this.generation;
        this.publish({ loading: true });
        try {
          const result = await this.fetch(this.query, {
            offset: page * LIBRARY_PAGE_SIZE,
            limit: LIBRARY_PAGE_SIZE,
            includeTotal: !this.countKnown,
          });
          if (generation !== this.generation) continue;
          // 发现页只保留当前页；快速翻页时迟到的旧页不再写回或阻塞新页。
          if (this.cachePages === 1 && !this.wanted.includes(page)) continue;
          if (result.items.length > LIBRARY_PAGE_SIZE || result.offset !== page * LIBRARY_PAGE_SIZE)
            throw new Error("片库分页响应无效，请重试。");
          const total = result.total ?? this.snapshot.total;
          if (!this.countKnown && result.total === undefined)
            throw new Error("片库计数响应无效，请重试。");
          this.countKnown = true;
          this.pages.set(page, result.items);
          while (this.pages.size > this.cachePages) {
            const oldest =
              [...this.pages.keys()].find((key) => !this.wanted.includes(key)) ??
              this.pages.keys().next().value!;
            this.pages.delete(oldest);
          }
          const items = new Map<number, T>();
          for (const [index, values] of this.pages)
            values.forEach((item, offset) => items.set(index * LIBRARY_PAGE_SIZE + offset, item));
          this.publish({
            items,
            total,
            available:
              result.available ?? (result.total !== undefined ? total : this.snapshot.available),
            ready: true,
            error: "",
          });
          if (this.wanted[0]! * LIBRARY_PAGE_SIZE >= total)
            this.wanted = [Math.max(0, Math.ceil(total / LIBRARY_PAGE_SIZE) - 1)];
        } catch (error) {
          if (
            generation === this.generation &&
            (this.cachePages !== 1 || this.wanted.includes(page))
          )
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
