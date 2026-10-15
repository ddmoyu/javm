import "@mantine/core/styles.css";
import "../../../frontend/src/styles/global.css";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { CdpConnection } from "../../../frontend/src/services/streamResolution/cdp";
import { MantineProvider } from "@mantine/core";
import { app, events, filesystem, init, server } from "@neutralinojs/lib";
import { createNetworkSettings } from "../../../frontend/src/platform/neutralino/network";
import { createDownloadService } from "../../../frontend/src/platform/neutralino/downloads";
import {
  createLibraryService,
  NativeLibraryPort,
} from "../../../frontend/src/platform/neutralino/library";
import { createScrapeService } from "../../../frontend/src/platform/neutralino/scraping";
import { createMetadataHttp } from "../../../frontend/src/platform/neutralino/metadataHttp";
import { movieDetails } from "../../../frontend/src/services/metadata/MetaTubeService";
import { createHiddenWebview } from "../../../frontend/src/platform/neutralino/hiddenWebview";
import { createResolutionHttp } from "../../../frontend/src/platform/neutralino/resolutionHttp";
import { ResolutionWorkerPool } from "../../../frontend/src/services/streamResolution/workerClient";
import { ResolutionService } from "../../../frontend/src/services/streamResolution/ResolutionService";
import { ResourceSearchService } from "../../../frontend/src/services/streamResolution/ResourceSearchService";
import { PlaybackService } from "../../../frontend/src/services/playback/PlaybackService";
import { playbackPort } from "../../../frontend/src/platform/neutralino/playback";
import PlaybackWindow from "../../../frontend/src/features/player/PlaybackWindow";
import { LibraryBackupService } from "../../../frontend/src/services/library/LibraryBackupService";
import { shutdownHttp } from "../../../frontend/src/platform/neutralino/http";
import type { NativeVideo } from "../../../frontend/src/contracts/library";

init();
await new Promise<void>((resolve) => {
  void events.on("ready", () => resolve());
});
const params = new URLSearchParams(location.search);
const base = params.get("base")!;
const root = params.get("root")!;
const resultPath = `${root}/result.json`;
const reports: Record<string, unknown>[] = [];
const errors: string[] = [];
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
window.addEventListener("error", (event) => errors.push(event.message));
const network = createNetworkSettings("desktop");
const downloads = createDownloadService("desktop", network);
const library = createLibraryService("desktop");
const http = createMetadataHttp(network);
const scraping = createScrapeService(
  "desktop",
  {
    async search(query, signal) {
      const data = await http(
        { url: `${base}/metadata/search?q=${encodeURIComponent(query)}` },
        signal,
      );
      return data as { provider: string; id: string; code: string; title: string }[];
    },
    async details(candidate, signal) {
      return movieDetails(await http({ url: `${base}/metadata/${candidate.id}` }, signal));
    },
  },
  network,
  library,
  () => downloads.initialize(),
);
downloads.connectScraping(scraping.enqueueDownload);
const playback = new PlaybackService(playbackPort("desktop"));
const port = new NativeLibraryPort();
const backups = new LibraryBackupService(
  port,
  async () => {},
  () => library.refreshAfterImport(),
);
const resolution = new ResolutionService({
  http: createResolutionHttp(),
  parser: new ResolutionWorkerPool(),
  webview: createHiddenWebview(),
});
const search = new ResourceSearchService(
  resolution,
  { directory: () => `${root}/output`, add: (input) => downloads.add(input) },
  [{ id: "safe", name: "安全合成来源", template: `${base}/page/{code}` }],
);
function View() {
  const snapshot = useSyncExternalStore(playback.subscribe, playback.getSnapshot);
  return (
    <MantineProvider>
      <p>安全纯色视频及虚构资料</p>
      {snapshot.opened && (
        <PlaybackWindow
          snapshot={snapshot}
          service={playback}
          notice={(text) => errors.push(text)}
        />
      )}
    </MantineProvider>
  );
}
createRoot(document.getElementById("root")!).render(<View />);
new MutationObserver(() => {
  const video = document.querySelector("video");
  if (video) video.muted = true;
}).observe(document.body, { childList: true, subtree: true });
const expect = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
async function until(check: () => boolean, label: string, timeout = 65000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) {
      const video = document.querySelector("video");
      throw new Error(
        `${label}: ${JSON.stringify({ video: video && { time: video.currentTime, paused: video.paused, width: video.videoWidth, ready: video.readyState, error: video.error?.message, source: video.currentSrc }, playback: playback.getSnapshot().error, scraping: scraping.getSnapshot().tasks.map((t) => ({ status: t.status, error: t.error })) })}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
let ok = false;
let browser: CdpConnection | undefined;
try {
  await Promise.all([
    network.initialize(),
    downloads.initialize(),
    library.initialize(),
    scraping.initialize(),
  ]);
  await downloads.updateSettings({
    ...downloads.getSnapshot().settings,
    directory: `${root}/output`,
    ffmpegPath: `${root}/bin/tools/ffmpeg.exe`,
    curlPath: `${root}/bin/tools/curl.exe`,
  });
  search.setSources(["safe"]);
  search.search("DEMO-001");
  await until(() => !search.getSnapshot().busy, "资源解析");
  expect(
    search.getSnapshot().rows[0]?.stream,
    `安全资源未解析：${JSON.stringify(search.getSnapshot())}`,
  );
  await search.addDownload("safe");
  await until(
    () =>
      downloads.getSnapshot().tasks[0]?.status === "completed" ||
      downloads.getSnapshot().tasks[0]?.status === "failed",
    "真实下载",
  );
  const task = downloads.getSnapshot().tasks[0]!;
  expect(task.status === "completed", task.error);
  expect((await filesystem.getStats(task.output)).size > 1000, "输出视频为空");
  reports.push({
    scenario: "search-real-hls-download-merge",
    status: task.status,
    output: task.output,
  });
  await until(
    () =>
      scraping.getSnapshot().tasks[0]?.status === "completed" ||
      ["failed", "needs_input", "interrupted"].includes(
        scraping.getSnapshot().tasks[0]?.status ?? "",
      ),
    "自动刮削",
  );
  const scrape = scraping.getSnapshot().tasks[0]!;
  expect(scrape.status === "completed", JSON.stringify(scrape));
  const videos = await port.request<NativeVideo[]>("library.videos", { offset: 0, limit: 100 });
  expect(videos.length === 1 && videos[0]?.title === "安全合成纪录片", "资料未入库");
  expect(videos[0]?.poster && (await filesystem.getStats(videos[0].poster)).size > 0, "封面未写入");
  const nfo = await filesystem.readFile(videos[0]!.nfo_path);
  expect(nfo.includes("安全合成纪录片"), "NFO 未落盘");
  reports.push({
    scenario: "metadata-artwork-nfo-library",
    works: videos.length,
    status: scrape.status,
  });
  // Hidden WebView suppresses media loading. Emulate page focus without showing a window.
  const [debugPort, endpoint] = (await filesystem.readFile(`${root}/profile/DevToolsActivePort`))
    .trim()
    .split(/\r?\n/);
  browser = await CdpConnection.connect(
    `ws://127.0.0.1:${debugPort}${endpoint}`,
    AbortSignal.timeout(60000),
  );
  const targets = (await browser.send("Target.getTargets")).targetInfos as {
    targetId: string;
    type: string;
    url: string;
  }[];
  const target = targets.find((item) => item.type === "page" && item.url === location.href);
  expect(target, "隔离播放器页面不存在");
  const session = String(
    (await browser.send("Target.attachToTarget", { targetId: target!.targetId, flatten: true }))
      .sessionId,
  );
  await browser.send("Emulation.setFocusEmulationEnabled", { enabled: true }, session);
  await playback.play(task.output, { title: "安全合成纪录片" });
  const mediaResponse = await fetch(playback.getSnapshot().media!.url, {
    headers: { Range: "bytes=0-31" },
    signal: AbortSignal.timeout(8000),
  });
  expect(
    mediaResponse.status === 206 && (await mediaResponse.arrayBuffer()).byteLength === 32,
    "播放分块通道无效",
  );
  await until(() => !!document.querySelector("video"), "挂载播放器");
  document.querySelector("video")!.muted = true;
  void document
    .querySelector("video")!
    .play()
    .catch((error: unknown) => errors.push(String(error)));
  await until(
    () => {
      const video = document.querySelector("video");
      return !!video && video.currentTime > 0.2 && video.videoWidth === 320;
    },
    "本地播放",
    15000,
  );
  const video = document.querySelector("video")!;
  video.currentTime = 4;
  await until(() => !video.seeking && video.currentTime >= 4, "播放拖动");
  await playback.close();
  expect(
    !Object.keys(await server.getMounts()).some((key) => key.startsWith("/javm-playback")),
    "播放挂载未释放",
  );
  reports.push({ scenario: "play-seek-cleanup", width: 320 });
  await backups.create(`${root}/backups`);
  await until(() => backups.getSnapshot().state !== "running", "备份");
  const backup = backups.getSnapshot().result;
  expect(backup?.works === 1, "片库备份未完成");
  await backups.inspect(backup!.path);
  await until(() => backups.getSnapshot().state !== "running", "备份检查");
  await backups.restore();
  await until(() => backups.getSnapshot().state !== "running", "恢复");
  expect(backups.getSnapshot().result?.rollbackPath, "恢复前副本缺失");
  reports.push({ scenario: "backup-restore-refresh", status: backups.getSnapshot().state });
  ok = true;
} catch (error) {
  errors.push(error instanceof Error ? error.message : JSON.stringify(error));
} finally {
  browser?.close();
  try {
    await search.shutdown();
    await resolution.shutdown();
    await playback.shutdown();
    await downloads.shutdown(async () => {
      await scraping.shutdown();
      await backups.shutdown();
      await network.shutdown();
      await shutdownHttp();
      await library.shutdown();
    });
  } catch (error) {
    ok = false;
    errors.push(`退出清理：${String(error)}`);
  }
  await filesystem.writeFile(
    resultPath,
    JSON.stringify({ ok: ok && !errors.length, reports, errors }, null, 2),
  );
  await app.exit();
}
