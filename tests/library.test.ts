import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LibraryService, toFilm } from "../frontend/src/services/library/LibraryService";
import type { LibraryPort } from "../frontend/src/services/library/LibraryService";
import type { LibraryStatus, NativeVideo } from "../frontend/src/contracts/library";

const video: NativeVideo = {
  id: "old-uuid",
  local_id: "TEST-001",
  title: "测试影片",
  original_title: null,
  studio: null,
  director: null,
  premiered: null,
  duration: 121,
  rating: null,
  video_path: "C:\\媒体\\TEST-001.mp4",
  dir_path: "C:\\媒体",
  file_size: 1024 ** 3,
  poster: "C:\\媒体\\poster.jpg",
  resolution: "1920x1080",
  scan_status: 2,
  created_at: "2026-01-01 00:00:00",
  width: 1920,
  height: 1080,
  favorite: 0,
  missing: 0,
  nfo_path: "C:\\媒体\\TEST-001.nfo",
  actors: ["测试演员"],
  genres: ["测试分类"],
  series: "测试系列",
};
const status: LibraryStatus = {
  directories: [],
  scan: null,
  revision: 0,
  databasePath: "fixture.db",
};
afterEach(() => vi.useRealTimers());
describe("媒体库服务", () => {
  it("保留旧版字符串 ID、秒数与空资料，UI 使用分钟", () => {
    const film = toFilm(video, () => "/cover");
    expect(film).toMatchObject({
      id: "old-uuid",
      duration: 2,
      durationSeconds: 121,
      year: 0,
      quality: "1080p",
      coverUrl: "/cover",
      metadata: { fileName: "TEST-001.mp4", actors: ["测试演员"] },
    });
    expect(film.files).toHaveLength(3);
  });
  it("浏览器不生成目录和影片，也不伪造导入成功", async () => {
    const service = new LibraryService();
    await service.initialize();
    await expect(service.add({ path: "C:\\媒体", recursive: true, formats: [] })).rejects.toThrow(
      "桌面",
    );
    expect(service.getSnapshot()).toMatchObject({ total: 0, selectedFilm: null });
  });
  it("旧库宽高、年份、横图路径仍可展示", () => {
    const film = toFilm(
      {
        ...video,
        width: 0,
        height: 0,
        year: 2020,
        poster: null,
        thumb: "C:\\媒体\\thumb.jpg",
        fanart: "C:\\媒体\\fanart.jpg",
        tags: ["旧标签"],
      },
      (path) => path,
    );
    expect(film).toMatchObject({
      year: 2020,
      quality: "1080p",
      coverUrl: "C:\\媒体\\thumb.jpg",
      metadata: { tags: ["旧标签"] },
    });
    expect(film.files?.filter((file) => file.kind === "image")).toHaveLength(2);
  });
  it("重复初始化只有一次读取，扫描期间轮询，完成后刷新片库", async () => {
    vi.useFakeTimers();
    let active = true;
    let videoLoads = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "library.status")
        return {
          ...status,
          revision: active ? 0 : 1,
          scan: { state: active ? "scanning" : "completed" },
        };
      if (method === "library.summary") return { total: active ? 0 : 1, favorites: 0 };
      if (method === "library.query") {
        ++videoLoads;
        return { items: active ? [] : [video], offset: 0, total: active ? 0 : 1 };
      }
      return {};
    });
    const service = new LibraryService({
      request: request as LibraryPort["request"],
      mount: async () => () => undefined,
    });
    await Promise.all([service.initialize(), service.initialize()]);
    expect(videoLoads).toBe(0);
    const view = service.createFilmQuery();
    service.attach(view);
    view.configure({}, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(videoLoads).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(videoLoads).toBe(1);
    active = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(view.getSnapshot().items.get(0)?.id).toBe("old-uuid");
    expect(service.getSnapshot().total).toBe(1);
    expect(videoLoads).toBe(2);
    await service.shutdown();
  });
  it("收藏只有数据库确认后才更新界面，写入失败保留原状态", async () => {
    const service = new LibraryService({
      request: (async (method: string) => {
        if (method === "library.status") return status;
        if (method === "library.summary") return { total: 1, favorites: 0 };
        throw new Error("数据库只读");
      }) as LibraryPort["request"],
      mount: async () => () => undefined,
    });
    await service.initialize();
    const film = toFilm(video, () => undefined);
    service.selectFilm(film);
    await expect(service.toggleFavorite(film)).rejects.toThrow("数据库只读");
    expect(service.getSnapshot().selectedFilm?.favorite).toBe(false);
  });
  it("五万条片库初始化只取统计，可见页按需读取，扫描并发由原生自动计算", async () => {
    const order: string[] = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      order.push(method);
      if (method === "library.status")
        return { ...status, logicalProcessors: 16, defaultConcurrency: 14, maxConcurrency: 16 };
      if (method === "library.summary") return { total: 50000, favorites: 12 };
      if (method === "library.query") {
        const offset = (params as { offset: number }).offset;
        return {
          items: Array.from({ length: 100 }, (_, i) => ({ ...video, id: String(offset + i) })),
          offset,
          total: 50000,
        };
      }
      return {};
    });
    const service = new LibraryService({
      request: request as LibraryPort["request"],
      mount: async () => () => undefined,
    });
    await service.initialize();
    expect(service.getSnapshot().total).toBe(50000);
    expect(order).not.toContain("library.query");
    const view = service.createFilmQuery();
    service.attach(view);
    view.configure({}, true);
    await vi.waitFor(() => expect(view.getSnapshot().ready).toBe(true));
    expect(view.getSnapshot().items.size).toBe(100);
    service.selectFilm(view.getSnapshot().items.get(0)!);
    view.loadRange(25000, 25020);
    await vi.waitFor(() => expect(view.getSnapshot().items.get(25000)?.id).toBe("25000"));
    expect(service.getSnapshot().selectedFilm?.id).toBe("0");
    await service.scan("directory");
    expect(request).toHaveBeenCalledWith("library.scan", { id: "directory" });
    expect(order.filter((method) => method === "library.query")).toHaveLength(2);
    expect(order).not.toContain("library.videos");
    await service.shutdown();
  });
  it("添加期间到达的旧 idle 快照不会丢掉新的扫描状态", async () => {
    let resolveStatus!: (value: LibraryStatus) => void;
    let first = true;
    const service = new LibraryService({
      request: ((method: string) => {
        if (method === "library.status" && first) {
          first = false;
          return new Promise<LibraryStatus>((resolve) => {
            resolveStatus = resolve;
          });
        }
        if (method === "library.status")
          return Promise.resolve({ ...status, scan: { state: "scanning" } });
        return Promise.resolve(method === "library.summary" ? { total: 0, favorites: 0 } : {});
      }) as LibraryPort["request"],
      mount: async () => () => undefined,
    });
    const initial = service.initialize();
    const added = service.add({ path: "C:\\媒体", recursive: true, formats: [] });
    resolveStatus(status);
    await Promise.all([initial, added]);
    expect(service.getSnapshot().scan?.state).toBe("scanning");
    await service.shutdown();
  });
  it("取消收藏后计数、收藏查询和独立详情一起刷新", async () => {
    let favorite = true;
    let revision = 0;
    const service = new LibraryService({
      request: (async (method: string) => {
        if (method === "library.status") return { ...status, revision };
        if (method === "library.summary") return { total: 1, favorites: favorite ? 1 : 0 };
        if (method === "library.video") return { ...video, favorite: favorite ? 1 : 0 };
        if (method === "library.query")
          return {
            items: favorite ? [{ ...video, favorite: 1 }] : [],
            offset: 0,
            total: favorite ? 1 : 0,
          };
        if (method === "library.favorite") {
          favorite = false;
          ++revision;
        }
        return {};
      }) as LibraryPort["request"],
      mount: async () => () => undefined,
    });
    await service.initialize();
    const view = service.createFilmQuery();
    service.attach(view);
    view.configure({ scope: "favorites" }, true);
    await vi.waitFor(() => expect(view.getSnapshot().ready).toBe(true));
    const film = view.getSnapshot().items.get(0)!;
    service.selectFilm(film);
    await service.toggleFavorite(film);
    await vi.waitFor(() => expect(view.getSnapshot().total).toBe(0));
    expect(service.getSnapshot()).toMatchObject({
      total: 1,
      favorites: 0,
      selectedFilm: { id: video.id, favorite: false },
    });
    await service.shutdown();
  });
});
