import "@mantine/core/styles.css";
import "../../../frontend/src/styles/global.css";
import { StrictMode, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  Alert,
  Button,
  Checkbox,
  Group,
  MantineProvider,
  Stack,
  Text,
  useMantineColorScheme,
} from "@mantine/core";
import { WorkspaceContext } from "../../../frontend/src/app/state";
import type { WorkspaceState } from "../../../frontend/src/app/state";
import { theme, cssVariablesResolver } from "../../../frontend/src/app/theme";
import { AiSettingsPanel } from "../../../frontend/src/features/settings/AiSettingsPanel";
import { MetaTubeSettingsPanel } from "../../../frontend/src/features/settings/MetaTubeSettingsPanel";
import { FilmEditor } from "../../../frontend/src/features/films/FilmEditor";
import { AiService } from "../../../frontend/src/services/metadata/AiService";
import { MetaTubeService } from "../../../frontend/src/services/metadata/MetaTubeService";
import type { MetaTubeHost } from "../../../frontend/src/services/metadata/MetaTubeService";
import type { Store, JsonHttp } from "../../../frontend/src/services/metadata/shared";
import type { NativeVideo } from "../../../frontend/src/contracts/library";
import type { EditableMetadata } from "../../../frontend/src/contracts/metadata";
import { LibraryService, toFilm } from "../../../frontend/src/services/library/LibraryService";
import { Scraper } from "../../../frontend/src/features/resources/Scraper";
import { ImagePreviewProvider } from "../../../frontend/src/components/ImagePreview";

function memory<T>(): Store<T> {
  let value: T | null = null;
  return {
    read: async () => value,
    write: async (input) => {
      value = structuredClone(input);
    },
  };
}
let slow = false,
  fail = false,
  revision = 0,
  writes = 0,
  detailRequests = 0;
const video: NativeVideo = {
  id: "fixture",
  local_id: "",
  title: "Fictional sample film",
  original_title: "",
  studio: "",
  director: "",
  premiered: "",
  duration: 120,
  rating: 0,
  video_path: "C:/fixture/TEST-001.mp4",
  dir_path: "C:/fixture",
  file_size: 1024,
  poster: null,
  resolution: "160x90",
  scan_status: 1,
  created_at: "2026-10-09",
  width: 160,
  height: 90,
  favorite: 0,
  missing: 0,
  nfo_path: "",
  actors: [],
  genres: [],
  series: "",
  plot: "A peaceful journey through a fictional city.",
};
const http: JsonHttp = async (request, signal) => {
  if (/\/movies\/(?!search)/.test(new URL(request.url).pathname)) ++detailRequests;
  await new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("cancelled", "AbortError"));
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      slow ? 8000 : 120,
    );
    signal.addEventListener("abort", abort, { once: true });
  });
  if (fail) throw new Error("测试接口暂时不可用");
  const url = new URL(request.url);
  if (url.pathname.endsWith("/db/version")) return { data: "fixture" };
  if (url.pathname.endsWith("/providers"))
    return { data: { movie_providers: { Fixture: "https://example.invalid" } } };
  if (url.pathname.endsWith("/movies/search"))
    return {
      data: [
        { provider: "Fixture", id: "sample", number: "TEST-001", title: "Fictional sample film" },
      ],
    };
  if (url.pathname.includes("/movies/"))
    return {
      data: {
        provider: "Fixture",
        id: "sample",
        number: "TEST-001",
        title: "MetaTube 虚构影片标题",
        summary: "A peaceful journey through a fictional city.",
        actors: ["虚构角色甲"],
        genres: ["测试分类"],
        runtime: 90,
      },
    };
  const prompt = (request.body as { messages: { content: string }[] }).messages[0]!.content;
  const content = prompt.includes("Extract")
    ? { code: "TEST-001" }
    : prompt.includes("Translate")
      ? { title: "虚构示例影片", plot: "穿过虚构城市的一段平静旅程。" }
      : { ok: true };
  return { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }] };
};
const host: MetaTubeHost = {
  bundled: async () => ({
    version: "v1.4.0",
    path: "C:/fixture/bin/tools/metatube/metatube-server.exe",
  }),
  start: async () => {
    let resolve!: () => void;
    const exited = new Promise<void>((done) => {
      resolve = done;
    });
    return {
      endpoint: "http://fixture.invalid",
      token: "",
      exited,
      stop: async () => {
        resolve();
      },
    };
  },
};
const ai = new AiService(memory(), http, true),
  metatube = new MetaTubeService(memory(), http, host, true);
const library = new LibraryService({
  mount: async () => () => undefined,
  async request<T>(method: string, params?: unknown): Promise<T> {
    if (method === "library.status")
      return { directories: [], scan: null, revision, databasePath: "isolated-ui-fixture" } as T;
    if (method === "library.summary") return { total: 1, favorites: 0 } as T;
    if (method === "library.video") return structuredClone(video) as T;
    if (method === "library.duplicateCode") return false as T;
    if (method === "library.updateMetadata") {
      const patch = (params as { patch: Partial<EditableMetadata> }).patch;
      const { code, originalTitle, duration, ...rest } = patch;
      Object.assign(video, rest, { metadata_edited: true });
      if (code !== undefined) video.local_id = code;
      if (originalTitle !== undefined) video.original_title = originalTitle;
      if (duration !== undefined) video.duration = duration * 60;
      ++revision;
      ++writes;
      return undefined as T;
    }
    throw new Error(`未提供的测试操作：${method}`);
  },
});
void ai.settings.initialize();
void metatube.initialize();
void library.initialize();
library.selectFilm(toFilm(video, () => undefined));
function View() {
  const [panel, setPanel] = useState("ai"),
    [edit, setEdit] = useState(false),
    [notice, setNotice] = useState("");
  const libraryState = useSyncExternalStore(library.subscribe, library.getSnapshot);
  useSyncExternalStore(metatube.subscribe, metatube.getSnapshot);
  const { toggleColorScheme } = useMantineColorScheme();
  return (
    <WorkspaceContext.Provider
      value={
        {
          ai,
          metatube,
          library,
          libraryState,
          notice: setNotice,
          runtime: "browser",
        } as unknown as WorkspaceState
      }
    >
      <main
        style={{ maxWidth: 850, height: "100dvh", overflowY: "auto", margin: "auto", padding: 24 }}
      >
        <Stack gap="md">
          <Alert title="交互测试 · 虚构服务">
            本页不访问真实供应商、不操作用户片库。资料写入次数：<output>{writes}</output>
            <Text size="sm">
              详情请求次数：<output>{detailRequests}</output>
            </Text>
          </Alert>
          <Group>
            <Button variant="default" onClick={() => setPanel("ai")}>
              AI 设置
            </Button>
            <Button variant="default" onClick={() => setPanel("metatube")}>
              MetaTube 设置
            </Button>
            <Button onClick={() => setEdit(true)}>编辑合成影片</Button>
            <Button variant="default" onClick={() => setPanel("search")}>
              搜索资料
            </Button>
            <Button variant="subtle" onClick={() => toggleColorScheme()}>
              切换主题
            </Button>
          </Group>
          <Group>
            <Checkbox
              label="模拟慢请求"
              onChange={(event) => {
                slow = event.currentTarget.checked;
              }}
            />
            <Checkbox
              label="模拟接口失败"
              onChange={(event) => {
                fail = event.currentTarget.checked;
              }}
            />
          </Group>
          {notice && (
            <Alert color="green">
              <output>{notice}</output>
            </Alert>
          )}
          <Text size="sm">
            当前片名：{libraryState.selectedFilm?.title} · 番号：
            {libraryState.selectedFilm?.code || "未填写"}
          </Text>
          {panel === "search" ? (
            <Scraper ref={null} />
          ) : panel === "ai" ? (
            <AiSettingsPanel />
          ) : (
            <MetaTubeSettingsPanel />
          )}
          {edit && libraryState.selectedFilm && (
            <FilmEditor film={libraryState.selectedFilm} onClose={() => setEdit(false)} />
          )}
        </Stack>
      </main>
    </WorkspaceContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
    >
      <ImagePreviewProvider>
        <View />
      </ImagePreviewProvider>
    </MantineProvider>
  </StrictMode>,
);
