import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { NativeLibraryPort } from "../frontend/src/platform/neutralino/library";
import { LibraryService } from "../frontend/src/services/library/LibraryService";
import type { NativeVideo } from "../frontend/src/contracts/library";

const fixture = vi.hoisted(() => ({
  mounts: {} as Record<string, string>,
  mount: vi.fn(async (prefix: string, target: string) => {
    // 实测 Neutralino 在 Windows 上返回斜杠规范化后的挂载目录。
    fixture.mounts[prefix] = target.replaceAll("\\", "/");
  }),
}));
vi.mock("@neutralinojs/lib", () => ({
  events: {},
  extensions: {},
  filesystem: {},
  server: {
    getMounts: async () => ({ ...fixture.mounts }),
    mount: fixture.mount,
    unmount: async (prefix: string) => {
      delete fixture.mounts[prefix];
    },
  },
}));

const libraries: LibraryService[] = [];
beforeEach(() => {
  fixture.mounts = {};
  fixture.mount.mockClear();
  vi.stubGlobal("window", { NL_PORT: 12345 });
});
afterEach(async () => {
  for (const library of libraries.splice(0)) await library.shutdown();
  vi.unstubAllGlobals();
});

it("收藏刷新和重新打开详情时，保留已挂载的本地封面与预览图", async () => {
  const directory = "C:\\SafeFixture\\资料\\metadata";
  const images = `${directory}\\safe-work\\images`;
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
    dir_path: `${directory}\\safe-work`,
    file_size: null,
    poster: `${images}\\封面 #1.jpg`,
    resolution: null,
    scan_status: 2,
    created_at: "2026-01-01",
    width: 0,
    height: 0,
    favorite: 0,
    missing: 0,
    nfo_path: "",
    actors: [],
    genres: [],
    series: "",
    availability: "metadata_only",
    screenshots: [
      { id: "safe-shot", path: `${images}\\预览 1.jpg`, kind: "screenshot", seconds: 0 },
    ],
  };
  let revision = 0;
  const request = async (method: string, params?: unknown) => {
    if (method === "library.status")
      return {
        directories: [],
        assetRoots: [],
        metadataDirectory: directory,
        scan: null,
        revision,
      };
    if (method === "library.summary") return { total: 1, favorites: video.favorite };
    if (method === "library.video") return structuredClone(video);
    if (method === "library.favorite") {
      video.favorite = (params as { value: boolean }).value ? 1 : 0;
      revision++;
      return {};
    }
    if (method === "library.shutdown") return {};
    throw new Error("未配置的安全 mock 操作");
  };
  const port = new NativeLibraryPort();
  port.request = request as NativeLibraryPort["request"];
  const library = new LibraryService(port);
  libraries.push(library);
  await library.initialize();
  await library.openWork(video.id);
  const before = library.getSnapshot().selectedFilm!;
  expect(before.coverUrl).toContain(encodeURIComponent("封面 #1.jpg"));
  expect(before.screenshots).toHaveLength(1);

  await library.toggleFavorite(before);
  expect(library.getSnapshot().selectedFilm).toMatchObject({
    favorite: true,
    coverUrl: before.coverUrl,
    artwork: before.artwork,
    screenshots: before.screenshots,
  });
  await library.openWork(video.id);
  expect(library.getSnapshot().selectedFilm?.screenshots).toEqual(before.screenshots);
  await library.toggleFavorite(library.getSnapshot().selectedFilm!);
  expect(library.getSnapshot().selectedFilm).toMatchObject({
    favorite: false,
    coverUrl: before.coverUrl,
    screenshots: before.screenshots,
  });
  expect(fixture.mount).toHaveBeenCalledTimes(1);
});

it("复用大小写和末尾分隔符不同的同一目录，继续拒绝目录外的图片", async () => {
  fixture.mounts["/javm-media/safe"] = "c:/safefixture/media/";
  const asset = await new NativeLibraryPort().mount([
    { id: "safe", path: "C:\\SafeFixture\\Media" },
  ]);
  expect(asset("C:\\SafeFixture\\Media\\封面.jpg")).toContain(encodeURIComponent("封面.jpg"));
  expect(asset("C:\\SafeFixture\\Media-Other\\image.jpg")).toBeUndefined();
  expect(asset("C:\\SafeFixture\\Media\\..\\image.jpg")).toBeUndefined();
  expect(fixture.mount).not.toHaveBeenCalled();
});

it("挂载点确实指向另一个目录时，不返回错误目录中的图片", async () => {
  fixture.mounts["/javm-media/metadata"] = "C:/SafeFixture/Another/metadata";
  const asset = await new NativeLibraryPort().mount([], "C:\\SafeFixture\\metadata");
  expect(asset("C:\\SafeFixture\\metadata\\safe-work\\cover.jpg")).toBeUndefined();
  expect(fixture.mount).not.toHaveBeenCalled();
});
