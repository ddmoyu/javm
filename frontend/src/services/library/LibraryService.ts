import type {
  DirectoryInput,
  LibraryStatus,
  MediaDirectory,
  NativeVideo,
  LibraryQuery,
  FacetQuery,
  FacetValue,
  LibrarySummary,
  QueryPage,
} from "../../contracts/library";
import type { Film } from "../../contracts/media";
import { LIBRARY_CACHE_PAGES, PagedQuery } from "./PagedQuery";
import type { LibraryMaintenanceService } from "./LibraryMaintenanceService";
import type { EditableMetadata } from "../../contracts/metadata";
import type { DiscoveryCatalogService } from "../catalog/DiscoveryCatalogService";
import { isCatalogDimension } from "../catalog/discoveryData";
import type { CatalogDimension } from "../catalog/discoveryData";
import type { ResourceRecord, SavedResource } from "../streamResolution/archive";
import type { DirectoryWatchService } from "./DirectoryWatchService";
import type { LibraryDocumentsService } from "./LibraryDocumentsService";
import type { ArtworkService } from "./ArtworkService";
import { artworkSources } from "./ArtworkService";
import type { FileOrganizationService } from "./FileOrganizationService";
import type { MovieDetails } from "../metadata/MetaTubeService";
import { movieTrailers } from "../metadata/movieTrailers";
import type { ScrapeTarget } from "../scraping/ScrapeService";
import { publicMessage } from "../publicMessage";
import { normalizeCode } from "../scraping/identity";

export interface LibraryPort {
  request<T>(method: string, params?: unknown): Promise<T>;
  mount(
    directories: Pick<MediaDirectory, "id" | "path">[],
    metadataDirectory?: string,
  ): Promise<(path: string) => string | undefined>;
}
export interface LibrarySnapshot extends LibraryStatus {
  available: boolean;
  ready: boolean;
  error: string;
  total: number;
  favorites: number;
  selectedFilm: Film | null;
}
export function libraryError(error: unknown) {
  return error instanceof Error ? publicMessage(error.message) : "媒体库操作失败，请重试。";
}
function nativeMetadata(value: Partial<EditableMetadata>) {
  if (value.rating === undefined) return value;
  if (!Number.isFinite(value.rating) || value.rating < 0 || value.rating > 5)
    throw new Error("评分必须在 0～5 之间，0 表示未评分。");
  // SQLite 与 NFO 仍按 10 分制保存；在边界换算，保留已有数据和并发校验的精度。
  return { ...value, rating: value.rating * 2 };
}
export function toFilm(video: NativeVideo, asset: (path: string) => string | undefined): Film {
  const fileName = (video.video_path ?? "").split(/[\\/]/).at(-1) ?? "";
  const fileSize = video.file_size ?? 0;
  const sizePower = fileSize >= 1024 ** 3 ? 3 : fileSize >= 1024 ** 2 ? 2 : 1;
  const size = fileSize
    ? `${(fileSize / 1024 ** sizePower).toFixed(3)} ${["KB", "MB", "GB"][sizePower - 1]}`
    : "";
  const legacyResolution = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(video.resolution ?? "");
  const shortSide = Math.min(
    video.width || Number(legacyResolution?.[1]) || 0,
    video.height || Number(legacyResolution?.[2]) || 0,
  );
  const artwork = [
    ...new Set([video.poster, video.thumb, video.fanart].filter((path): path is string => !!path)),
  ];
  return {
    id: video.id,
    code: video.local_id ?? "",
    title: video.title || fileName,
    english: video.original_title ?? "",
    year: Number.parseInt(video.premiered?.slice(0, 4) ?? "", 10) || video.year || 0,
    duration: video.duration ? Math.max(1, Math.round(video.duration / 60)) : 0,
    durationSeconds: video.duration ?? 0,
    rating:
      video.rating != null &&
      Number.isFinite(video.rating) &&
      video.rating > 0 &&
      video.rating <= 10
        ? video.rating / 2
        : undefined,
    genre: video.genres[0] ?? "",
    quality:
      shortSide >= 2160
        ? "4K"
        : shortSide
          ? `${shortSide}p`
          : video.media_files?.some((file) => file.stream_url)
            ? "STRM"
            : "",
    size,
    favorite: !!video.favorite,
    missing: (video.scan_status ?? 0) < 2,
    fileMissing: video.availability === "unavailable",
    availability: video.availability,
    createdAt: video.created_at,
    actor: video.actors[0],
    coverUrl: artwork.length ? asset(artwork[0]!) : undefined,
    trailers: movieTrailers(video.preview ?? {}),
    artwork: artwork.flatMap((path) => {
      const src = asset(path);
      return src ? [{ src, path }] : [];
    }),
    screenshots: video.screenshots?.length
      ? video.screenshots.flatMap((shot) => {
          const src = asset(shot.path);
          return src
            ? [
                {
                  src,
                  path: shot.path,
                  id: shot.id,
                  timestamp:
                    shot.seconds > 0
                      ? `${Math.floor(shot.seconds / 60)}:${String(Math.floor(shot.seconds % 60)).padStart(2, "0")}`
                      : undefined,
                },
              ]
            : [];
        })
      : (video.preview?.previewImages ?? []).map((src, index) => ({
          src,
          title: `预览图 ${index + 1}`,
        })),
    metadata: {
      homepage: video.preview?.homepage,
      plot: video.plot ?? "",
      originalTitle: video.original_title ?? "",
      premiered: video.premiered ?? "",
      actors: video.actors,
      director: video.director ?? "",
      studio: video.studio ?? "",
      label: video.label ?? "",
      series: video.series,
      genres: video.genres,
      tags: video.tags ?? [],
      resolution: video.resolution ?? "",
      directory: video.dir_path,
      fileName,
      source: video.metadata_edited
        ? "手动确认"
        : video.nfo_files?.length
          ? "本地 NFO"
          : video.video_path
            ? "本地视频"
            : "待保存资料",
    },
    files: [
      ...(video.media_files ?? []).map((file) => ({
        id: file.id,
        streamUrl: file.stream_url ?? undefined,
        part: file.part,
        parts: file.parts,
        name: file.path.split(/[\\/]/).at(-1) ?? "视频",
        path: file.path,
        kind: "video" as const,
        missing: !!file.missing,
        size: file.stream_url
          ? "STRM 网络资源"
          : file.file_size
            ? `${(file.file_size / 1024 ** 2).toFixed(1)} MB`
            : "",
      })),
      ...(video.nfo_files ?? []).map((file) => ({
        name: file.path.split(/[\\/]/).at(-1) ?? "NFO",
        path: file.path,
        kind: "metadata" as const,
      })),
      ...artwork.map((path) => ({
        name: path.split(/[\\/]/).at(-1) ?? "图片",
        path,
        kind: "image" as const,
      })),
    ],
  };
}

export class LibraryRequestTimeoutError extends Error {}

export class LibraryService {
  backups?: import("./LibraryBackupService").LibraryBackupService;
  maintenance?: LibraryMaintenanceService;
  watcher?: DirectoryWatchService;
  documents?: LibraryDocumentsService;
  artwork?: ArtworkService;
  /** 扫描后为没有封面的作品自动截帧。 */
  autoCover?: import("./AutoCoverService").AutoCoverService;
  organization?: FileOrganizationService;
  private snapshot: LibrarySnapshot;
  private listeners = new Set<() => void>();
  private refreshing?: Promise<void>;
  private initialized?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private collecting?: Promise<Film>;
  private loadedRevision = -1;
  private favoritePending = new Set<Film["id"]>();
  private catalogViews = new WeakSet<object>();
  private unsubscribeCatalog?: () => void;
  private catalogSync = new Map<
    CatalogDimension,
    { revision: number; names: string[]; videoCounts?: Record<string, number>; work: Promise<void> }
  >();
  private views = new Set<{
    invalidate(): void;
    setActive(active: boolean): void;
    isActive(): boolean;
  }>();
  private asset: (path: string) => string | undefined = () => undefined;
  constructor(
    private port?: LibraryPort,
    readonly catalog?: DiscoveryCatalogService,
  ) {
    this.snapshot = {
      available: !!port,
      ready: !port,
      error: "",
      total: 0,
      favorites: 0,
      selectedFilm: null,
      directories: [],
      scan: null,
      revision: 0,
      databasePath: "",
    };
    if (catalog) {
      let revision = catalog.getSnapshot().revision;
      this.unsubscribeCatalog = catalog.subscribe(() => {
        const current = catalog.getSnapshot().revision;
        if (current === revision) return;
        revision = current;
        for (const view of this.views) if (this.catalogViews.has(view)) view.invalidate();
      });
    }
  }
  getSnapshot = () => this.snapshot;
  hasPendingWrites() {
    return !!this.collecting || this.favoritePending.size > 0;
  }
  async refreshAfterRestore() {
    this.catalogSync.clear();
    this.publish({ selectedFilm: null });
    await this.organization?.initialize();
    await this.refreshAfterImport();
  }
  attach(view: { invalidate(): void; setActive(active: boolean): void; isActive(): boolean }) {
    this.views.add(view);
    return () => {
      this.views.delete(view);
      view.setActive(false);
    };
  }
  createFilmQuery() {
    return new PagedQuery<Film, LibraryQuery>(async (query, page) => {
      if (!this.port) return { items: [], total: 0, offset: page.offset };
      await this.initialize();
      const result = await this.port.request<QueryPage<NativeVideo>>("library.query", {
        ...query,
        ...page,
      });
      return { ...result, items: result.items.map((video) => toFilm(video, this.asset)) };
    });
  }
  // 读取某条目下本地已收录作品的番号（规范化后），用于标记在线作品“本地/缺失”。
  // 分页读取并限制总量；每页之间让出事件循环。
  async facetCodes(
    facet: NonNullable<LibraryQuery["facet"]>,
    signal: AbortSignal,
    limit = 5000,
  ): Promise<Set<string>> {
    const codes = new Set<string>();
    if (!this.port) return codes;
    await this.initialize();
    for (let offset = 0; offset < limit; offset += 200) {
      signal.throwIfAborted();
      const page = await this.port.request<QueryPage<NativeVideo>>("library.query", {
        facet,
        offset,
        limit: 200,
        includeTotal: false,
      });
      signal.throwIfAborted();
      for (const video of page.items)
        if (video.local_id && video.availability !== "metadata_only")
          codes.add(normalizeCode(video.local_id));
      if (page.items.length < 200) break;
    }
    return codes;
  }
  createFacetQuery(includeCatalog = false) {
    const view = new PagedQuery<FacetValue, FacetQuery>(async (query, page) => {
      if (includeCatalog && isCatalogDimension(query.dimension) && this.catalog) {
        await this.catalog.ready();
        if (!this.port || !this.snapshot.ready || this.snapshot.error) {
          if (query.favoritesOnly) throw new Error("无法读取收藏，请恢复媒体库连接后重试。");
          return this.catalog.query(query, page);
        }
        await this.syncCatalog(query.dimension);
        return this.port.request<QueryPage<FacetValue>>("library.facets", {
          ...query,
          ...page,
          includeCatalog: true,
          includeFavorites: true,
          includeLabels: true,
          includeVideoCounts: true,
        });
      }
      if (!this.port) return { items: [], total: 0, available: 0, offset: page.offset };
      await this.initialize();
      return this.port.request<QueryPage<FacetValue>>("library.facets", {
        ...query,
        ...page,
        includeFavorites: true,
        includeLabels: true,
      });
    }, LIBRARY_CACHE_PAGES);
    if (includeCatalog) this.catalogViews.add(view);
    return view;
  }
  private async syncCatalog(dimension: CatalogDimension) {
    await this.catalog!.ensureNativeSeed();
    const current = this.catalog!.getSnapshot();
    const previous = this.catalogSync.get(dimension);
    if (previous?.revision === current.revision) return previous.work;
    const list = this.catalog!.nativeSeed
      ? current.nativeOverrides?.[dimension]
      : current.catalogs[dimension];
    if (!list) throw new Error("内置目录尚未就绪，请重试。");
    const { names, videoCounts } = list;
    const positions = this.catalog!.nativeSeed
      ? current.nativeOverrides![dimension].positions
      : undefined;
    if (previous && previous.names === names && previous.videoCounts === videoCounts) {
      previous.revision = current.revision;
      return previous.work;
    }
    const work = (async () => {
      await previous?.work.catch(() => {});
      // 内置 SQLite 直接查询；仅增量记录进入临时覆盖表，空批次用于清理旧覆盖。
      for (let offset = 0; offset < Math.max(1, names.length); offset += 500) {
        if (this.stopped) return;
        await this.port!.request("library.catalogAppend", {
          dimension,
          offset,
          reset: offset === 0,
          names: names.slice(offset, offset + 500),
          ...(positions ? { positions: positions.slice(offset, offset + 500) } : {}),
          videoCounts: names
            .slice(offset, offset + 500)
            .map((name) =>
              videoCounts && Object.hasOwn(videoCounts, name) ? videoCounts[name] : null,
            ),
        });
      }
    })();
    const entry = { revision: current.revision, names, videoCounts, work };
    this.catalogSync.set(dimension, entry);
    try {
      await work;
    } catch (error) {
      if (this.catalogSync.get(dimension) === entry) this.catalogSync.delete(dimension);
      throw error;
    }
  }
  createDuplicateQuery() {
    return new PagedQuery<boolean, { code: string; except: string }>(async (query, page) => ({
      offset: page.offset,
      total: 1,
      items: [
        this.port && query.code
          ? await this.port.request<boolean>("library.duplicateCode", query)
          : false,
      ],
    }));
  }
  selectFilm(film: Film | null) {
    this.publish({ selectedFilm: film });
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(change: Partial<LibrarySnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
  initialize() {
    return (this.initialized ??= this.refresh());
  }
  refresh() {
    if (!this.port || this.stopped) return Promise.resolve();
    return (this.refreshing ??= this.load().finally(() => {
      this.refreshing = undefined;
    }));
  }
  private async load() {
    if (this.timer) clearTimeout(this.timer);
    try {
      const status = await this.port!.request<LibraryStatus>("library.status");
      if (status.recoveryError) {
        this.publish({
          ready: true,
          databasePath: status.databasePath,
          error: status.recoveryError,
        });
        return;
      }
      const change: Partial<LibrarySnapshot> = { ...status, ready: true, error: "" };
      const changed = this.loadedRevision !== status.revision;
      if (changed) {
        this.asset = await this.port!.mount(
          status.assetRoots ?? status.directories,
          status.metadataDirectory,
        );
        Object.assign(change, await this.port!.request<LibrarySummary>("library.summary"));
        const selected = this.snapshot.selectedFilm;
        if (selected) {
          const video = await this.port!.request<NativeVideo | null>("library.video", {
            id: selected.id,
          });
          if (this.snapshot.selectedFilm?.id === selected.id)
            change.selectedFilm = video ? toFilm(video, this.asset) : null;
        }
        this.loadedRevision = status.revision;
      }
      if (this.stopped) return;
      this.publish(change);
      if (changed) for (const view of this.views) view.invalidate();
      if (status.scan?.state === "scanning" && !this.stopped)
        this.timer = setTimeout(() => {
          void this.refresh();
        }, 500);
    } catch (error) {
      this.publish({ ready: true, error: libraryError(error) });
      // 已受理的扫描不因单次轮询失败丢失进度，降低频率重连。
      if (this.snapshot.scan?.state === "scanning" && !this.stopped)
        this.timer = setTimeout(() => {
          void this.refresh();
        }, 2000);
    }
  }
  private requirePort() {
    if (!this.port) throw new Error("请在桌面应用中管理本机媒体目录。");
    return this.port;
  }
  private async refreshAfterMutation() {
    // 等待旧查询结束后再取新状态，避免 add/scan 与 idle 快照竞态导致漏掉轮询。
    await this.refreshing;
    await this.refresh();
  }
  refreshAfterImport() {
    return this.refreshAfterMutation();
  }
  async add(input: DirectoryInput) {
    try {
      await this.requirePort().request("library.add", input);
    } finally {
      // 请求响应丢失时，后台可能已经开始扫描，仍需恢复真实状态和进度轮询。
      await this.refreshAfterMutation();
    }
  }
  async scan(id: string) {
    try {
      await this.requirePort().request("library.scan", { id });
    } finally {
      await this.refreshAfterMutation();
    }
  }
  async cancel() {
    await this.requirePort().request("library.cancel");
    await this.refreshAfterMutation();
  }
  async removeDirectory(id: string) {
    try {
      return await this.requirePort().request<{ removedVideos: number }>(
        "library.removeDirectory",
        {
          id,
        },
      );
    } finally {
      await this.refreshAfterMutation();
    }
  }
  async attachVideo(id: Film["id"], path: string) {
    await this.requirePort().request("library.scrape.prepare", {
      jobId: crypto.randomUUID(),
      workId: id,
      path,
    });
    await this.refreshAfterMutation();
  }
  async removeWork(id: Film["id"]) {
    await this.requirePort().request("library.work.remove", { id });
    await this.refreshAfterMutation();
  }
  async toggleFavorite(film: Film) {
    const id = film.id;
    if (this.favoritePending.has(id)) return;
    this.favoritePending.add(id);
    try {
      await this.requirePort().request("library.favorite", { id, value: !film.favorite });
      if (this.snapshot.selectedFilm?.id === id)
        this.publish({ selectedFilm: { ...this.snapshot.selectedFilm, favorite: !film.favorite } });
      await this.refreshAfterMutation();
    } finally {
      this.favoritePending.delete(id);
    }
  }
  async setFacetFavorite(dimension: FacetQuery["dimension"], name: string, value: boolean) {
    const key = `facet:${dimension}:${name}`;
    if (this.favoritePending.has(key)) return;
    if (this.stopped || this.favoritePending.size >= 32)
      throw new Error("请等待当前收藏保存完成。");
    this.favoritePending.add(key);
    try {
      await this.initialize();
      await this.requirePort().request("library.facetFavorite", { dimension, name, value });
      for (const view of this.views) view.invalidate();
    } finally {
      this.favoritePending.delete(key);
    }
  }
  async readResources(code: string, workId?: string) {
    await this.initialize();
    return this.requirePort().request<SavedResource[]>("library.resources.read", { code, workId });
  }
  async relatedMedia<T>(operation: "save", params: unknown): Promise<T> {
    const result = await this.requirePort().request<T>(`library.related.${operation}`, params);
    if (operation === "save") await this.refreshAfterMutation();
    return result;
  }
  async openWork(id: string) {
    const video = await this.requirePort().request<NativeVideo | null>("library.video", { id });
    if (!video) throw new Error("链接对应的作品已不存在。");
    this.selectFilm(toFilm(video, this.asset));
  }
  collectMetadata(
    details: MovieDetails,
    onArtworkWarning?: (warning: string) => void,
  ): Promise<Film> {
    if (this.stopped || this.collecting)
      return Promise.reject(new Error("请等待当前资料保存完成。"));
    if (!details.fields.code || !details.fields.title)
      return Promise.reject(new Error("来源没有完整的番号和标题。"));
    const operation = async () => {
      // 目录站与 MetaTube 可能使用相同 provider/id，禁止把刮削结果混入发现页缓存。
      if (details.origin !== "metatube") this.catalog?.movieDetails.remember(details);
      await this.initialize();
      const port = this.requirePort();
      const jobId = crypto.randomUUID();
      let target: ScrapeTarget;
      try {
        // 复用现有身份去重、只补空字段、NFO 安全写入及本地视频关联逻辑。
        target = await port.request<ScrapeTarget>("library.scrape.prepare", {
          jobId,
          collect: true,
          candidate: {
            provider: details.provider,
            id: details.id,
            code: details.fields.code,
            title: details.fields.title,
          },
        });
        await port.request("library.scrape.commit", {
          jobId,
          id: target.id,
          path: target.path,
          fileStamp: target.fileStamp,
          nfoStamp: target.nfoStamp ?? "",
          details,
          image: "",
        });
        const sources = artworkSources(details);
        if (sources.cover.length || sources.screenshots.length) {
          const existing = await port.request<NativeVideo | null>("library.video", {
            id: target.id,
          });
          if (!existing) throw new Error("已保存的作品暂时无法读取，请刷新片库。");
          // 自动截帧的封面不算正式封面，刮削到来源封面时替换它。
          const cover =
            (!existing.poster || existing.poster_auto === true) &&
            !existing.thumb &&
            !existing.fanart &&
            sources.cover.length > 0;
          const screenshots = !existing.screenshots?.length && sources.screenshots.length > 0;
          if (cover || screenshots) {
            let warning = "";
            if (!this.artwork) warning = "图片服务暂不可用。";
            else {
              try {
                // 直接采用已经校验的来源详情，不再通过 MetaTube 重查。
                await this.artwork.fetch(target.id, cover, screenshots, details);
                warning = this.artwork.getSnapshot().warning;
              } catch (error) {
                const state = this.artwork.getSnapshot();
                warning = state.busy ? libraryError(error) : state.error || libraryError(error);
              }
            }
            if (warning)
              onArtworkWarning?.(`资料已收藏，${warning}可在详情中使用“获取封面与截图”重试。`);
          }
        }
      } finally {
        await this.refreshAfterMutation();
      }
      // 图片提交和挂载刷新完成后，再返回包含本地封面与预览图的作品。
      const video = await port.request<NativeVideo | null>("library.video", { id: target.id });
      if (!video) throw new Error("已保存的作品暂时无法读取，请刷新片库。");
      return toFilm(video, this.asset);
    };
    this.collecting = operation().finally(() => {
      this.collecting = undefined;
    });
    return this.collecting;
  }
  async manageAliases<T>(
    operation: "list" | "save" | "remove" | "restore",
    params: Record<string, unknown> = {},
  ) {
    await this.initialize();
    const result = await this.requirePort().request<T>(`library.aliases.${operation}`, params);
    if (operation !== "list") await this.refreshAfterMutation();
    return result;
  }
  cancelAliasRestore() {
    return this.requirePort().request("library.cancel");
  }
  async saveResource(record: ResourceRecord) {
    await this.initialize();
    await this.requirePort().request("library.resources.save", record);
  }
  async removeResource(id: string) {
    await this.requirePort().request("library.resources.remove", { id });
  }
  async updateMetadata(
    id: Film["id"],
    patch: Partial<EditableMetadata>,
    expected: EditableMetadata,
  ) {
    await this.requirePort().request("library.updateMetadata", {
      id,
      patch: nativeMetadata(patch),
      expected: nativeMetadata(expected),
    });
    await this.refreshAfterMutation();
  }
  async shutdown() {
    await this.backups?.shutdown();
    // 先关闭图片服务，正在保存文字的收藏也不能在退出期间启动新图片请求。
    await this.autoCover?.shutdown();
    await this.artwork?.shutdown();
    await this.collecting?.catch(() => {});
    await this.watcher?.shutdown();
    await this.organization?.shutdown();
    await this.documents?.shutdown();
    await this.maintenance?.shutdown();
    this.stopped = true;
    const activeViews = [...this.views].filter((view) => view.isActive());
    for (const view of this.views) view.setActive(false);
    if (this.timer) clearTimeout(this.timer);
    // 从未连接成功时，退出不再等待一个不可用的扩展。
    try {
      if (this.port && this.snapshot.ready && this.snapshot.databasePath)
        await this.port.request("library.shutdown");
      this.unsubscribeCatalog?.();
    } catch (error) {
      this.stopped = false;
      for (const view of activeViews) if (this.views.has(view)) view.setActive(true);
      void this.refreshAfterMutation();
      throw error;
    }
  }
}
