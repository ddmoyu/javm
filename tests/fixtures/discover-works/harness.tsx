import "@mantine/core/styles.css";
import "../../../frontend/src/styles/global.css";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Checkbox, Group, MantineProvider, Text } from "@mantine/core";
import { App } from "../../../frontend/src/app/App";
import { theme, cssVariablesResolver } from "../../../frontend/src/app/theme";
import { ImagePreviewProvider } from "../../../frontend/src/components/ImagePreview";
import { CatalogWorkerClient } from "../../../frontend/src/services/catalog/workerClient";
import { DiscoveryCatalogService } from "../../../frontend/src/services/catalog/DiscoveryCatalogService";
import { LibraryService } from "../../../frontend/src/services/library/LibraryService";
import { ResourceSearchService } from "../../../frontend/src/services/streamResolution/ResourceSearchService";
import type { ResolutionService } from "../../../frontend/src/services/streamResolution/ResolutionService";
import { createNetworkSettings } from "../../../frontend/src/platform/neutralino/network";
import { createDownloadService } from "../../../frontend/src/platform/neutralino/downloads";
import { createPlaybackService } from "../../../frontend/src/platform/neutralino/playback";
import { createPlaybackSettings } from "../../../frontend/src/platform/neutralino/playbackSettings";
import { createMetadataServices } from "../../../frontend/src/platform/neutralino/metadataServices";
import { createBackgroundSettings } from "../../../frontend/src/platform/neutralino/backgroundSettings";
import { createApplicationLogs } from "../../../frontend/src/platform/neutralino/logging";
import { listing, details } from "./data";

let fail = false,
  slow = false;
const catalog = new DiscoveryCatalogService(new CatalogWorkerClient(), {
  read: async () => null,
  write: async () => {},
  fetch: async (url, signal) => {
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer);
        reject(new DOMException("已取消", "AbortError"));
      };
      const timer = setTimeout(
        () => {
          signal.removeEventListener("abort", cancel);
          resolve();
        },
        slow ? 5000 : 180,
      );
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
    if (fail) {
      fail = false;
      throw new Error("安全 mock：网络暂时不可用");
    }
    const parsed = new URL(url);
    return parsed.pathname.startsWith("/work/")
      ? details(parsed.pathname.split("/")[2])
      : listing(Number(parsed.searchParams.get("page") || 1), parsed.pathname);
  },
});
const library = new LibraryService(
  {
    async request<T>(method: string, params: unknown = {}): Promise<T> {
      const response = await fetch("/__library-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, params }),
      });
      const envelope = (await response.json()) as { result: T; error?: string };
      if (envelope.error) throw new Error(envelope.error);
      return envelope.result;
    },
    mount: async () => () => undefined,
  },
  catalog,
);
void library.initialize();
const resolution = {
  getSnapshot: () => ({ webviewAvailable: true, tasks: [], cleanupPending: 0 }),
  subscribe: () => () => {},
  submit: () => ({
    id: crypto.randomUUID(),
    cancel: () => {},
    result: Promise.resolve({
      ok: false,
      code: "no_candidates",
      message: "安全 mock：本例只验证番号交接，不连接远程视频。",
    }),
  }),
} as unknown as ResolutionService;
const resourceSearch = new ResourceSearchService(
  resolution,
  {
    directory: () => "C:/safe-fixture",
    add: async () => 1,
  },
  [{ id: "safe", name: "安全示例来源", template: "https://example.invalid/{code}" }],
);
const network = createNetworkSettings("browser");
const metadata = createMetadataServices("browser", network);
const downloads = createDownloadService("browser", network);
const playback = createPlaybackService("browser");
const playbackSettings = createPlaybackSettings("browser");
const backgroundSettings = createBackgroundSettings("browser");
const logs = createApplicationLogs("browser");
function Controls() {
  const [checked, setChecked] = useState(false);
  return (
    <Group
      style={{
        position: "fixed",
        bottom: 0,
        left: 215,
        zIndex: 1000,
        background: "#242124",
        padding: 8,
      }}
    >
      <Text size="xs">安全合成页面 · 隔离片库</Text>
      <Checkbox
        label="慢请求"
        checked={checked}
        onChange={(event) => {
          slow = event.currentTarget.checked;
          setChecked(slow);
        }}
      />
      <Button
        size="compact-xs"
        onClick={() => {
          fail = true;
        }}
      >
        下一次请求失败
      </Button>
    </Group>
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
        <App
          runtime="browser"
          library={library}
          network={network}
          downloads={downloads}
          playback={playback}
          playbackSettings={playbackSettings}
          backgroundSettings={backgroundSettings}
          logs={logs}
          resourceSearch={resourceSearch}
          {...metadata}
        />
      </ImagePreviewProvider>
      <Controls />
    </MantineProvider>
  </StrictMode>,
);
