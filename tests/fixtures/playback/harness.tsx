import "@mantine/core/styles.css";
import "../../../frontend/src/styles/global.css";
import { StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { filesystem, os, server, window as nativeWindow } from "@neutralinojs/lib";
import { initializePlatform } from "../../../frontend/src/platform/neutralino/bootstrap";
import { playbackPort } from "../../../frontend/src/platform/neutralino/playback";
import { PlaybackService } from "../../../frontend/src/services/playback/PlaybackService";
import PlaybackWindow from "../../../frontend/src/features/player/PlaybackWindow";
import { cssVariablesResolver, theme } from "../../../frontend/src/app/theme";
import type { PlaybackOptions } from "../../../frontend/src/services/playback/source";

const runtime = initializePlatform();
const service = new PlaybackService(playbackPort(runtime));
const play = service.play.bind(service);
const params = new URLSearchParams(location.search);
const source = params.get("source")!;
const endpoint = params.get("endpoint")!;
const resultPath = params.get("result")!;
const results: { name: string; ok: boolean; detail: unknown }[] = [];
const exceptions: string[] = [];
const workers: string[] = [];
const OriginalWorker = window.Worker;
window.Worker = class extends OriginalWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    workers.push(String(url));
    super(url, options);
  }
};
window.addEventListener("error", (event) => exceptions.push(event.message));
window.addEventListener("unhandledrejection", (event) => exceptions.push(String(event.reason)));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string, timeout = 35000) {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > timeout)
      throw new Error(
        `等待超时：${label}；${document.querySelector("video")?.currentSrc}；readyState=${document.querySelector("video")?.readyState}；${document.querySelector<HTMLElement>(".playback-window")?.innerText}`,
      );
    await sleep(50);
  }
}
function View() {
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot);
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
    >
      <p>合成视频播放验证（测试专用入口，不进入正式应用）</p>
      {snapshot.opened && (
        <PlaybackWindow
          snapshot={snapshot}
          service={service}
          notice={(text) => exceptions.push(text)}
        />
      )}
      <pre
        id="results"
        style={{ position: "fixed", bottom: 0, fontSize: 12, maxHeight: 150, overflow: "auto" }}
      />
    </MantineProvider>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <View />
  </StrictMode>,
);
new MutationObserver(() => {
  const video = document.querySelector("video");
  if (video) video.muted = true;
}).observe(document.body, { childList: true, subtree: true });

async function playbackCase(name: string, url: string, options?: PlaybackOptions) {
  console.log("PLAYBACK CASE", name, runtime);
  const started = performance.now();
  await play(url, { title: name, ...options });
  await until(() => {
    const video = document.querySelector("video");
    return !!video && !video.paused && video.currentTime > 0.25 && video.videoWidth > 0;
  }, name);
  const video = document.querySelector("video")!;
  const firstFrameMs = performance.now() - started;
  const duration = video.duration;
  const width = video.videoWidth;
  if (name.startsWith("本地 MP4"))
    await nativeWindow.snapshot(resultPath.replace(/result.json$/, "player.png"));
  const seekStart = performance.now();
  video.currentTime = duration * 0.7;
  await until(() => !video.seeking && video.currentTime >= duration * 0.7, `${name} 拖动`, 10000);
  const seekMs = Math.round(performance.now() - seekStart);
  video.pause();
  video.currentTime = duration * 0.4;
  await until(() => !video.seeking, `${name} 暂停时拖动`, 10000);
  await sleep(150);
  if (!video.paused) throw new Error("暂停后拖动意外自动恢复播放");
  await service.close();
  await until(() => !document.querySelector("video"), "卸载媒体");
  await sleep(50);
  if (!video.paused || video.hasAttribute("src")) throw new Error("卸载后仍持有媒体请求");
  if (runtime === "desktop") {
    const mounts = await server.getMounts();
    if (Object.keys(mounts).some((key) => key.startsWith("/javm-playback")))
      throw new Error("挂载未清理");
  }
  return {
    playbackStartedMs: Math.round(firstFrameMs),
    seekMs,
    duration,
    width,
    workers: workers.length,
  };
}
async function run() {
  console.log("PLAYBACK START", runtime, Boolean(window.NL_PORT));
  const cases: [string, string, PlaybackOptions?][] = [
    ["本地 MP4 · 中文 空格 # & %", `${source}/测试 & 100% #1.mp4`],
    ["本地 MP4 · 4 GiB 之后的真实音视频数据", `${source}/large.mp4`],
    ["本地 M3U8 · TS 分片", `${source}/playlist.m3u8`],
    ["网络 MP4", `${endpoint}/cors/fixture.mp4`],
    ["网络 M3U8 · 重定向", `${endpoint}/redirect.m3u8`],
    ["网络 M3U8 · fMP4", `${endpoint}/cors/fmp4.m3u8`],
    ["网络 M3U8 · AES-128", `${endpoint}/cors/encrypted.m3u8`],
    ["网络 M3U8 · 无扩展名", `${endpoint}/cors/manifest?id=encoded%2Fa+%25`],
    ["网络 M3U8 · 无 CORS", `${endpoint}/native/playlist.m3u8`],
    ["网络 M3U8 · 原生类型探测", `${endpoint}/native/manifest?id=1`],
    ["网络 M3U8 · 原生字节范围分片", `${endpoint}/native/range.m3u8`],
    [
      "网络 M3U8 · 指定 Referer",
      `${endpoint}/referer/playlist.m3u8`,
      { referer: `${endpoint}/watch/clip` },
    ],
  ];
  for (const [name, url, options] of cases) {
    try {
      results.push({ name, ok: true, detail: await playbackCase(name, url, options) });
    } catch (error) {
      results.push({ name, ok: false, detail: String(error) });
      await service.close().catch(() => {});
    }
    document.getElementById("results")!.textContent = JSON.stringify(results, null, 2);
    await filesystem.writeFile(
      resultPath,
      JSON.stringify({ done: false, results, exceptions, workers }),
    );
  }
  try {
    await play(`${source}/missing.mp4`);
    throw new Error("缺失文件未报错");
  } catch (error) {
    results.push({
      name: "缺失文件反馈",
      ok: service.getSnapshot().error?.includes("不存在") === true,
      detail: String(error),
    });
    await service.close();
  }
  await play(`${endpoint}/native/slow.m3u8`, { referer: `${endpoint}/watch/clip` });
  let activeProcesses = await os.getSpawnedProcesses();
  const processDeadline = performance.now() + 8000;
  while (!activeProcesses.length && performance.now() < processDeadline) {
    await sleep(100);
    activeProcesses = await os.getSpawnedProcesses();
  }
  const closeStart = performance.now();
  await service.close();
  const closeMs = Math.round(performance.now() - closeStart);
  await sleep(500);
  const processes = await os.getSpawnedProcesses();
  const mounts = await server.getMounts();
  results.push({
    name: "慢请求取消及清理",
    ok:
      activeProcesses.length > 0 &&
      closeMs < 10000 &&
      !processes.length &&
      !Object.keys(mounts).length,
    detail: { activeBeforeClose: activeProcesses.length, closeMs, processes, mounts },
  });
  await filesystem.writeFile(
    resultPath,
    JSON.stringify({ done: true, results, exceptions, workers }),
  );
  if (params.get("hold") === "1")
    await play(`${source}/测试 & 100% #1.mp4`, { title: "本地播放 · 默认控制条" });
}
void run().catch(async (error: unknown) => {
  await filesystem.writeFile(
    resultPath,
    JSON.stringify({ done: true, results, exceptions, fatal: String(error), workers }),
  );
});
