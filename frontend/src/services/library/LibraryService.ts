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
import { PagedQuery } from "./PagedQuery";
import type { LibraryMaintenanceService } from "./LibraryMaintenanceService";
import type { EditableMetadata } from "../../contracts/metadata";
import type { DiscoveryCatalogService } from "../catalog/DiscoveryCatalogService";
import { isCatalogDimension } from "../catalog/discoveryData";
import type { CatalogDimension } from "../catalog/discoveryData";

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
  return error instanceof Error ? error.message : "媒体库操作失败，请重试。";
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
    quality: shortSide >= 2160 ? "4K" : shortSide ? `${shortSide}p` : "",
    size,
    favorite: !!video.favorite,
    missing: (video.scan_status ?? 0) < 2,
    fileMissing: video.availability === "unavailable",
    availability: video.availability,
    createdAt: video.created_at,
    actor: video.actors[0],
    coverUrl: artwork.length ? asset(artwork[0]!) : undefined,
    metadata: {
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
        name: file.path.split(/[\\/]/).at(-1) ?? "视频",
        path: file.path,
        kind: "video" as const,
        missing: !!file.missing,
        size: file.file_size ? `${(file.file_size / 1024 ** 2).toFixed(1)} MB` : "",
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

export class LibraryService {
  maintenance?: LibraryMaintenanceService;
  private snapshot: LibrarySnapshot;
  private listeners = new Set<() => void>();
  private refreshing?: Promise<void>;
  private initialized?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private loadedRevision = -1;
  private favoritePending = new Set<Film["id"]>();
  private catalogViews = new WeakSet<object>();
  private unsubscribeCatalog?: () => void;
  private catalogSync = new Map<
    CatalogDimension,
    { revision: number; names: string[]; work: Promise<void> }
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
  createFacetQuery(includeCatalog = false) {
    const view = new PagedQuery<FacetValue, FacetQuery>(async (query, page) => {
      if (includeCatalog && isCatalogDimension(query.dimension) && this.catalog) {
        await this.catalog.ready();
        if (!this.port || !this.snapshot.ready || this.snapshot.error)
          return this.catalog.query(query, page);
        await this.syncCatalog(query.dimension);
        return this.port.request<QueryPage<FacetValue>>("library.facets", {
          ...query,
          ...page,
          includeCatalog: true,
        });
      }
      if (!this.port) return { items: [], total: 0, available: 0, offset: page.offset };
      await this.initialize();
      return this.port.request<QueryPage<FacetValue>>("library.facets", { ...query, ...page });
    });
    if (includeCatalog) this.catalogViews.add(view);
    return view;
  }
  private async syncCatalog(dimension: CatalogDimension) {
    const current = this.catalog!.getSnapshot();
    const previous = this.catalogSync.get(dimension);
    if (previous?.revision === current.revision) return previous.work;
    const names = current.catalogs[dimension].names;
    if (
      previous &&
      previous.names.length === names.length &&
      previous.names.every((name, index) => name === names[index])
    ) {
      previous.revision = current.revision;
      return previous.work;
    }
    const work = (async () => {
      await previous?.work.catch(() => {});
      // 官方 Extension 分批导入临时表；翻页只传筛选条件，不重复搬运完整演员名单。
      for (let offset = 0; offset < names.length; offset += 500) {
        if (this.stopped) return;
        await this.port!.request("library.catalogAppend", {
          dimension,
          names: names.slice(offset, offset + 500),
        });
      }
    })();
    const entry = { revision: current.revision, names, work };
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
