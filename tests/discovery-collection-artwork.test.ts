import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LibraryService } from "../frontend/src/services/library/LibraryService";
import type { LibraryPort } from "../frontend/src/services/library/LibraryService";
import { ArtworkService } from "../frontend/src/services/library/ArtworkService";
import type { ArtworkTools } from "../frontend/src/services/library/ArtworkService";
import type { NativeVideo } from "../frontend/src/contracts/library";
import type { MovieDetails } from "../frontend/src/services/metadata/MetaTubeService";
import { OnlineWorksService } from "../frontend/src/services/catalog/OnlineWorksService";
import type { CatalogProcessor } from "../frontend/src/services/catalog/workerClient";

// 所有来源、图片、文件和数据库均为安全 mock，不读取用户资料或发出网络请求。
const details: MovieDetails = {
  provider: "JavBus",
  id: "SAFE-001",
  homepage: "https://www.javbus.com/SAFE-001_2026-01-01",
  fields: { code: "SAFE-001", title: "安全自然纪录片" },
  coverUrl: "https://images.example.invalid/cover.jpg",
  coverCandidates: ["https://images.example.invalid/backup.jpg"],
  previewImages: [
    "https://images.example.invalid/preview-1.jpg",
    "https://images.example.invalid/preview-2.jpg",
  ],
};
const libraries: LibraryService[] = [];
afterEach(async () => {
  for (const library of libraries.splice(0)) await library.shutdown();
});

function fixture() {
  let revision = 0;
  let mounted = false;
  const video: NativeVideo = {
    id: "safe-work",
    local_id: "SAFE-001",
    title: "安全自然纪录片",
    original_title: null,
    studio: null,
    director: null,
    premiered: null,
    duration: null,
    rating: null,
    video_path: null,
    dir_path: "C:/fixture/metadata/safe-work",
    file_size: null,
    poster: null,
    resolution: null,
    scan_status: 2,
    created_at: "2026-01-01",
    width: 0,
    height: 0,
    favorite: 0,
    missing: 0,
    nfo_path: "C:/fixture/metadata/safe-work/movie.nfo",
    actors: [],
    genres: [],
    series: "",
    availability: "metadata_only",
    screenshots: [],
  };
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "library.status")
      return { directories: [], scan: null, revision, databasePath: "fixture.sqlite3" };
    if (method === "library.summary") return { total: video.favorite, favorites: video.favorite };
    if (method === "library.scrape.prepare") {
      video.favorite = 1;
      return { id: video.id, path: "", fileStamp: "", nfoStamp: "" };
    }
    if (method === "library.scrape.commit") {
      revision++;
      return {};
    }
    if (method === "library.video") return structuredClone(video);
    if (method === "library.artwork.prepare")
      return {
        directory: `${video.dir_path}/images`,
        poster: video.poster ?? "",
        code: video.local_id,
        title: video.title,
        source: { provider: details.provider, id: details.id, homepage: details.homepage },
        videos: [],
      };
    if (method === "library.artwork.commit") {
      const { images } = params as { images: { path: string; kind: "poster" | "screenshot" }[] };
      for (const image of images) {
        if (image.kind === "poster") video.poster = image.path;
        else
          video.screenshots!.push({
            id: `shot-${video.screenshots!.length}`,
            ...image,
            kind: "screenshot",
            seconds: 0,
          });
      }
      revision++;
      return { retired: [] };
    }
    if (method === "library.shutdown") return {};
    throw new Error("未配置的安全 mock 操作");
  });
  const port: LibraryPort = {
    request: request as LibraryPort["request"],
    mount: async () => {
      mounted = revision > 0;
      return (path) => (mounted ? `/safe-assets/${path.split("/").at(-1)}` : undefined);
    },
  };
  const tools = {
    mkdir: async () => {},
    read: async () => new ArrayBuffer(4),
    write: vi.fn<ArtworkTools["write"]>(async () => {}),
    remove: vi.fn<ArtworkTools["remove"]>(async () => {}),
    frame: async () => {},
    transform: vi.fn<ArtworkTools["transform"]>(async () => new ArrayBuffer(4)),
    download: vi.fn<ArtworkTools["download"]>(async () => {}),
    details: vi.fn<ArtworkTools["details"]>(async () => {
      throw new Error("收藏不应再次查询来源");
    }),
  } satisfies ArtworkTools;
  const library = new LibraryService(port);
  library.artwork = new ArtworkService(port, tools, () => library.refreshAfterImport());
  libraries.push(library);
  return { library, tools, request, video };
}

describe("发现收藏保存图片", () => {
  it("直接采用已读取详情，保存封面和预览图并返回刷新后的本地路径", async () => {
    const f = fixture();
    const warning = vi.fn();
    const saved = await f.library.collectMetadata(details, warning);
    expect(saved).toMatchObject({
      favorite: true,
      availability: "metadata_only",
      coverUrl: expect.stringContaining("/safe-assets/"),
    });
    expect(saved.screenshots).toHaveLength(2);
    expect(saved.screenshots?.every((image) => image.src.startsWith("/safe-assets/"))).toBe(true);
    expect(f.tools.details).not.toHaveBeenCalled();
    expect(f.tools.download).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(f.tools.download).mock.calls.every(([, referer]) => referer === details.homepage),
    ).toBe(true);
    expect(warning).not.toHaveBeenCalled();
    const methods = f.request.mock.calls.map(([method]) => method);
    expect(methods.indexOf("library.artwork.commit")).toBeGreaterThan(
      methods.indexOf("library.scrape.commit"),
    );
  });

  it("重试收藏复用作品，保留已有图片并只补齐缺失的封面", async () => {
    const f = fixture();
    f.video.screenshots = [
      {
        id: "existing",
        path: `${f.video.dir_path}/images/existing.jpg`,
        kind: "screenshot",
        seconds: 0,
      },
    ];
    const saved = await f.library.collectMetadata(details);
    expect(saved.screenshots).toHaveLength(1);
    expect(f.tools.download).toHaveBeenCalledTimes(1);
    const again = await f.library.collectMetadata(details);
    expect(again.id).toBe(saved.id);
    expect(again.coverUrl).toBe(saved.coverUrl);
    expect(again.screenshots).toEqual(saved.screenshots);
    expect(f.tools.download).toHaveBeenCalledTimes(1);
  });

  it("首个封面地址失败后使用备用地址，重复预览图只保存一次", async () => {
    const f = fixture();
    vi.mocked(f.tools.download).mockImplementation(async (url) => {
      if (url === details.coverUrl) throw new Error("安全 mock 图片缺失");
    });
    const saved = await f.library.collectMetadata({
      ...details,
      previewImages: [details.previewImages![0]!, details.previewImages![0]!],
    });
    expect(saved.coverUrl).toBeDefined();
    expect(saved.screenshots).toHaveLength(1);
    expect(vi.mocked(f.tools.download).mock.calls.map(([url]) => url)).toEqual([
      details.coverUrl,
      details.coverCandidates![0],
      details.previewImages![0],
    ]);
  });

  it("部分图片失败保留成功图片、收藏和文字，并反馈重试入口", async () => {
    const f = fixture();
    vi.mocked(f.tools.download).mockImplementation(async (url) => {
      if (url === details.previewImages![0]) throw new Error("安全 mock 图片缺失");
    });
    const warning = vi.fn();
    const saved = await f.library.collectMetadata(details, warning);
    expect(saved.coverUrl).toBeDefined();
    expect(saved.screenshots).toHaveLength(1);
    expect(saved.favorite).toBe(true);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("1 张图片获取失败"));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("获取封面与截图"));
  });

  it("全部图片失败仍返回已收藏的资料，下次收藏可以补图", async () => {
    const f = fixture();
    vi.mocked(f.tools.download).mockRejectedValue(new Error("安全 mock 网络失败"));
    const warning = vi.fn();
    const saved = await f.library.collectMetadata(details, warning);
    expect(saved.favorite).toBe(true);
    expect(saved.coverUrl).toBeUndefined();
    expect(saved.screenshots).toHaveLength(0);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("资料已收藏"));
    expect(f.request.mock.calls.some(([method]) => method === "library.artwork.commit")).toBe(
      false,
    );
    vi.mocked(f.tools.download).mockResolvedValue(undefined);
    const again = await f.library.collectMetadata(details);
    expect(again.id).toBe(saved.id);
    expect(again.coverUrl).toBeDefined();
    expect(again.screenshots).toHaveLength(2);
  });

  it("图片数量有上限，来源没有图片时直接保存资料", async () => {
    const f = fixture();
    const saved = await f.library.collectMetadata({
      ...details,
      previewImages: Array.from(
        { length: 100 },
        (_, index) => `https://images.example.invalid/${index}.jpg`,
      ),
    });
    expect(f.tools.download).toHaveBeenCalledTimes(24);
    expect(saved.screenshots).toHaveLength(23);
    const empty = fixture();
    const warning = vi.fn();
    await empty.library.collectMetadata(
      { ...details, coverUrl: undefined, coverCandidates: [], previewImages: [] },
      warning,
    );
    expect(empty.tools.download).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  it("取消收藏图片会清理临时文件，拒绝并发收藏，保留文字资料", async () => {
    const f = fixture();
    let finish!: () => void;
    vi.mocked(f.tools.download).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const warning = vi.fn();
    const pending = f.library.collectMetadata(details, warning);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await expect(f.library.collectMetadata(details)).rejects.toThrow("等待");
    f.library.artwork!.cancel();
    finish();
    const saved = await pending;
    expect(saved.favorite).toBe(true);
    expect(saved.coverUrl).toBeUndefined();
    expect(f.tools.write).not.toHaveBeenCalled();
    expect(f.tools.remove).toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("取消"));
  });

  it("退出在文字提交期间发生时，不再启动图片下载", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    let finish!: () => void;
    f.request.mockImplementation(async (method, params) => {
      if (method === "library.scrape.commit")
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return original(method, params);
    });
    const pending = f.library.collectMetadata(details);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const shutdown = f.library.shutdown();
    finish();
    await Promise.all([pending, shutdown]);
    expect(f.tools.download).not.toHaveBeenCalled();
  });
});

describe("已收藏作品重新读取图片来源", () => {
  it("从保存的 JavBus 网页读取详情", async () => {
    const url = "https://www.javbus.com/SAFE-001_2026-01-01";
    const run = vi.fn(async () => details);
    const fetch = vi.fn(async () => "安全合成页面");
    const service = new OnlineWorksService(
      { run: run as CatalogProcessor["run"], close: vi.fn() },
      fetch,
      async () => {},
    );
    const work = { url, code: "SAFE-001", title: "安全自然纪录片" };
    const signal = new AbortController().signal;
    expect(await service.readDetails(work, signal)).toBe(details);
    expect(fetch).toHaveBeenCalledWith(url, signal);
    expect(run).toHaveBeenCalledWith("javbusDetails", { html: "安全合成页面", work });
    expect(service.getSnapshot().detail).toBeNull();
    await service.shutdown();
  });
});
