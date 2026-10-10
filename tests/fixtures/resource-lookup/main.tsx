import { init, events, app, filesystem, os } from "@neutralinojs/lib";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { createHiddenWebview } from "../../../frontend/src/platform/neutralino/hiddenWebview";
import { createResolutionHttp } from "../../../frontend/src/platform/neutralino/resolutionHttp";
import { ResolutionWorkerPool } from "../../../frontend/src/services/streamResolution/workerClient";
import { ResolutionService } from "../../../frontend/src/services/streamResolution/ResolutionService";
import { ResourceSearchService } from "../../../frontend/src/services/streamResolution/ResourceSearchService";
import { ResourceSearchPanel } from "../../../frontend/src/features/resources/ResourceSearch";
import type { NewDownload } from "../../../frontend/src/contracts/downloads";

init();
await new Promise<void>((resolve) => {
  void events.on("ready", () => resolve());
});
const params = new URLSearchParams(location.search);
const resultPath = params.get("result")!;
const base = params.get("base")!;
const frameBase = params.get("frameBase")!;
const temp = await os.getPath("temp");
const initialTemp = new Set((await filesystem.readDirectory(temp)).map((entry) => entry.entry));
const reports: Record<string, unknown>[] = [];
const downloads: NewDownload[] = [];
const resolution = new ResolutionService({
  http: createResolutionHttp(),
  parser: new ResolutionWorkerPool(),
  webview: createHiddenWebview(),
});
const search = new ResourceSearchService(
  resolution,
  {
    directory: () => "C:/safe-mock",
    add: async (input) => {
      downloads.push(input);
      return 1;
    },
  },
  [
    { id: "safe", name: "安全来源 A", template: `${base}/page/{code}` },
    { id: "missing", name: "安全来源 B", template: `${base}/missing/{code}` },
    { id: "empty", name: "安全来源 C", template: `${base}/empty/{code}` },
    { id: "slow", name: "安全来源 D", template: `${base}/slow/{code}` },
  ],
);
createRoot(document.getElementById("root")!).render(
  <MantineProvider>
    <ResourceSearchPanel service={search} />
  </MantineProvider>,
);
const expect = (value: unknown, label: string) => {
  if (!value) throw new Error(label);
};
const wait = async (ready: () => boolean, timeout = 60000) => {
  const end = Date.now() + timeout;
  while (!ready()) {
    if (Date.now() > end) throw new Error("fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
try {
  search.setSources(["safe", "missing"]);
  search.setQuery("DEMO-001");
  await wait(
    () =>
      document.querySelector<HTMLInputElement>('input[placeholder="输入完整番号"]')?.value ===
      "DEMO-001",
  );
  document.querySelector("form")!.requestSubmit();
  await wait(() => !search.getSnapshot().busy);
  const successful = search.getSnapshot().rows.find((row) => row.sourceId === "safe");
  reports.push({
    scenario: "code-to-webview-to-hls",
    state: successful?.state,
    error: successful?.error,
  });
  expect(
    successful?.stream?.manifestUrl === `${base}/hls/demo-001/master.m3u8?token=safe`,
    "code lookup failed",
  );
  expect(
    search.getSnapshot().rows.find((row) => row.sourceId === "missing")?.state === "failed",
    "missing source did not fail independently",
  );
  expect(successful?.stream?.tracks[0]?.height === 720, "HLS variant not checked");
  await wait(() =>
    [...document.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("加入下载"),
    ),
  );
  [...document.querySelectorAll("button")]
    .find((button) => button.textContent?.includes("加入下载"))!
    .click();
  await wait(() => downloads.length === 1 && !search.getSnapshot().busy);
  await search.addDownload("safe");
  expect(
    downloads.length === 1 && downloads[0]?.kind === "hls",
    "download handoff/duplicate guard failed",
  );
  expect(
    downloads[0]?.headers.referer === `${frameBase}/frame/demo-001`,
    "request context not handed off",
  );
  reports.push({
    scenario: "download-handoff",
    count: downloads.length,
    headers: Object.keys(downloads[0]!.headers),
  });
  search.retry("missing");
  await wait(() => !search.getSnapshot().busy);
  expect(
    search.getSnapshot().rows.find((row) => row.sourceId === "safe")?.added,
    "retry lost successful result",
  );
  reports.push({
    scenario: "source-retry",
    state: search.getSnapshot().rows.find((row) => row.sourceId === "missing")?.state,
  });
  search.setSources(["safe"]);
  search.search("DEMO-004");
  await wait(() => !search.getSnapshot().busy);
  expect(
    search.getSnapshot().rows[0]?.stream?.manifestUrl ===
      `${base}/hls/demo-004/manifest?token=safe`,
    "MIME-only manifest not captured",
  );
  reports.push({ scenario: "extensionless-hls", state: search.getSnapshot().rows[0]?.state });
  search.setSources(["empty"]);
  search.search("DEMO-002");
  await wait(() => !search.getSnapshot().busy);
  expect(search.getSnapshot().rows[0]?.state === "failed", "empty page did not time out");
  reports.push({ scenario: "no-result-timeout", error: search.getSnapshot().rows[0]?.error });
  search.setSources(["slow"]);
  search.search("DEMO-003");
  await new Promise((resolve) => setTimeout(resolve, 3000));
  search.cancel();
  await wait(() => !search.getSnapshot().busy);
  expect(search.getSnapshot().rows[0]?.state === "cancelled", "cancellation failed");
  reports.push({ scenario: "cancel", state: search.getSnapshot().rows[0]?.state });
  search.search("DEMO-005");
  await new Promise((resolve) => setTimeout(resolve, 3000));
  expect(search.getSnapshot().busy, "shutdown fixture has no running task");
  await search.shutdown();
  await resolution.shutdown();
  reports.push({
    scenario: "shutdown-with-active-browser",
    state: resolution.getSnapshot().tasks.at(-1)?.state,
  });
  const leaked = (await filesystem.readDirectory(temp)).filter(
    (entry) => entry.entry.startsWith("javm-webview-") && !initialTemp.has(entry.entry),
  );
  expect(leaked.length === 0, "isolated browser profiles not removed");
  reports.push({ scenario: "cleanup", remainingProfiles: leaked.length });
  await filesystem.writeFile(resultPath, JSON.stringify({ ok: true, reports }, null, 2));
} catch (error) {
  await search.shutdown().catch(() => {});
  await resolution.shutdown().catch(() => {});
  await filesystem.writeFile(
    resultPath,
    JSON.stringify(
      { ok: false, error: error instanceof Error ? error.message : "fixture failure", reports },
      null,
      2,
    ),
  );
} finally {
  await app.exit();
}
