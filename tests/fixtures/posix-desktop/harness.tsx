import "@mantine/core/styles.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, MantineProvider, Paper, Text } from "@mantine/core";
import Hls from "hls.js";
import {
  app,
  events,
  filesystem,
  init,
  os,
  server,
  window as nativeWindow,
} from "@neutralinojs/lib";
import { installAbortCompatibility } from "../../../frontend/src/platform/abortCompatibility";
import { NativeLibraryPort } from "../../../frontend/src/platform/neutralino/library";
import { nativeDownloadHost } from "../../../frontend/src/platform/neutralino/downloadHost";
import { NativeMediaTransport } from "../../../frontend/src/platform/neutralino/playbackTransport";
import { createPosixHiddenWebview } from "../../../frontend/src/platform/neutralino/posixHiddenWebview";
import {
  closeMainWindow,
  exitApplication,
  initializeLifecycle,
} from "../../../frontend/src/platform/neutralino/lifecycle";
import { DownloadService } from "../../../frontend/src/services/downloads/DownloadService";
import { ToolDownloadEngine } from "../../../frontend/src/services/downloads/ToolDownloadEngine";
import { createDownloadTasks } from "../../../frontend/src/services/downloads/input";
import { defaultDownloadSettings } from "../../../frontend/src/contracts/downloads";
import { BackgroundSettingsService } from "../../../frontend/src/services/settings/BackgroundSettingsService";

installAbortCompatibility();
const params = new URLSearchParams(location.search);
const root = params.get("root")!,
  origin = params.get("origin")!,
  phase = params.get("phase")!;
const results: string[] = [],
  errors: string[] = [];
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function until(read: () => boolean | Promise<boolean>, label: string, ms = 15000) {
  const end = performance.now() + ms;
  while (!(await read())) {
    if (performance.now() > end) throw new Error(label);
    await pause(50);
  }
}
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
function SafeScreen() {
  const [count, setCount] = useState(0);
  return (
    <MantineProvider defaultColorScheme="dark">
      <Paper p="md">
        <Text>Safe forest platform fixture</Text>
        <Button id="safe-action" onClick={() => setCount(count + 1)}>
          Count {count}
        </Button>
        <video id="safe-video" muted playsInline width="160" />
      </Paper>
    </MantineProvider>
  );
}
createRoot(document.getElementById("root")!).render(<SafeScreen />);
const write = (extra = {}) =>
  filesystem.writeFile(
    `${root}/${phase}.json`,
    JSON.stringify({ results, errors, ...extra }, null, 2),
  );
const port = new NativeLibraryPort();
async function verifyMedia() {
  await until(() => !!document.getElementById("safe-action"), "React did not mount");
  const button = document.getElementById("safe-action") as HTMLButtonElement;
  button.click();
  await until(() => button.textContent === "Count 1", "React interaction failed");
  assert(
    getComputedStyle(button).backgroundColor !== "rgba(0, 0, 0, 0)",
    "Mantine background missing",
  );
  assert(button.getBoundingClientRect().height > 20, "Mantine layout missing");
  results.push("React / Mantine layout and interaction");
  const capabilities = await port.request<{ media: boolean }>("capabilities");
  assert(capabilities.media, "Full media extension missing");
  const settings = { ...defaultDownloadSettings, directory: `${root}/downloads` };
  await filesystem.createDirectory(settings.directory);
  const engine = new ToolDownloadEngine(nativeDownloadHost);
  await engine.checkTools(settings);
  for (const [kind, leaf] of [
    ["http", "pattern.mp4"],
    ["hls", "playlist.m3u8"],
  ] as const) {
    const task = createDownloadTasks(
      {
        kind,
        urls: [`${origin}/${leaf}`],
        directory: settings.directory,
        name: `安全 ${kind}`,
        headers: {},
      },
      [],
    )[0]!;
    let frames = 0;
    const frameTimer = setInterval(() => {
      frames++;
    }, 20);
    try {
      await engine.run(
        task,
        settings,
        AbortSignal.timeout(45000),
        () => {},
        async (phase, inputs) => {
          task.phase = phase;
          if (inputs) task.inputs = inputs;
        },
      );
    } finally {
      clearInterval(frameTimer);
    }
    assert((await filesystem.getStats(task.output)).size > 1000, "Download output missing");
    const probe = await nativeDownloadHost.probe(task.output, AbortSignal.timeout(10000));
    assert(probe.durationMs >= 2000, "Download probe failed");
    assert(frames > 0, "Download blocked the UI");
    results.push(`${kind} download, probe and UI responsiveness`);
  }
  const transport = new NativeMediaTransport();
  try {
    const part = await transport.fetch(`${origin}/pattern.mp4`, AbortSignal.timeout(10000), {
      start: 0,
      end: 31,
    });
    assert(part.data.byteLength === 32, "Range response lost its boundaries");
  } finally {
    await transport.dispose();
  }
  results.push("Native playback Range transport");
  await server.mount("/safe-media", `${root}/media`);
  const video = document.getElementById("safe-video") as HTMLVideoElement;
  for (const hls of [false, true]) {
    let controller: Hls | undefined;
    const url = `${location.origin}/safe-media/${hls ? "playlist.m3u8" : "pattern.mp4"}`;
    if (hls && !video.canPlayType("application/vnd.apple.mpegurl")) {
      assert(Hls.isSupported(), "No native HLS or MediaSource support");
      controller = new Hls({ enableWorker: true });
      controller.loadSource(url);
      controller.attachMedia(video);
    } else video.src = url;
    try {
      await until(() => {
        if (video.error) throw new Error(`Video error ${video.error.code}`);
        return video.readyState >= 2;
      }, "Video decoder did not load");
      await video.play();
      await until(() => video.currentTime > 0.15, "Video did not advance");
      results.push(`${hls ? "HLS" : "MP4"} actual WebKit playback`);
    } finally {
      video.pause();
      controller?.destroy();
      video.removeAttribute("src");
      video.load();
    }
  }
  await server.unmount("/safe-media");
  const hidden = createPosixHiddenWebview();
  for (let index = 0; index < 2; index++) {
    const candidates = await hidden(
      { provider: "webview", url: `${origin}/capture` },
      AbortSignal.timeout(20000),
      "",
    );
    assert(
      candidates.some((candidate) => candidate.url === `${origin}/playlist.m3u8`),
      "Hidden WebKit did not capture the safe playlist",
    );
  }
  const abort = new AbortController();
  const cancelled = hidden({ provider: "webview", url: `${origin}/empty` }, abort.signal, "");
  setTimeout(() => abort.abort(), 800);
  await cancelled.then(
    () => {
      throw new Error("Cancelled capture returned success");
    },
    (error: unknown) => {
      assert(
        (error as { code?: string }).code === "cancelled",
        "Hidden cancellation did not finish cleanly",
      );
    },
  );
  assert((await os.getSpawnedProcesses()).length === 0, "Owned helper process remains");
  results.push("Hidden WebKit capture, isolated repeat and cancellation");
}
async function run() {
  await nativeWindow.show();
  if (phase === "desktop") await verifyMedia();
  const background = new BackgroundSettingsService({
    read: async () => ({ runInBackground: true }),
    write: async () => {},
  });
  await background.initialize();
  const service = new DownloadService(
    {
      load: async () => ({ tasks: [], settings: { ...defaultDownloadSettings, directory: root } }),
      save: async () => {},
      saveSettings: async () => {},
      remove: async () => {},
      close: async () => {
        assert((await os.getSpawnedProcesses()).length === 0, "Shutdown left helpers");
        await port.request("close");
        await write({ done: true });
      },
    },
    new ToolDownloadEngine(nativeDownloadHost),
  );
  await service.initialize();
  initializeLifecycle(service, background);
  await service.add({
    kind: "http",
    urls: [`${origin}/stall.mp4`],
    directory: root,
    name: "安全 取消",
    headers: {},
  });
  await until(
    () => service.getSnapshot().tasks.some((task) => task.status === "downloading"),
    "Background fixture did not start",
  );
  results.push("Active download reaches explicit shutdown");
  await closeMainWindow();
  // The fallback phase denies setTray and must exit via the same graceful path.
  if (phase === "desktop") {
    assert(!(await nativeWindow.isVisible()), "Tray close did not hide the window");
    assert(
      service.getSnapshot().tasks.some((task) => task.status === "downloading"),
      "Closing stopped a background task",
    );
    await nativeWindow.show();
    results.push("Tray close keeps downloads active and the window can reopen");
    await exitApplication();
  }
}
void events.on("ready", () => {
  void run().catch(async (error: unknown) => {
    await write({ fatal: String(error) });
    await app.exit(1);
  });
});
init();
