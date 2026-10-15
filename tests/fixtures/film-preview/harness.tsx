import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Group, MantineProvider, Paper, Stack, Text } from "@mantine/core";
import "@mantine/core/styles.css";
import "../../../frontend/src/styles/global.css";
import { theme, cssVariablesResolver } from "../../../frontend/src/app/theme";
import { ImageSourcesProvider } from "../../../frontend/src/components/ImageSources";
import { ImagePreviewProvider } from "../../../frontend/src/components/ImagePreview";
import { ImageSourceService } from "../../../frontend/src/services/images/ImageSourceService";
import { FilmScreenshots } from "../../../frontend/src/features/films/FilmScreenshots";
import { movieDetailsToFilm } from "../../../frontend/src/features/resources/movieDetailsFilm";

const canvas = document.createElement("canvas");
canvas.width = 320;
canvas.height = 180;
const context = canvas.getContext("2d")!;
context.fillStyle = "#146c7b";
context.fillRect(0, 0, 320, 180);
context.fillStyle = "#fff";
context.font = "24px sans-serif";
context.fillText("SAFE SAMPLE", 70, 95);
const safeImage = canvas.toDataURL("image/png");
const images = new ImageSourceService({
  async load(_url, _referer, signal) {
    signal.throwIfAborted();
    return safeImage;
  },
  async invalidate() {},
  async shutdown() {},
});
const candidate = { provider: "Fixture", id: "sample", code: "SAFE-001", title: "虚构自然纪录片" };
const film = movieDetailsToFilm(
  {
    ...candidate,
    origin: "metatube",
    homepage: "https://example.invalid/safe",
    fields: candidate,
    previewVideoUrl: "https://example.invalid/safe.mp4",
    previewVideoHlsUrl: "https://example.invalid/safe.m3u8",
    previewImages: [1, 2, 3, 4, 5].map((index) => `https://example.invalid/${index}.png`),
  },
  candidate,
);
function App() {
  const [mode, setMode] = useState("both");
  const [played, setPlayed] = useState("尚未播放");
  return (
    <Stack p="xl" maw={700}>
      <Text fw={700}>安全预览验证：纯色占位图，播放请求由 mock 接收</Text>
      <Group>
        <Button onClick={() => setMode("both")}>预览片和图片</Button>
        <Button onClick={() => setMode("images")}>仅图片</Button>
        <Button onClick={() => setMode("video")}>仅预览片</Button>
      </Group>
      <Paper withBorder p="lg" w={420} maw="100%">
        <FilmScreenshots
          film={{
            ...film,
            trailers: mode === "images" ? [] : film.trailers,
            screenshots: mode === "video" ? [] : film.screenshots,
          }}
          label="预览"
          onPlayTrailer={(trailer) =>
            setPlayed(`收到播放请求：${trailer.format === "hls" ? "HLS" : "MP4"}`)
          }
        />
      </Paper>
      <Text component="output" aria-live="polite">
        {played}
      </Text>
    </Stack>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
    >
      <ImageSourcesProvider value={images}>
        <ImagePreviewProvider>
          <App />
        </ImagePreviewProvider>
      </ImageSourcesProvider>
    </MantineProvider>
  </StrictMode>,
);
