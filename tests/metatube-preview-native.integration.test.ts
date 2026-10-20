import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { MediaHost } from "./helpers/mediaHost";
import type { NativeVideo } from "../frontend/src/contracts/library";
import type { ScrapeTarget } from "../frontend/src/services/scraping/ScrapeService";
import { movieDetails } from "../frontend/src/services/metadata/MetaTubeService";
import type { MovieDetails } from "../frontend/src/services/metadata/MetaTubeService";
import { LibraryService, toFilm } from "../frontend/src/services/library/LibraryService";
import { DiscoveryCatalogService } from "../frontend/src/services/catalog/DiscoveryCatalogService";

const candidate = {
  provider: "Fixture",
  id: "safe-preview",
  code: "SAFE-701",
  title: "虚构自然纪录片",
};
const details = movieDetails({
  provider: candidate.provider,
  id: candidate.id,
  number: candidate.code,
  title: candidate.title,
  homepage: "https://example.invalid/safe",
  preview_video_url: "https://example.invalid/safe.mp4",
  preview_video_hls_url: "https://example.invalid/safe.m3u8",
  preview_images: ["https://example.invalid/one.jpg"],
});

describe.runIf(process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1")(
  "MetaTube 预览保存边界（隔离数据库，无外部请求）",
  () => {
    let host = new MediaHost();
    let database: string;
    let id: string;
    beforeAll(async () => {
      const temporary = path.resolve(import.meta.dirname, "../.tmp");
      await mkdir(temporary, { recursive: true });
      database = path.join(await mkdtemp(path.join(temporary, "preview-native-")), "tasks.sqlite3");
      await host.start(database);
    });
    afterAll(async () => {
      await host.close();
    });
    const save = async (value: MovieDetails) => {
      const jobId = crypto.randomUUID();
      const target = await host.request<ScrapeTarget>("library.scrape.prepare", {
        jobId,
        candidate,
        collect: true,
      });
      id = target.id;
      await host.request("library.scrape.commit", { ...target, jobId, details: value, image: "" });
      return host.request<NativeVideo>("library.video", { id });
    };
    it("普通资料收藏不启用 MetaTube 预览；主动刮削后按原链接保存", async () => {
      const ordinary = await save({ ...details, origin: undefined });
      expect(toFilm(ordinary, () => undefined).trailers).toEqual([]);
      expect(toFilm(ordinary, () => undefined).screenshots).toEqual([]);
      const scraped = await save(details);
      const film = toFilm(scraped, () => undefined);
      expect(film.trailers).toEqual([{ src: details.previewVideoUrl, format: undefined }]);
      expect(film.metadata?.homepage).toBe(details.homepage);
      expect(film.screenshots?.map((image) => image.src)).toEqual(details.previewImages);
      await save({
        ...details,
        origin: undefined,
        previewVideoUrl: "https://example.invalid/catalog.mp4",
      });
      await host.close();
      host = new MediaHost();
      await host.start(database);
      const reopened = await host.request<NativeVideo>("library.video", { id });
      expect(toFilm(reopened, () => undefined).trailers).toEqual(film.trailers);
    });
    it("重刮削替换过期预览，过滤异常链接并合并重复的 HLS 入口", async () => {
      const saved = await save({
        ...details,
        previewVideoUrl: details.previewVideoHlsUrl,
        previewImages: [
          "file:///C:/fixture.jpg",
          "https://user:secret@example.invalid/image.jpg",
          "https://example.invalid/ok.jpg",
          "https://example.invalid/ok.jpg",
        ],
      });
      const film = toFilm(saved, () => undefined);
      expect(film.trailers).toEqual([{ src: details.previewVideoHlsUrl, format: "hls" }]);
      expect(film.screenshots?.map((image) => image.src)).toEqual([
        "https://example.invalid/ok.jpg",
      ]);
    });
    it("同名来源的手动刮削结果不覆盖发现页详情缓存", async () => {
      const catalog = new DiscoveryCatalogService({
        run: async () => {
          throw new Error("此用例不得请求目录或网络");
        },
        close: () => {},
      });
      const ordinary: MovieDetails = {
        provider: "JavBus",
        id: candidate.code,
        homepage: "https://example.invalid/catalog",
        fields: { code: candidate.code, title: "虚构目录资料" },
      };
      catalog.movieDetails.remember(ordinary);
      const library = new LibraryService(
        {
          request: (method, params) => host.request(method, params),
          mount: async () => () => undefined,
        },
        catalog,
      );
      try {
        const scraped = await library.collectMetadata({
          ...ordinary,
          origin: "metatube",
          homepage: details.homepage,
          previewVideoHlsUrl: details.previewVideoHlsUrl,
        });
        expect(scraped.trailers).toEqual([{ src: details.previewVideoHlsUrl, format: "hls" }]);
        expect(catalog.movieDetails.code(candidate.code, "JavBus")).toEqual(ordinary);
      } finally {
        await library.shutdown();
        await catalog.shutdown();
      }
    });
  },
);
