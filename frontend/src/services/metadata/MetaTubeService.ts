import { JsonHttpError, Observable, Settings, list, record, serviceError, text } from "./shared";
import type { JsonHttp, Store } from "./shared";
import type { EditableMetadata } from "../../contracts/metadata";
import { StopUnconfirmedError } from "../downloads/ports";

export interface MetaTubeSettings {
  providers: string[];
}
export const defaultMetaTubeSettings: MetaTubeSettings = {
  providers: [],
};
export function validateMetaTubeSettings(value: unknown): MetaTubeSettings {
  const input = record(value);
  // 旧配置中的外部地址、令牌、自启动与程序路径不再参与运行时决策。
  return {
    providers: list(input.providers, 100),
  };
}
export interface ManagedMetaTube {
  endpoint: string;
  token: string;
  exited: Promise<void>;
  isNetworkCurrent?(): Promise<boolean>;
  stop(): Promise<void>;
}
export interface MetaTubeHost {
  bundled(): Promise<{ path: string; version: string } | undefined>;
  start(path: string, signal: AbortSignal): Promise<ManagedMetaTube>;
}
export interface MovieCandidate {
  provider: string;
  id: string;
  code: string;
  title: string;
}
export interface MovieDetails {
  fields: Partial<EditableMetadata>;
  provider: string;
  id: string;
  homepage: string;
  label?: string;
  thumbUrl?: string;
  bigThumbUrl?: string;
  coverUrl?: string;
  bigCoverUrl?: string;
  previewVideoUrl?: string;
  previewVideoHlsUrl?: string;
  previewImages?: string[];
}
function webUrl(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32)
  )
    return undefined;
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password)
      return url.href;
  } catch {
    // 无效资源地址不影响文字资料的查看与采用。
  }
  return undefined;
}
export function movieDetails(value: unknown): MovieDetails {
  const data = record(value);
  const number = (value: unknown, max: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : 0;
  return {
    provider: text(data.provider ?? "", 100),
    id: text(data.id ?? "", 200),
    homepage: webUrl(data.homepage) ?? "",
    label: text(data.label ?? "", 200),
    thumbUrl: webUrl(data.thumb_url),
    bigThumbUrl: webUrl(data.big_thumb_url),
    coverUrl: webUrl(data.cover_url),
    bigCoverUrl: webUrl(data.big_cover_url),
    previewVideoUrl: webUrl(data.preview_video_url),
    previewVideoHlsUrl: webUrl(data.preview_video_hls_url),
    previewImages: Array.isArray(data.preview_images)
      ? [
          ...new Set(
            data.preview_images
              .slice(0, 100)
              .map(webUrl)
              .filter((url): url is string => !!url),
          ),
        ]
      : [],
    fields: {
      code: text(data.number ?? "", 80),
      title: text(data.title ?? "", 2048),
      plot: text(data.summary ?? "", 16000),
      director: text(data.director ?? "", 200),
      studio: text(data.maker ?? "", 200),
      label: text(data.label ?? "", 200),
      series: text(data.series ?? "", 200),
      actors: list(data.actors ?? []),
      genres: list(data.genres ?? []),
      premiered: text(data.release_date ?? "", 30).slice(0, 10),
      rating: number(data.score, 5),
      duration: number(data.runtime, 1440),
    },
  };
}
export class MetaTubeService extends Observable<{
  status: "stopped" | "starting" | "ready" | "failed";
  busy: boolean;
  progress: string;
  error: string;
  version: string;
  bundledPath: string;
  bundleChecked: boolean;
  providers: string[];
  querying: boolean;
}> {
  readonly settings: Settings<MetaTubeSettings>;
  private active?: { abort: AbortController; done: Promise<void> };
  private queryTask?: { abort: AbortController; done: Promise<unknown> };
  private backgroundTask?: { abort: AbortController; done: Promise<unknown> };
  private managed?: ManagedMetaTube;
  private stopping?: ManagedMetaTube;
  private connection?: { endpoint: string; token: string; providers: string[] };
  private initialized?: Promise<void>;
  private stopped = false;
  constructor(
    store: Store<MetaTubeSettings>,
    private http: JsonHttp,
    readonly host: MetaTubeHost,
    available: boolean,
    private prepare: () => Promise<void> = async () => {},
  ) {
    super({
      status: "stopped",
      busy: false,
      progress: "",
      error: "",
      version: "",
      bundledPath: "",
      bundleChecked: false,
      providers: [],
      querying: false,
    });
    this.settings = new Settings(
      store,
      defaultMetaTubeSettings,
      validateMetaTubeSettings,
      available,
    );
  }
  initialize() {
    return (this.initialized ??= (async () => {
      await this.settings.initialize();
      if (!this.settings.getSnapshot().available) return;
      await this.refreshBundle();
    })().catch((error) => {
      this.publish({ bundleChecked: true, error: serviceError(error) });
    }));
  }
  private async refreshBundle() {
    const bundled = await this.host.bundled();
    this.publish({
      version: bundled?.version ?? "",
      bundledPath: bundled?.path ?? "",
      bundleChecked: true,
    });
    return bundled;
  }
  private ensureStarted() {
    if (this.stopped) throw new Error("应用正在退出。");
    if (this.active) return this.active.done;
    const abort = new AbortController();
    const done = Promise.resolve()
      .then(async () => {
        const managed = this.managed;
        if (this.connection && this.snapshot.status === "ready" && managed) {
          const current = await managed.isNetworkCurrent?.();
          abort.signal.throwIfAborted();
          if (
            current !== false &&
            this.managed === managed &&
            this.connection &&
            this.snapshot.status === "ready"
          )
            return;
        }
        // 常驻进程只在启动时读取代理；保存配置后，下次查询先回收旧进程再启动。
        this.publish({ busy: true, progress: "正在启动内置服务", status: "starting", error: "" });
        await this.start(abort.signal);
      })
      .catch((error: unknown) => {
        this.publish({ status: "failed", error: serviceError(error) });
        throw error;
      })
      .finally(() => {
        this.active = undefined;
        this.publish({ busy: false, progress: "" });
      });
    this.active = { abort, done };
    return done;
  }
  async save(settings: MetaTubeSettings) {
    if (this.stopped) throw new Error("应用正在退出。");
    if (this.active || this.queryTask || this.backgroundTask)
      throw new Error("MetaTube 正忙，请等待当前操作完成后再保存。");
    await this.settings.save(settings);
    if (this.connection)
      this.connection = {
        ...this.connection,
        providers: this.settings.getSnapshot().value.providers,
      };
  }
  private async health(connection: { endpoint: string; token: string }, signal: AbortSignal) {
    const headers: Record<string, string> = connection.token
      ? { Authorization: `Bearer ${connection.token}` }
      : {};
    // 只检查公共 providers 不足以验证 token；同时访问受保护的数据库版本接口。
    const auth = record(
      await this.http({ url: `${connection.endpoint}/v1/db/version`, headers, timeout: 3 }, signal),
    );
    if (auth.data === undefined || auth.error) throw new Error("MetaTube 鉴权检查失败。");
    const response = record(
      await this.http({ url: `${connection.endpoint}/v1/providers`, headers, timeout: 3 }, signal),
    );
    const data = record(response.data),
      providers = record(data.movie_providers);
    return Object.keys(providers).slice(0, 200);
  }
  private async start(signal: AbortSignal) {
    try {
      signal.throwIfAborted();
      await this.prepare();
      signal.throwIfAborted();
      await this.initialize();
      const settings = await this.settings.require();
      signal.throwIfAborted();
      if (this.managed) await this.disconnect();
      this.publish({ status: "starting" });
      const bundled = await this.refreshBundle();
      signal.throwIfAborted();
      if (!bundled) throw new Error("内置 MetaTube 组件缺失，请完整解压或重新获取 JAVM 运行包。");
      const managed = await this.host.start(bundled.path, signal);
      this.managed = managed;
      void managed.exited.then(
        () => {
          if (this.managed !== managed || this.stopping === managed) return;
          this.managed = undefined;
          this.connection = undefined;
          this.publish({ status: "failed", error: "MetaTube 已退出，下次查询时将重新启动。" });
        },
        () => {
          if (this.managed === managed && this.stopping !== managed) {
            this.connection = undefined;
            this.publish({ status: "failed", error: "MetaTube 进程异常，请重试查询。" });
          }
        },
      );
      const deadline = Date.now() + 15000;
      let providers: string[];
      while (true) {
        signal.throwIfAborted();
        try {
          providers = await this.health(managed, signal);
          break;
        } catch (error) {
          if (signal.aborted || Date.now() >= deadline || this.snapshot.status === "failed")
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
      signal.throwIfAborted();
      if (this.snapshot.status === "failed") throw new Error("MetaTube 启动后已退出。");
      this.connection = {
        endpoint: managed.endpoint,
        token: managed.token,
        providers: settings.providers,
      };
      this.publish({ status: "ready", providers, error: "" });
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }
  private async disconnect() {
    this.connection = undefined;
    const managed = this.managed;
    if (managed) {
      this.stopping = managed;
      try {
        await managed.stop();
        if (this.managed === managed) this.managed = undefined;
      } finally {
        if (this.stopping === managed) this.stopping = undefined;
      }
    }
    this.publish({ status: "stopped", providers: [], error: "" });
  }
  private async ready(signal: AbortSignal) {
    signal.throwIfAborted();
    const startup = this.ensureStarted();
    // 查询可以立即取消；共用服务的启动和运行期只由应用级生命周期管理。
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void startup.then(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
    signal.throwIfAborted();
    if (!this.connection || this.snapshot.status !== "ready")
      throw new Error("MetaTube 已退出，请重试查询。");
    return this.connection;
  }
  private async query<T>(
    operation: (
      connection: NonNullable<MetaTubeService["connection"]>,
      signal: AbortSignal,
    ) => Promise<T>,
    externalSignal?: AbortSignal,
  ) {
    if (this.stopped) throw new Error("应用正在退出。");
    const lane = externalSignal ? "backgroundTask" : "queryTask";
    if (this[lane] || this.settings.getSnapshot().saving)
      throw new Error("MetaTube 正忙，请等待或取消当前操作。");
    const abort = new AbortController();
    const cancel = () => abort.abort();
    externalSignal?.throwIfAborted();
    externalSignal?.addEventListener("abort", cancel, { once: true });
    const done = Promise.resolve().then(async () => {
      // 其他查询使用期间不因代理变化重启共用进程；空闲后的下一次查询再更新。
      const other = externalSignal ? this.queryTask : this.backgroundTask;
      const connection =
        other && this.connection ? this.connection : await this.ready(abort.signal);
      abort.signal.throwIfAborted();
      return operation(connection, abort.signal);
    });
    this[lane] = { abort, done };
    if (!externalSignal) this.publish({ querying: true, error: "" });
    try {
      const value = await done;
      abort.signal.throwIfAborted();
      return value;
    } catch (error) {
      if (!externalSignal) this.publish({ error: serviceError(error) });
      throw error;
    } finally {
      externalSignal?.removeEventListener("abort", cancel);
      this[lane] = undefined;
      if (!externalSignal) this.publish({ querying: false });
    }
  }
  private async get(
    path: string,
    connection: NonNullable<MetaTubeService["connection"]>,
    signal: AbortSignal,
  ) {
    try {
      const response = record(
        await this.http(
          {
            url: `${connection.endpoint}/v1/${path}`,
            headers: connection.token ? { Authorization: `Bearer ${connection.token}` } : {},
            timeout: 45,
          },
          signal,
        ),
      );
      if (response.error) throw new Error("MetaTube 来源请求失败，请重试或切换来源。");
      return response.data;
    } catch (error) {
      if (error instanceof JsonHttpError && error.status === 404)
        throw new Error(
          "MetaTube 未找到资料或资料来源无法访问，请检查番号、资料来源及网络代理后重试。",
        );
      throw error;
    }
  }
  async search(query: string, signal?: AbortSignal) {
    const q = text(query, 200);
    if (!q) throw new Error("请输入番号或片名。");
    return this.query(async (connection, signal) => {
      const data: unknown[] = [];
      let failed = false;
      // v1.4.0 的 provider 只接受单个名称；按用户配置顺序查询，限制放大请求。
      const providers = connection.providers.length ? connection.providers : [""];
      for (const provider of providers) {
        signal.throwIfAborted();
        const params = new URLSearchParams({ q, fallback: "true" });
        if (provider) params.set("provider", provider);
        try {
          const result = await this.get(`movies/search?${params}`, connection, signal);
          if (!Array.isArray(result) || result.length > 500)
            throw new Error("MetaTube 搜索结果格式无效。");
          data.push(...result.slice(0, 500 - data.length));
        } catch (error) {
          if (error instanceof StopUnconfirmedError) throw error;
          signal.throwIfAborted();
          if (providers.length === 1) throw error;
          failed = true;
        }
        if (data.length >= 500) break;
      }
      if (!data.length && failed)
        throw new Error("资料来源未返回结果或无法访问，请检查来源与网络后重试。");
      return data.map((item) => {
        const row = record(item);
        return {
          provider: text(row.provider, 100),
          id: text(row.id, 200),
          code: text(row.number ?? "", 80),
          title: text(row.title ?? "", 2048),
        };
      });
    }, signal);
  }
  details(candidate: MovieCandidate, signal?: AbortSignal) {
    return this.query(
      async (connection, signal) =>
        movieDetails(
          await this.get(
            `movies/${encodeURIComponent(candidate.provider)}/${encodeURIComponent(candidate.id)}`,
            connection,
            signal,
          ),
        ),
      signal,
    );
  }
  cancel = () => {
    this.queryTask?.abort.abort();
  };
  async shutdown() {
    this.stopped = true;
    this.cancel();
    this.backgroundTask?.abort.abort();
    this.active?.abort.abort();
    await Promise.all([
      this.active?.done.catch(() => {}),
      this.queryTask?.done.catch(() => {}),
      this.backgroundTask?.done.catch(() => {}),
    ]);
    await this.disconnect();
  }
}
