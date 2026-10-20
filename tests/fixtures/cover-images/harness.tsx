import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Group, MantineProvider, Paper, SimpleGrid, Stack, Text } from "@mantine/core";
import "@mantine/core/styles.css";
import "../../../frontend/src/styles/global.css";
import { Poster } from "../../../frontend/src/components/Cover";
import { ImageSourcesProvider } from "../../../frontend/src/components/ImageSources";
import {
  ImagePreviewProvider,
  useImagePreview,
} from "../../../frontend/src/components/ImagePreview";
import { ImageSourceService } from "../../../frontend/src/services/images/ImageSourceService";
import { movieDetailsToFilm } from "../../../frontend/src/features/resources/movieDetailsFilm";

// 只生成纯色色块，fixture 的适配器不具备网络能力；CSP 再禁止所有外站请求。
const canvas = document.createElement("canvas");
canvas.width = 240;
canvas.height = 320;
const context = canvas.getContext("2d")!;
context.fillStyle = "#146c7b";
context.fillRect(0, 0, 240, 320);
context.fillStyle = "#ffffff";
context.font = "bold 24px sans-serif";
context.fillText("SAFE MOCK", 38, 152);
const safeImage = canvas.toDataURL("image/png");
const brokenImage = "data:image/png;base64,aW52YWxpZA==";
const source = (name: string) => `https://images.example.invalid/${name}`;
const service = new ImageSourceService({
  async load(url, _referer, signal) {
    signal.throwIfAborted();
    if (url.endsWith("slow"))
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    if (url.endsWith("denied")) throw new Error("Safe mock 403");
    return url.endsWith("corrupt") ? brokenImage : safeImage;
  },
  async invalidate() {},
  async shutdown() {},
});
const samples = [
  ["正常封面", [source("normal")]],
  ["403 后备用图", [source("denied"), source("backup")]],
  ["损坏图片后备用图", [source("corrupt"), source("backup")]],
  ["全部失败的占位", [source("denied")]],
] as const;
function App() {
  const { open } = useImagePreview();
  const [slow, setSlow] = useState(false);
  return (
    <Stack p="xl">
      <Text size="xl" fw={700}>
        封面安全验证：全部为本地生成色块
      </Text>
      <SimpleGrid cols={4}>
        {samples.map(([title, urls], index) => {
          const film = movieDetailsToFilm(
            {
              provider: "安全 mock",
              id: String(index),
              homepage: "https://catalog.example.invalid/safe",
              coverUrl: urls[0],
              coverCandidates: [...urls],
              fields: { code: `SAFE-${index}`, title },
            },
            { provider: "安全 mock", id: String(index), code: `SAFE-${index}`, title },
          );
          return (
            <Paper p="md" withBorder key={title}>
              <Stack>
                <div style={{ position: "relative", height: 220 }}>
                  <Poster film={film} />
                </div>
                <Text>{title}</Text>
                <Button onClick={() => open(film.artwork ?? [], 0, film.metadata?.homepage)}>
                  预览 {index + 1}
                </Button>
              </Stack>
            </Paper>
          );
        })}
      </SimpleGrid>
      <Group>
        <Button onClick={() => setSlow(!slow)}>{slow ? "取消卡片读取" : "开始慢速卡片"}</Button>
        <Button onClick={() => open([{ src: source("slow"), title: "安全慢速夹具" }])}>
          慢速预览
        </Button>
      </Group>
      {slow && (
        <div style={{ position: "relative", height: 150 }}>
          <Poster
            film={movieDetailsToFilm(
              {
                provider: "安全 mock",
                id: "slow",
                homepage: "",
                coverUrl: source("slow"),
                fields: { title: "安全慢速读取" },
              },
              { provider: "安全 mock", id: "slow", code: "SAFE-99", title: "安全慢速读取" },
            )}
          />
        </div>
      )}
    </Stack>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="dark">
      <ImageSourcesProvider value={service}>
        <ImagePreviewProvider>
          <App />
        </ImagePreviewProvider>
      </ImageSourcesProvider>
    </MantineProvider>
  </StrictMode>,
);
