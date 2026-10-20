import { StopUnconfirmedError } from "../downloads/ports";

export interface HttpRequest {
  url: string;
  output?: string;
  proxy?: string;
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  maxBytes: number;
  timeoutMs: number;
  connectTimeoutMs?: number;
  maxRedirects?: number;
  cacheTtlMs?: number;
  purpose: "catalog" | "portrait" | "metadata" | "artwork" | "resolution" | "proxy" | "analytics";
}
export interface HttpResponse {
  status: number;
  exitCode: number;
  bytes: number;
  headers: Record<string, string>;
  setCookie: boolean;
  ambiguousHeaders: boolean;
  effectiveUrl: string;
  connections: number;
  elapsedMs: number;
  tunnelStatus: number;
}
export interface HttpPort {
  execute(request: HttpRequest, signal: AbortSignal): Promise<HttpResponse & { path: string }>;
  copy(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}
/** 图片（封面、预览图、头像）与网页、资料请求分道限流。 */
type Lane = "image" | "page";
const laneOf = (purpose: HttpRequest["purpose"]): Lane =>
  purpose === "artwork" || purpose === "portrait" ? "image" : "page";
interface LaneLimits {
  parallel: number;
  perHost: number;
  intervalMs: number;
}
interface Job {
  key: string;
  /** 限流分组：站点加分道，网页与图片互不占用对方的名额。 */
  origin: string;
  lane: Lane;
  request: HttpRequest;
  abort: AbortController;
  users: number;
  state: "queued" | "running" | "done";
  deadline: number;
  expires: number;
  response?: HttpResponse & { path: string };
  promise: Promise<HttpResponse & { path: string }>;
  resolve(value: HttpResponse & { path: string }): void;
  reject(error: unknown): void;
}

/** 应用级、有界队列。文件留在磁盘；主线程不接收网络二进制正文。 */
export class HttpService {
  private jobs = new Set<Job>();
  private reusable = new Map<string, Job>();
  private queue: Job[] = [];
  private running = 0;
  private laneRunning: Record<Lane, number> = { image: 0, page: 0 };
  private hosts = new Map<string, { running: number; next: number }>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private removals = new Set<Promise<void>>();
  private failedRemovals = new Set<string>();
  private recovering?: Promise<void>;
  private consumers = new Set<Promise<HttpResponse>>();
  constructor(
    private port: HttpPort,
    /**
     * 顶层的 parallel / perHost / intervalMs 用于网页与资料请求，保护目标站点。
     * images 用于图片 CDN：并发更高、不设起始间隔；省略时与网页相同。
     */
    private limits: LaneLimits & {
      queued: number;
      cacheBytes: number;
      cacheEntries: number;
      images?: LaneLimits;
    } = {
      parallel: 4,
      perHost: 2,
      intervalMs: 300,
      queued: 64,
      cacheBytes: 32 * 1024 * 1024,
      cacheEntries: 64,
      images: { parallel: 8, perHost: 6, intervalMs: 0 },
    },
  ) {}

  request(input: HttpRequest, signal: AbortSignal): Promise<HttpResponse> {
    const pending = this.perform(input, signal);
    this.consumers.add(pending);
    void pending.finally(() => this.consumers.delete(pending)).catch(() => {});
    return pending;
  }
  private async perform(input: HttpRequest, signal: AbortSignal): Promise<HttpResponse> {
    signal.throwIfAborted();
    if (this.stopped) throw new Error("网络服务正在退出。");
    if (this.failedRemovals.size) {
      await this.retryCleanup();
      signal.throwIfAborted();
      if (this.stopped) throw new Error("网络服务正在退出。");
    }
    const url = new URL(input.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("网络请求地址无效。");
    if (
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 1 ||
      input.timeoutMs > 120000 ||
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < 1 ||
      input.maxBytes > 64 * 1024 * 1024
    )
      throw new Error("网络请求限制无效。");
    const request = {
      ...input,
      output: undefined,
      method: input.method ?? "GET",
      proxy: input.proxy ?? "",
      headers: { ...input.headers },
    };
    const headers = Object.entries(request.headers)
      .map(([name, value]) => [name.toLowerCase(), value])
      .sort(([a], [b]) => a!.localeCompare(b!));
    const shared =
      request.method === "GET" &&
      !request.body &&
      !headers.some(([name]) => ["authorization", "cookie", "range"].includes(name!)) &&
      (request.cacheTtlMs ?? 0) > 0;
    const key = shared
      ? JSON.stringify({ ...request, headers, purpose: undefined })
      : crypto.randomUUID();
    this.prune();
    let job = this.reusable.get(key);
    if (job?.abort.signal.aborted || (job?.state === "done" && job.expires <= Date.now()))
      job = undefined;
    if (!job) {
      if (this.queue.length >= this.limits.queued)
        throw new Error("网络请求队列已满，请稍后重试。");
      let resolve!: Job["resolve"], reject!: Job["reject"];
      const promise = new Promise<HttpResponse & { path: string }>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      // 订阅者取消后仍须等待原生停止；避免未观察的队列失败。
      void promise.catch(() => {});
      const lane = laneOf(request.purpose);
      job = {
        key,
        origin: `${url.origin}|${lane}`,
        lane,
        request,
        abort: new AbortController(),
        users: 0,
        state: "queued",
        deadline: Date.now() + request.timeoutMs,
        expires: 0,
        promise,
        resolve,
        reject,
      };
      this.jobs.add(job);
      if (shared) this.reusable.set(key, job);
      this.queue.push(job);
    }
    if (job.users >= 64) throw new Error("相同网络请求过多，请稍后重试。");
    this.jobs.delete(job);
    this.jobs.add(job);
    job.users++;
    const current = job;
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(signal.reason ?? new DOMException("请求已取消", "AbortError"));
      signal.addEventListener("abort", cancel, { once: true });
    });
    this.pump();
    try {
      const response = await Promise.race([current.promise, cancelled]);
      signal.throwIfAborted();
      if (!response.exitCode && input.output) await this.port.copy(response.path, input.output);
      signal.throwIfAborted();
      const { path: _path, ...value } = response;
      return { ...value, headers: { ...value.headers } };
    } finally {
      signal.removeEventListener("abort", cancel);
      current.users--;
      if (!current.users && current.state !== "done") {
        current.abort.abort();
        this.pump();
        await current.promise.catch((error: unknown) => {
          if (error instanceof StopUnconfirmedError) throw error;
        });
      }
      this.prune();
    }
  }
  private pump() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const now = Date.now();
    let wake = Infinity;
    for (let index = 0; index < this.queue.length;) {
      const job = this.queue[index]!;
      if (
        job.abort.signal.aborted ||
        now >= job.deadline ||
        this.stopped ||
        this.failedRemovals.size
      ) {
        this.queue.splice(index, 1);
        job.state = "done";
        job.reject(
          job.abort.signal.reason ??
            new Error(
              this.failedRemovals.size ? "网络缓存清理未完成，请稍后重试。" : "网络请求排队超时。",
            ),
        );
        this.evict(job);
        continue;
      }
      const host = this.hosts.get(job.origin) ?? { running: 0, next: 0 };
      this.hosts.set(job.origin, host);
      wake = Math.min(wake, job.deadline);
      const limits = job.lane === "image" ? (this.limits.images ?? this.limits) : this.limits;
      if (this.laneRunning[job.lane] >= limits.parallel || host.running >= limits.perHost) {
        index++;
        continue;
      }
      if (host.next > now) {
        wake = Math.min(wake, host.next);
        index++;
        continue;
      }
      this.queue.splice(index, 1);
      job.state = "running";
      this.running++;
      this.laneRunning[job.lane]++;
      host.running++;
      host.next = now + limits.intervalMs;
      const remaining = Math.max(1, job.deadline - now);
      void this.port
        .execute(
          {
            ...job.request,
            timeoutMs: remaining,
            connectTimeoutMs: Math.min(job.request.connectTimeoutMs ?? 5000, remaining),
          },
          job.abort.signal,
        )
        .then(
          (response) => {
            job.response = response;
            const cacheControl = response.headers["cache-control"] ?? "";
            const publicResponse =
              !response.exitCode &&
              response.status === 200 &&
              !response.setCookie &&
              !response.ambiguousHeaders &&
              response.headers["cf-mitigated"] !== "challenge" &&
              !/\b(?:no-store|no-cache|private)\b/i.test(cacheControl) &&
              !response.headers.vary?.split(",").some((value) => value.trim() === "*");
            let ttl = publicResponse ? Math.min(job.request.cacheTtlMs ?? 0, 300000) : 0;
            const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)/i.exec(cacheControl);
            if (maxAge)
              ttl = Math.min(
                ttl,
                Math.max(0, Number(maxAge[1]) - (Number(response.headers.age) || 0)) * 1000,
              );
            job.expires = ttl ? Date.now() + ttl : 0;
            if (response.status === 429 || response.status === 503) {
              const retry = response.headers["retry-after"];
              const delay =
                retry && /^\d+$/.test(retry)
                  ? Number(retry) * 1000
                  : retry
                    ? Date.parse(retry) - Date.now()
                    : 1000;
              host.next = Math.max(
                host.next,
                Date.now() + Math.min(60000, Math.max(1000, Number.isFinite(delay) ? delay : 1000)),
              );
            }
            job.state = "done";
            job.resolve(response);
          },
          (error: unknown) => {
            job.state = "done";
            job.reject(error);
          },
        )
        .finally(() => {
          job.state = "done";
          this.running--;
          this.laneRunning[job.lane]--;
          host.running--;
          this.prune();
          this.pump();
        });
    }
    for (const [origin, host] of this.hosts)
      if (!host.running && host.next <= now && !this.queue.some((job) => job.origin === origin))
        this.hosts.delete(origin);
    if (this.queue.length && Number.isFinite(wake))
      this.timer = setTimeout(() => this.pump(), Math.max(1, wake - now));
  }
  private evict(job: Job) {
    if (job.users || job.state !== "done") return;
    this.jobs.delete(job);
    if (this.reusable.get(job.key) === job) this.reusable.delete(job.key);
    if (job.response) {
      const path = job.response.path;
      job.response = undefined;
      const removal = this.port
        .remove(path)
        .catch(() => {
          this.failedRemovals.add(path);
        })
        .finally(() => this.removals.delete(removal));
      this.removals.add(removal);
    }
  }
  private prune() {
    let bytes = 0,
      count = 0;
    for (const job of [...this.jobs].reverse()) {
      if (job.state !== "done") continue;
      if (this.stopped || job.expires <= Date.now()) this.evict(job);
      else {
        count++;
        bytes += job.response?.bytes ?? 0;
        if (count > this.limits.cacheEntries || bytes > this.limits.cacheBytes) this.evict(job);
      }
    }
  }
  private retryCleanup() {
    return (this.recovering ??= (async () => {
      for (const path of this.failedRemovals) {
        try {
          await this.port.remove(path);
        } catch {
          throw new Error("网络缓存清理未完成，请稍后重试。");
        }
        this.failedRemovals.delete(path);
      }
    })().finally(() => {
      this.recovering = undefined;
    }));
  }
  async shutdown() {
    this.stopped = true;
    for (const job of this.jobs) job.abort.abort();
    this.pump();
    await Promise.allSettled([...this.jobs].map((job) => job.promise));
    await Promise.allSettled([...this.consumers]);
    this.prune();
    await Promise.all([...this.removals]);
    await this.retryCleanup();
    if (this.timer) clearTimeout(this.timer);
  }
}
