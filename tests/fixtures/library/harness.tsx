import "@mantine/core/styles.css";
import "../../../frontend/src/styles/global.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../../frontend/src/app/App";
import { MantineProvider } from "@mantine/core";
import { cssVariablesResolver, theme } from "../../../frontend/src/app/theme";
import { ImagePreviewProvider } from "../../../frontend/src/components/ImagePreview";
import { LibraryService } from "../../../frontend/src/services/library/LibraryService";
import { createNetworkSettings } from "../../../frontend/src/platform/neutralino/network";
import { createDownloadService } from "../../../frontend/src/platform/neutralino/downloads";
import { createPlaybackService } from "../../../frontend/src/platform/neutralino/playback";
import { createPlaybackSettings } from "../../../frontend/src/platform/neutralino/playbackSettings";
import { createMetadataServices } from "../../../frontend/src/platform/neutralino/metadataServices";
import { createBackgroundSettings } from "../../../frontend/src/platform/neutralino/backgroundSettings";
import { createApplicationLogs } from "../../../frontend/src/platform/neutralino/logging";

const metrics = {
  requests: 0,
  queryRequests: 0,
  maxPage: 0,
  lastOffset: 0,
  maxCards: 0,
  longTasks: 0,
  maxTaskMs: 0,
};
let slow = false;
let failNext = false;
const library = new LibraryService({
  async request<T>(method: string, params: unknown = {}): Promise<T> {
    ++metrics.requests;
    if (method === "library.query") {
      ++metrics.queryRequests;
      metrics.lastOffset = (params as { offset: number }).offset;
      if (slow) await new Promise((resolve) => setTimeout(resolve, 800));
      if (failNext) {
        failNext = false;
        throw new Error("测试慢磁盘：本次查询失败");
      }
    }
    const response = await fetch("/__library-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
    const envelope = (await response.json()) as { result: T; error?: string };
    if (envelope.error) throw new Error(envelope.error);
    if (method === "library.query")
      metrics.maxPage = Math.max(
        metrics.maxPage,
        (envelope.result as { items: unknown[] }).items.length,
      );
    return envelope.result;
  },
  mount: async () => () => undefined,
});
void library.initialize();
const network = createNetworkSettings("browser");
const metadataServices = createMetadataServices("browser", network);
const downloads = createDownloadService("browser", network);
const playback = createPlaybackService("browser");

function Metrics() {
  const [text, setText] = useState("");
  useEffect(() => {
    const observer = new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        ++metrics.longTasks;
        metrics.maxTaskMs = Math.max(metrics.maxTaskMs, Math.round(entry.duration));
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
    const timer = setInterval(() => {
      metrics.maxCards = Math.max(
        metrics.maxCards,
        document.querySelectorAll(".film-card[data-film-id]").length,
      );
      setText(JSON.stringify(metrics));
    }, 250);
    return () => {
      observer.disconnect();
      clearInterval(timer);
    };
  }, []);
  return (
    <aside
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        zIndex: 5000,
        background: "#111",
        padding: 4,
        fontSize: 11,
      }}
      aria-label="合成片库验证工具"
    >
      <label>
        <input
          type="checkbox"
          onChange={(event) => {
            slow = event.currentTarget.checked;
          }}
        />
        模拟慢速查询
      </label>
      <button
        onClick={() => {
          failNext = true;
        }}
      >
        下次查询失败
      </button>
      <button
        onClick={() => {
          metrics.longTasks = 0;
          metrics.maxTaskMs = 0;
          metrics.maxCards = 0;
        }}
      >
        重置性能记录
      </button>
      <output aria-label="片库性能记录">{text}</output>
    </aside>
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
          playbackSettings={createPlaybackSettings("browser")}
          backgroundSettings={createBackgroundSettings("browser")}
          logs={createApplicationLogs("browser")}
          {...metadataServices}
          runtime="browser"
          library={library}
          network={network}
          downloads={downloads}
          playback={playback}
        />
      </ImagePreviewProvider>
      <Metrics />
    </MantineProvider>
  </StrictMode>,
);
