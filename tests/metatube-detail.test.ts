import { describe, expect, it } from "vite-plus/test";
import { movieDetails } from "../frontend/src/services/metadata/MetaTubeService";
import { movieDetailsToFilm } from "../frontend/src/features/resources/movieDetailsFilm";
import { playbackRequest } from "../frontend/src/services/playback/source";
import { LibraryService, toFilm } from "../frontend/src/services/library/LibraryService";
import type { NativeVideo } from "../frontend/src/contracts/library";
import { editableMetadata } from "../frontend/src/contracts/metadata";
import type { EditableMetadata } from "../frontend/src/contracts/metadata";

const candidate = { provider: "Fixture", id: "sample", code: "TEST-001", title: "虚构影片" };
const media = "https://example.invalid/";

describe("MetaTube 资料与五分制", () => {
  it("保留原始五分评分，缺失、零分和越界值不伪造有效评分", () => {
    for (const score of [0.1, 4.3, 5])
      expect(movieDetailsToFilm(movieDetails({ score }), candidate).rating).toBe(score);
    for (const score of [undefined, null, 0, -1, 5.1, 10, NaN, Infinity, "4.3"])
      expect(movieDetailsToFilm(movieDetails({ score }), candidate).rating).toBeUndefined();
  });

  it("保留品牌、来源、封面和两种预告片，并过滤无效或重复图片", () => {
    const film = movieDetailsToFilm(
      movieDetails({
        label: "示例品牌",
        homepage: `${media}movie`,
        thumb_url: `${media}poster.jpg`,
        big_thumb_url: `${media}poster.jpg`,
        cover_url: `${media}cover.jpg`,
        big_cover_url: `${media}cover-hd.jpg`,
        preview_images: [`${media}frame.jpg`, `${media}frame.jpg`, "file:///C:/private.jpg"],
        preview_video_url: `${media}trailer.mp4`,
        preview_video_hls_url: `${media}stream`,
      }),
      candidate,
    );
    expect(film.metadata).toMatchObject({
      label: "示例品牌",
      sourceId: "sample",
      homepage: `${media}movie`,
    });
    expect(film.coverUrl).toBe(`${media}poster.jpg`);
    expect(film.artwork).toHaveLength(3);
    expect(film.screenshots).toHaveLength(1);
    expect(film.trailers).toHaveLength(2);
    const hls = film.trailers![1]!;
    expect(
      playbackRequest(hls.src, { format: hls.format, referer: film.metadata!.homepage }),
    ).toMatchObject({
      format: "hls",
      kind: "network",
      referer: `${media}movie`,
    });
  });

  it("仅 HLS 或两个相同地址仍能播放，拒绝含凭据、控制字符及非网页协议的地址", () => {
    const hls = `${media}stream`;
    for (const preview_video_url of [undefined, hls]) {
      const film = movieDetailsToFilm(
        movieDetails({ preview_video_url, preview_video_hls_url: hls }),
        candidate,
      );
      expect(film.trailers).toEqual([{ src: hls, format: "hls" }]);
    }
    const details = movieDetails({
      homepage: "javascript:alert(1)",
      preview_video_url: "https://user:secret@example.invalid/trailer.mp4",
      preview_video_hls_url: "https://example.invalid/\nstream",
      thumb_url: "file:///C:/private.jpg",
    });
    const film = movieDetailsToFilm(details, candidate);
    expect(film.trailers).toEqual([]);
    expect(film.coverUrl).toBeUndefined();
    expect(film.metadata?.homepage).toBe("");
  });

  it("片库读写五分制保持旧评分精度与并发快照，清除评分仍保存为零", async () => {
    const video: NativeVideo = {
      id: "fixture",
      local_id: "TEST-001",
      title: "虚构影片",
      original_title: null,
      studio: null,
      director: null,
      premiered: null,
      duration: 0,
      rating: 8.7,
      video_path: "C:/fixture/sample.mp4",
      dir_path: "C:/fixture",
      file_size: 0,
      poster: null,
      resolution: null,
      scan_status: 2,
      created_at: "2026-10-10",
      width: 0,
      height: 0,
      favorite: 0,
      missing: 0,
      nfo_path: "",
      actors: [],
      genres: [],
      series: "",
    };
    let revision = 0;
    const writes: { patch: Partial<EditableMetadata>; expected: EditableMetadata }[] = [];
    const library = new LibraryService({
      mount: async () => () => undefined,
      async request<T>(method: string, params?: unknown): Promise<T> {
        if (method === "library.updateMetadata") {
          const change = params as (typeof writes)[number];
          if (change.patch.rating !== undefined) {
            expect(change.expected.rating).toBe(video.rating ?? 0);
            video.rating = change.patch.rating;
          }
          writes.push(change);
          ++revision;
          return undefined as T;
        }
        if (method === "library.status")
          return { directories: [], scan: null, revision, databasePath: "synthetic" } as T;
        if (method === "library.summary") return { total: 1, favorites: 0 } as T;
        if (method === "library.video") return { ...video } as T;
        throw new Error(`未提供的测试操作：${method}`);
      },
    });
    const film = toFilm(video, () => undefined);
    expect(film.rating).toBe(4.35);
    library.selectFilm(film);
    const initial = editableMetadata(film);
    await library.updateMetadata(film.id, { rating: 4.3 }, initial);
    expect(writes[0]).toMatchObject({ patch: { rating: 8.6 }, expected: { rating: 8.7 } });
    expect(library.getSnapshot().selectedFilm?.rating).toBe(4.3);
    await expect(library.updateMetadata(film.id, { rating: 5.1 }, initial)).rejects.toThrow("0～5");
    expect(writes).toHaveLength(1);
    const current = editableMetadata(library.getSnapshot().selectedFilm!);
    await library.updateMetadata(film.id, { title: "新的虚构标题" }, current);
    expect(writes[1]!.patch).not.toHaveProperty("rating");
    await library.updateMetadata(film.id, { rating: 0 }, current);
    expect(video.rating).toBe(0);
    expect(library.getSnapshot().selectedFilm?.rating).toBeUndefined();
    expect(initial.rating).toBe(4.35);
  });
});
