import "@mantine/core/styles.css";
import "../../../frontend/src/styles/global.css";
import { StrictMode, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Alert, Button, Checkbox, Group, MantineProvider, Stack, Text } from "@mantine/core";
import { WorkspaceContext } from "../../../frontend/src/app/state";
import type { Page, WorkspaceState } from "../../../frontend/src/app/state";
import { theme, cssVariablesResolver } from "../../../frontend/src/app/theme";
import { Scraper } from "../../../frontend/src/features/resources/Scraper";
import type { ScraperHandle } from "../../../frontend/src/features/resources/Scraper";
import { Downloads } from "../../../frontend/src/features/downloads/Downloads";
import { ImagePreviewProvider } from "../../../frontend/src/components/ImagePreview";
import { ScrapeService } from "../../../frontend/src/services/scraping/ScrapeService";
import { MetaTubeService } from "../../../frontend/src/services/metadata/MetaTubeService";
import { LibraryService } from "../../../frontend/src/services/library/LibraryService";
import { DownloadService } from "../../../frontend/src/services/downloads/DownloadService";
import type { ScrapeTask } from "../../../frontend/src/contracts/scraping";
import type { DownloadTask } from "../../../frontend/src/contracts/downloads";
import { defaultDownloadSettings } from "../../../frontend/src/contracts/downloads";
import { FilmDetail } from "../../../frontend/src/features/films/FilmDetail";
import { NewDownloadModal } from "../../../frontend/src/features/downloads/NewDownloadModal";
import type { Film } from "../../../frontend/src/contracts/media";
const metadataFilm: Film = {
  id: "aabbccdd-0000-4000-8000-000000000001",
  code: "TEST-001",
  title: "虚构影片 · 海边散步",
  english: "",
  year: 2026,
  duration: 90,
  genre: "",
  quality: "",
  size: "",
  favorite: true,
  missing: false,
  availability: "metadata_only",
  files: [{ name: "movie.nfo", path: "C:/fixture/metadata/movie.nfo", kind: "metadata" }],
};

let failArtwork = false,
  slow = false,
  writes = 0;
const tasks = new Map<string, ScrapeTask>(),
  files = new Map<string, DownloadTask>();
const delay = (signal: AbortSignal, ms = 180) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => {
      clearTimeout(timer);
      reject(new DOMException("已取消", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
const library = new LibraryService();
const metatube = new MetaTubeService(
  { read: async () => null, write: async () => {} },
  async (request, signal) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/providers")) return { data: { movie_providers: { Fixture: {} } } };
    if (url.pathname.endsWith("/version")) return { data: 1 };
    await delay(signal, slow ? 12000 : 200);
    const movie = {
      provider: "Fixture",
      id: "001",
      number: "TEST-001",
      title: "虚构影片 · 海边散步",
      summary: "合成元数据，仅用于流程验证。",
      actors: ["虚构角色"],
      score: 4,
      runtime: 90,
    };
    return { data: url.pathname.endsWith("/search") ? [movie] : movie };
  },
  {
    bundled: async () => ({ path: "fixture", version: "v1.4.0" }),
    start: async () => ({
      endpoint: "http://fixture.invalid",
      token: "",
      exited: new Promise(() => {}),
      stop: async () => {},
    }),
  },
  true,
);
const scraping = new ScrapeService(
  {
    load: async (offset) => [...tasks.values()].slice(offset, offset + 100),
    save: async (task) => {
      tasks.set(task.id, structuredClone(task));
    },
    remove: async (task) => {
      tasks.delete(task.id);
    },
    prepare: async (task, signal) => {
      await delay(signal);
      return {
        id: task.workId || task.id,
        path: task.path || "",
        fileStamp: "fixture",
        code: "",
        title: task.name,
        hasArtwork: false,
      };
    },
    artwork: async (_, signal) => {
      await delay(signal);
      if (failArtwork) throw new Error("模拟封面请求超时");
      return { path: "C:/fixture/poster.png", dispose: async () => {} };
    },
    commit: async () => {
      writes++;
      return {};
    },
    refresh: async () => {},
  },
  metatube,
);
const downloads = new DownloadService(
  {
    load: async () => ({
      tasks: [...files.values()],
      settings: { ...defaultDownloadSettings, directory: "C:/fixture" },
    }),
    save: async (task) => {
      files.set(task.id, structuredClone(task));
    },
    remove: async (id) => {
      files.delete(id);
    },
    saveSettings: async () => {},
    close: async () => {},
  },
  {
    defaultDirectory: async () => "C:/fixture",
    outputSize: async () => 123456,
    run: async (_, __, signal) => delay(signal, 250),
    checkTools: async () => [],
    open: async () => {},
  },
);
downloads.connectScraping(scraping.enqueueDownload);
void downloads.initialize();
void scraping.initialize();
function View() {
  const [detail, setDetail] = useState(false);
  const [newDownload, setNewDownload] = useState(false);
  const [favorite, setFavorite] = useState(true);
  const [page, setPage] = useState<Page>("downloads"),
    [message, setMessage] = useState("");
  const ref = useRef<ScraperHandle>(null);
  const state = useSyncExternalStore(downloads.subscribe, downloads.getSnapshot);
  useSyncExternalStore(scraping.subscribe, scraping.getSnapshot);
  const add = (name: string) => {
    void downloads
      .add({
        urls: [`https://example.invalid/${name}.mp4?fixture=${crypto.randomUUID()}`],
        directory: "C:/fixture",
        kind: "auto",
        headers: {},
      })
      .catch((error: Error) => setMessage(error.message));
  };
  return (
    <WorkspaceContext.Provider
      value={
        {
          page,
          go: setPage,
          library,
          libraryState: library.getSnapshot(),
          downloads,
          scraping,
          metatube,
          runtime: "browser",
          notice: setMessage,
          playSource: () => {},
          openFilm: () => {},
          add: () => {
            setDetail(false);
            setNewDownload(true);
          },
          toggleFavorite: () => setFavorite(!favorite),
          play: () => setMessage("不应播放资料作品"),
          scrape: () => setDetail(false),
          unavailable: setMessage,
          showScrapeQueue: () => {
            setPage("scraper");
            ref.current?.showQueue();
          },
        } as unknown as WorkspaceState
      }
    >
      <main
        style={{ height: "100dvh", padding: 20, display: "flex", flexDirection: "column", gap: 16 }}
      >
        <Alert title="流程验证 · 全部使用虚构数据">
          正式组件与任务服务；下载、资料接口和落盘在本页模拟。已保存资料 {writes} 次。
        </Alert>
        <Group>
          <Button onClick={() => setDetail(true)}>查看未下载作品</Button>
          <Button onClick={() => setPage("downloads")}>下载页</Button>
          <Button
            onClick={() => {
              setPage("scraper");
              ref.current?.showQueue();
            }}
          >
            刮削队列
          </Button>
          <Button variant="default" disabled={!state.ready} onClick={() => add("TEST-001")}>
            模拟有番号下载
          </Button>
          <Button variant="default" disabled={!state.ready} onClick={() => add("unknown")}>
            模拟无番号下载
          </Button>
          <Checkbox
            label="封面失败"
            onChange={(event) => {
              failArtwork = event.currentTarget.checked;
            }}
          />
          <Checkbox
            label="慢请求"
            onChange={(event) => {
              slow = event.currentTarget.checked;
            }}
          />
        </Group>
        {message && <Text role="alert">{message}</Text>}
        <Stack style={{ display: page === "downloads" ? "flex" : "none", minHeight: 0, flex: 1 }}>
          <Downloads />
        </Stack>
        <Stack style={{ display: page === "scraper" ? "flex" : "none", minHeight: 0, flex: 1 }}>
          <Scraper ref={ref} />
        </Stack>
      </main>
      <FilmDetail
        film={detail ? { ...metadataFilm, favorite } : null}
        initialView="info"
        onClose={() => setDetail(false)}
      />
      {newDownload && (
        <NewDownloadModal opened film={metadataFilm} onClose={() => setNewDownload(false)} />
      )}
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
