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
import { observeLibraryScan } from "../services/logging/libraryScan";
import { playbackReproduction } from "../services/playback/source";
import { NativeLibraryPort } from "../platform/neutralino/library";
import { LegacyImportService } from "../services/library/LegacyImportService";
import { createDiscoveryCatalogService } from "../platform/neutralino/discoveryCatalog";
import { createScrapeService } from "../platform/neutralino/scraping";
import { createResolutionService } from "../platform/neutralino/streamResolution";
import { createMagnetSearch } from "../platform/neutralino/magnetSearch";
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
import { createLibraryLayoutSettings } from "../platform/neutralino/libraryLayout";
import { createUiPreferences } from "./preferences";
import { createApplicationFeedback } from "../platform/neutralino/feedback";
import { createApplicationAnalytics, shutdownAnalytics } from "../platform/neutralino/analytics";

export function createMainView(runtime: Runtime) {
  const logs = createApplicationLogs(runtime);
  const layoutSettings = createLibraryLayoutSettings(runtime);
  observeLogState("settings", layoutSettings, (value) => ({
    state: "片库显示设置",
    error: value.error,
  }));
  const playbackSettings = createPlaybackSettings(runtime);
  observeLogState("settings", playbackSettings, (value) => ({
    state: "播放设置",
    error: value.error,
  }));
  if (runtime === "desktop") void initializeMainWindowSize();
  const network = createNetworkSettings(runtime);
  createApplicationAnalytics(runtime, network);
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
    createMagnetSearch(runtime, network, () => downloads.initialize()),
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
  observeLogState("playback", playback, (value) => ({
    state: value.preparing ? "准备播放" : value.opened ? "播放中" : "播放已关闭",
    error: value.error,
    reproduction: playbackReproduction(value.request),
  }));
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
  // 片库就绪时与每次扫描结束后，为没有封面的作品自动截帧。
  if (library.autoCover) {
    const autoCover = library.autoCover;
    let ready = false,
      scanning = false;
    const check = () => {
      const snapshot = library.getSnapshot();
      const now = snapshot.scan?.state === "scanning";
      if (snapshot.ready && !snapshot.error && (!ready || (scanning && !now)) && !now)
        autoCover.schedule();
      if (snapshot.ready) ready = true;
      scanning = now;
    };
    library.subscribe(check);
    check();
    observeLogState("artwork", autoCover, (value) => ({
      state: value.running ? "自动封面运行中" : "自动封面空闲",
      error: value.error,
    }));
  }
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
    state: value.ready ? "媒体库就绪" : "正在读取媒体库",
    error: value.error,
    context: value.scan ? { taskId: value.scan.id } : undefined,
  }));
  observeLibraryScan(library);
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
  observeLogState("updates", updater, (value) => ({
    state: value.checking ? "检查更新中" : value.status.phase,
    error:
      value.error ||
      (["failed", "rolled-back"].includes(value.status.phase) ? value.status.error : ""),
  }));
  observeLogState("backup", library.backups, (value) => ({
    state: `${value.operation ?? ""} ${value.state}`,
    error: value.state === "failed" ? value.error || "备份或恢复失败" : "",
    context: value.id ? { taskId: value.id } : undefined,
  }));
  observeLogState("scraping", scraping, (value) => ({
    state: value.paused ? "刮削队列已暂停" : "刮削队列就绪",
    error: value.error,
  }));
  if (library.documents)
    observeLogState("library", library.documents, (value) => ({
      state: value.running ? `资料文件 ${value.mode} 中` : "资料文件处理结束",
      error:
        !value.running && !value.cancelled
          ? value.error || value.failures.slice(-3).join("；")
          : "",
      context: { failed: value.failed, processed: value.processed },
    }));
  if (library.maintenance)
    observeLogState("library", library.maintenance, (value) => ({
      state: `片库检查清理 ${value.phase}`,
      error:
        value.phase !== "cleaning" && !value.cancelling ? value.failures.slice(-3).join("；") : "",
    }));
  if (library.watcher)
    observeLogState("library", library.watcher, (value) => ({
      state: value.enabled ? "目录监视启用" : "目录监视关闭",
      error: value.error,
    }));
  observeLogState("resolution", resourceSearch, (value) => ({
    state: value.searching ? "资源搜索中" : "资源搜索结束",
    error: value.storageError || (!value.searching && !value.cancelled ? value.error : ""),
  }));
  observeLogState("resolution", resolution, (value) => ({
    state: value.cleanupPending ? "资源解析等待清理" : "资源解析就绪",
  }));
  if (resourceSearch.magnets)
    observeLogState("magnets", resourceSearch.magnets, (value) => ({
      state: value.searching ? "磁力搜索中" : "磁力搜索结束",
      error:
        !value.searching && !value.cancelled
          ? value.error ||
            value.sources
              .filter((source) => source.state === "failed")
              .map((source) => `${source.id}: ${source.error}`)
              .join("；")
          : "",
    }));
  if (runtime === "desktop")
    initializeLifecycle(downloads, backgroundSettings, async () => {
      await createUiPreferences(runtime).flush();
      await layoutSettings.flush();
      await updater.shutdown();
      await library.artwork?.shutdown();
      await images.shutdown();
      await resourceSearch.shutdown();
      await resolution.shutdown();
      await scraping.shutdown();
      await legacyImport.shutdown();
      await catalog.shutdown();
      await playback.shutdown();
      await metadata.ai.shutdown();
      await metadata.metatube.shutdown();
      await shutdownAnalytics();
      await network.shutdown();
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
          playbackSettings={playbackSettings}
          backgroundSettings={backgroundSettings}
          logs={logs}
          feedback={createApplicationFeedback(runtime)}
          {...metadata}
        />
      </ImagePreviewProvider>
    </ImageSourcesProvider>
  );
}
