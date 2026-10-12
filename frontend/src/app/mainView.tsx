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
import { nativeSettingsStorage } from "../platform/neutralino/settingsStorage";
import { createArtworkService } from "../platform/neutralino/artwork";
import type { ResourcePreferences } from "../services/streamResolution/archive";
import { createApplicationUpdater } from "../platform/neutralino/applicationUpdates";
import { initializeMainWindowSize } from "../platform/neutralino/mainWindowSize";
import { shutdownHttp } from "../platform/neutralino/http";
import { createImageSources } from "../platform/neutralino/imageSources";
import { ImageSourcesProvider } from "../components/ImageSources";
import { LibraryBackupService } from "../services/library/LibraryBackupService";
import { isRunning } from "../contracts/downloads";
import { activeScrape } from "../contracts/scraping";

export function createMainView(runtime: Runtime) {
  const logs = createApplicationLogs(runtime);
  if (runtime === "desktop") initializeMainWindowSize();
  const network = createNetworkSettings(runtime);
  const updater = createApplicationUpdater(runtime, network);
  const backgroundSettings = createBackgroundSettings(runtime);
  const downloads = createDownloadService(runtime, network);
  const images = createImageSources(runtime, network, () => downloads.initialize());
  const resolution = createResolutionService(runtime, network, () => downloads.initialize());
  const catalog = createDiscoveryCatalogService(runtime, network, () => downloads.initialize());
  const library = createLibraryService(runtime, catalog);
  const resourcePreferences = nativeSettingsStorage<ResourcePreferences>("resource-search-v1");
  const resourceSearch = new ResourceSearchService(
    resolution,
    {
      add: (input) => downloads.add(input),
      directory: () => downloads.getSnapshot().settings.directory,
    },
    undefined,
    runtime === "desktop"
      ? {
          read: (code, workId) => library.readResources(code, workId),
          save: (record) => library.saveResource(record),
          remove: (id) => library.removeResource(id),
          readPreferences: () => resourcePreferences.read(),
          writePreferences: (value) => resourcePreferences.write(value),
        }
      : undefined,
  );
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
  library.artwork = createArtworkService(
    runtime,
    library,
    metadata.metatube,
    network,
    () => downloads.getSnapshot().settings.ffmpegPath,
    images,
  );
  const scraping = createScrapeService(
    runtime,
    metadata.metatube,
    network,
    library,
    () => downloads.initialize(),
    metadata.ai,
  );
  downloads.connectScraping(scraping.enqueueDownload);
  library.backups = new LibraryBackupService(
    runtime === "desktop" ? new NativeLibraryPort() : undefined,
    async (operation) => {
      await downloads.initialize();
      await library.initialize();
      await scraping.initialize();
      const tasks = downloads.getSnapshot().tasks;
      const maintenance = library.maintenance?.getSnapshot().phase;
      if (
        tasks.some((task) => task.status === "queued" || isRunning(task.status)) ||
        scraping.getSnapshot().tasks.some(activeScrape) ||
        legacyImport.getSnapshot().state === "running" ||
        maintenance === "reading" ||
        maintenance === "cleaning" ||
        library.hasPendingWrites() ||
        downloads.hasPendingHandoffs() ||
        library.artwork?.getSnapshot().busy ||
        library.documents?.getSnapshot().running ||
        library.organization?.getSnapshot().busy ||
        library.organization?.getSnapshot().pending.length ||
        library.getSnapshot().scan?.state === "scanning"
      )
        throw new Error("请先暂停下载，并等待扫描、刮削、图片和文件任务完成后再备份或恢复。");
      if (operation === "restore") await playback.close();
    },
    async () => {
      library.selectFilm(null);
      await library.refreshAfterRestore();
    },
  );
  downloads.connectFileRename((task, pending) =>
    scraping.relocateDownload(task.id, task.output, pending.output, async () => {
      if (!library.organization) throw new Error("文件整理服务不可用。");
      await library.organization.renameDownloaded(task.output, pending.output, pending.operationId);
    }),
  );
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
      await updater.shutdown();
      await library.artwork?.shutdown();
      await images.shutdown();
      await resourceSearch.shutdown();
      await resolution.shutdown();
      await scraping.shutdown();
      await legacyImport.shutdown();
      await catalog.shutdown();
      await network.shutdown();
      await playback.shutdown();
      await metadata.ai.shutdown();
      await metadata.metatube.shutdown();
      await shutdownHttp();
      await library.shutdown();
    });
  return (
    <ImageSourcesProvider value={images}>
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
    </ImageSourcesProvider>
  );
}
