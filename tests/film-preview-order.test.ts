import { describe, expect, it, vi } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { FilmScreenshots } from "../frontend/src/features/films/FilmScreenshots";
import { movieDetailsToFilm } from "../frontend/src/features/resources/movieDetailsFilm";
import { movieDetails } from "../frontend/src/services/metadata/MetaTubeService";
import type { Film } from "../frontend/src/contracts/media";

vi.mock("../frontend/src/components/ImagePreview", () => ({
  useImagePreview: () => ({ open: vi.fn() }),
}));

const film = movieDetailsToFilm(
  movieDetails({
    provider: "Fixture",
    id: "safe",
    number: "SAFE-001",
    title: "虚构自然纪录片",
    preview_video_url: "https://example.invalid/safe.mp4",
    preview_video_hls_url: "https://example.invalid/safe.m3u8",
    preview_images: ["https://example.invalid/one.jpg", "https://example.invalid/two.jpg"],
  }),
  { provider: "Fixture", id: "safe", code: "SAFE-001", title: "虚构自然纪录片" },
);
const render = (value: Film) =>
  renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(FilmScreenshots, { film: value, label: "预览", onPlayTrailer: vi.fn() }),
    ),
  );

describe("详情预览顺序", () => {
  it("首位只显示一段预览片，图片保持原顺序且不预加载视频", () => {
    const html = render(film);
    expect(html.match(/aria-label="播放预览片"/g)).toHaveLength(1);
    expect(html.indexOf('aria-label="播放预览片"')).toBeLessThan(
      html.indexOf('aria-label="查看截图 1"'),
    );
    expect(html.indexOf('aria-label="查看截图 1"')).toBeLessThan(
      html.indexOf('aria-label="查看截图 2"'),
    );
    expect(html).toContain("1 段预览片 · 2 张图片");
    expect(html).not.toContain("<video");
  });
  it("仅有预览片时不显示空截图提示", () => {
    const html = render({ ...film, screenshots: [] });
    expect(html).toContain('aria-label="播放预览片"');
    expect(html).not.toContain("暂无截图");
  });
  it("无预览片时保留图片且不放置不可用的播放入口", () => {
    const html = render({ ...film, trailers: [] });
    expect(html).not.toContain('aria-label="播放预览片"');
    expect(html).toContain('aria-label="查看截图 1"');
    expect(html).toContain("2 张图片");
  });
});
