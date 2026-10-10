import { App } from "./App";
import { ImagePreviewProvider } from "../components/ImagePreview";
import type { Runtime } from "../platform/neutralino/bootstrap";
import { createDownloadService } from "../platform/neutralino/downloads";
import { initializeLifecycle } from "../platform/neutralino/lifecycle";
import { createLibraryService } from "../platform/neutralino/library";
import { createPlaybackService } from "../platform/neutralino/playback";
import { createNetworkSettings } from "../platform/neutralino/network";
import { createPlaybackSettings } from "../platform/neutralino/playbackSettings";
import { createMetadataServices } from "../platform/neutralino/metadataServices";
import { createBackgroundSettings } from "../platform/neutralino/backgroundSettings";
import { createApplicationLogs } from "../platform/neutralino/logging";
import { observeLogState } from "../services/logging/observe";
import { NativeLibraryPort } from "../platform/neutralino/library";
import { LegacyImportService } from "../services/library/LegacyImportService";
import { createDiscoveryCatalogService } from "../platform/neutralino/discoveryCatalog";
import { createScrapeService } from "../platform/neutralino/scraping";
import { createResolutionService } from "../platform/neutralino/streamResolution";
import { ResourceSearchService } from "../services/streamResolution/ResourceSearchService";

export function createMainView(runtime: Runtime) {
  const logs = createApplicationLogs(runtime);
  const network = createNetworkSettings(runtime);
  const backgroundSettings = createBackgroundSettings(runtime);
  const downloads = createDownloadService(runtime, network);
  const resolution = createResolutionService(runtime, network, () => downloads.initialize());
  const resourceSearch = new ResourceSearchService(resolution, {
    add: (input) => downloads.add(input),
    directory: () => downloads.getSnapshot().settings.directory,
  });
  const catalog = createDiscoveryCatalogService(runtime, network, () => downloads.initialize());
  const library = createLibraryService(runtime, catalog);
  const legacyImport = new LegacyImportService(
    runtime === "desktop" ? new NativeLibraryPort() : undefined,
    () => library.refreshAfterImport(),
  );
  void legacyImport.initialize();
  observeLogState("database", legacyImport, (value) => ({
    state: `旧库导入 ${value.state}${value.state === "running" ? ` ${value.phase ?? "preparing"}` : ""}`,
    error: value.error || value.warning,
  }));
  const playback = createPlaybackService(runtime);
  // 首次资料请求启动 MetaTube 前，先等待旧进程回收完成。
  const metadata = createMetadataServices(runtime, network, () => downloads.initialize());
  const scraping = createScrapeService(runtime, metadata.metatube, network, library, () =>
    downloads.initialize(),
  );
  downloads.connectScraping(scraping.enqueueDownload);
  observeLogState("library", library, (value) => ({
    state: value.scan ? `扫描 ${value.scan.state}` : value.ready ? "媒体库就绪" : "正在读取媒体库",
    error:
      value.error ||
      value.scan?.issues
        .slice(-3)
        .map((issue) => issue.message)
        .join("；"),
    context: value.scan
      ? { taskId: value.scan.id, processed: value.scan.processed, errors: value.scan.errors }
      : undefined,
  }));
  observeLogState("network", network, (value) => ({
    state: value.testing ? "代理测试开始" : (value.testResult?.status ?? "网络设置就绪"),
    error: value.error || (value.testResult?.status === "failed" ? value.testResult.message : ""),
  }));
  observeLogState("catalog", catalog, (value) => ({
    state: value.updating ? "发现名单更新中" : "发现名单就绪",
    error: Object.values(value.errors).filter(Boolean).join("；") || value.warning,
  }));
  observeLogState("ai", metadata.ai, (value) => ({
    state: value.busy ? value.action : "AI 请求结束",
    error: value.error,
  }));
  observeLogState("metatube", metadata.metatube, (value) => ({
    state: `${value.status}${value.querying ? " 查询中" : ""}`,
    error: value.error,
  }));
  observeLogState("settings", backgroundSettings, (value) => ({
    state: value.runInBackground ? "关闭窗口后后台运行" : "关闭窗口后退出",
    error: value.error,
  }));
  if (runtime === "desktop")
    initializeLifecycle(downloads, backgroundSettings, async () => {
      await resourceSearch.shutdown();
      await resolution.shutdown();
      await scraping.shutdown();
      await legacyImport.shutdown();
      await catalog.shutdown();
      await network.shutdown();
      await playback.shutdown();
      await metadata.ai.shutdown();
      await metadata.metatube.shutdown();
      await library.shutdown();
    });
  return (
    <ImagePreviewProvider>
      <App
        runtime={runtime}
        downloads={downloads}
        resolution={resolution}
        resourceSearch={resourceSearch}
        scraping={scraping}
        library={library}
        legacyImport={legacyImport}
        playback={playback}
        network={network}
        playbackSettings={createPlaybackSettings(runtime)}
        backgroundSettings={backgroundSettings}
        logs={logs}
        {...metadata}
      />
    </ImagePreviewProvider>
  );
}
