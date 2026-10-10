import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Affix,
  AppShell,
  Divider,
  NavLink,
  Notification,
  Text,
  Tooltip,
  Transition,
  UnstyledButton,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { WorkspaceContext } from "./state";
import type { FilmDetailView, Page } from "./state";
import { readPreferences, savePreferences } from "./preferences";
import { BrandMark, Icon } from "../components/icons";
import type { IconName } from "../components/icons";
import { Library } from "../features/library/Library";
import { Discover } from "../features/discover/Discover";
import type { DiscoverHandle } from "../features/discover/Discover";
import type { DownloadService } from "../services/downloads/DownloadService";
import { libraryError } from "../services/library/LibraryService";
import type { LibraryService } from "../services/library/LibraryService";
import { NewDownloadModal } from "../features/downloads/NewDownloadModal";
import { Downloads } from "../features/downloads/Downloads";
import { Scraper } from "../features/resources/Scraper";
import type { ScraperHandle } from "../features/resources/Scraper";
import { Directories } from "../features/directories/Directories";
import { AddMediaDirectoryModal } from "../features/directories/AddMediaDirectoryModal";
import type { AddMediaDirectoryHandle } from "../features/directories/AddMediaDirectoryModal";
import { Settings } from "../features/settings/Settings";
import { FilmDetail } from "../features/films/FilmDetail";
import { WindowControls, WindowDragRegion } from "../platform/neutralino/WindowControls";
import { WindowResizeEdges } from "../platform/neutralino/WindowResizeEdges";
import type { Runtime } from "../platform/neutralino/bootstrap";
import type { PlaybackController } from "../services/playback/PlaybackService";
import { playbackError } from "../services/playback/PlaybackService";
import type { PlaybackOptions } from "../services/playback/source";
import type { NetworkSettingsService } from "../services/network/NetworkSettingsService";
import type { PlaybackSettingsService } from "../services/playback/PlaybackSettingsService";
import type { AiService } from "../services/metadata/AiService";
import type { MetaTubeService } from "../services/metadata/MetaTubeService";
import type { BackgroundSettingsService } from "../services/settings/BackgroundSettingsService";
import type { LogService } from "../services/logging/LogService";
import { logEvent } from "../services/logging/events";
import type { LegacyImportService } from "../services/library/LegacyImportService";
import type { ScrapeService } from "../services/scraping/ScrapeService";
import type { ResolutionService } from "../services/streamResolution/ResolutionService";
import type { ResourceSearchService } from "../services/streamResolution/ResourceSearchService";
import type { Film } from "../contracts/media";
import { LegacyImportModal } from "../features/library/LegacyImportModal";
import { listenApplicationLaunches } from "../platform/neutralino/applicationInstance";

const PlaybackWindow = lazy(() => import("../features/player/PlaybackWindow"));

const pages: { id: Page; title: string; short: string; icon: IconName }[] = [
  { id: "library", title: "媒体库", short: "片库", icon: "grid" },
  { id: "discover", title: "发现", short: "发现", icon: "compass" },
  { id: "downloads", title: "下载管理", short: "下载", icon: "download" },
  { id: "scraper", title: "资源刮削", short: "刮削", icon: "globe" },
  { id: "directories", title: "目录管理", short: "目录", icon: "folder" },
  { id: "settings", title: "系统设置", short: "设置", icon: "settings" },
];

export function App({
  runtime,
  downloads,
  library,
  legacyImport,
  playback,
  network,
  playbackSettings,
  backgroundSettings,
  logs,
  ai,
  metatube,
  scraping,
  resolution,
  resourceSearch,
}: {
  runtime: Runtime;
  downloads: DownloadService;
  library: LibraryService;
  legacyImport?: LegacyImportService;
  playback: PlaybackController;
  network: NetworkSettingsService;
  playbackSettings: PlaybackSettingsService;
  backgroundSettings: BackgroundSettingsService;
  logs: LogService;
  ai: AiService;
  metatube: MetaTubeService;
  scraping?: ScrapeService;
  resolution?: ResolutionService;
  resourceSearch?: ResourceSearchService;
}) {
  const [page, setPageState] = useState<Page>("library");
  const [visited, setVisited] = useState(() => new Set<Page>(["library"]));
  const setPage = useCallback((next: Page) => {
    setVisited((previous) => (previous.has(next) ? previous : new Set([...previous, next])));
    setPageState(next);
  }, []);
  const pendingNavigation = useRef<(() => void) | null>(null);
  const mounted = (target: Page) => page === target || visited.has(target);
  const { setColorScheme } = useMantineColorScheme();
  const theme = useComputedColorScheme("dark");
  const libraryState = useSyncExternalStore(library.subscribe, library.getSnapshot);
  const playbackState = useSyncExternalStore(playback.subscribe, playback.getSnapshot);
  const [preferences, setPreferences] = useState(readPreferences);
  const detail = libraryState.selectedFilm;
  const filmId = detail?.id ?? null;
  const [detailView, setDetailView] = useState<FilmDetailView>("info");
  const [toast, setToast] = useState("");
  const [downloadOpened, setDownloadOpened] = useState(false);
  const [downloadInitial, setDownloadInitial] = useState<{ url: string; name: string }>();
  const [downloadFilm, setDownloadFilm] = useState<Film | undefined>();
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const scraperRef = useRef<ScraperHandle>(null);
  const discoverRef = useRef<DiscoverHandle>(null);
  const directoryModalRef = useRef<AddMediaDirectoryHandle>(null);
  const detailOriginRef = useRef<HTMLElement | null>(null);
  const collapsed = preferences.navCollapsed;
  const current = pages.find((item) => item.id === page)!;
  const notice = (message: string) => {
    setToast(message);
    logEvent("info", "ui", "notice", message);
  };
  useEffect(() => {
    if (runtime !== "desktop" || !libraryState.ready) return;
    return listenApplicationLaunches(
      async (action) => {
        if (action.kind === "work") {
          await library.openWork(action.id);
          setDetailView("info");
        }
        if (action.kind === "search") {
          const select = () => scraperRef.current?.showSearch(action.code);
          if (scraperRef.current) select();
          else pendingNavigation.current = select;
          setPage("scraper");
        }
        if (action.kind === "download") {
          setDownloadFilm(undefined);
          setDownloadInitial(action);
          setDownloadOpened(true);
        }
      },
      (message) => setToast(message),
    );
  }, [runtime, libraryState.ready, library, resourceSearch, setPage]);
  const playSource = (source: string, options?: PlaybackOptions) => {
    library.selectFilm(null);
    void playback.play(source, options).catch((error: unknown) => notice(playbackError(error)));
  };
  const unavailable = (feature: string) => notice(`${feature}暂未接入`);
  const changePreference = (value: Partial<typeof preferences>) => {
    const next = { ...preferences, ...value };
    setPreferences(next);
    if (!savePreferences(next)) notice("偏好已在本次会话生效，本地存储不可用");
  };
  useHotkeys([["mod+B", () => changePreference({ navCollapsed: !collapsed })]]);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [page]);
  useLayoutEffect(() => {
    pendingNavigation.current?.();
    pendingNavigation.current = null;
  }, [page]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 5500);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useLayoutEffect(() => {
    if (filmId !== null || !detailOriginRef.current) return;
    const origin = detailOriginRef.current;
    (origin.isConnected && origin.getClientRects().length ? origin : mainRef.current)?.focus({
      preventScroll: true,
    });
    detailOriginRef.current = null;
  }, [filmId]);
  const add = (kind: "import" | "download", film?: Film) => {
    if (kind === "import") {
      directoryModalRef.current?.open();
      return;
    }
    setDownloadFilm(film);
    library.selectFilm(null);
    setDownloadOpened(true);
  };
  const navItem = (item: (typeof pages)[number]) =>
    collapsed ? (
      <UnstyledButton
        key={item.id}
        className="rail-item"
        data-active={page === item.id || undefined}
        aria-current={page === item.id ? "page" : undefined}
        onClick={() => setPage(item.id)}
      >
        <Icon name={item.icon} size={20} />
        <span>{item.short}</span>
      </UnstyledButton>
    ) : (
      <NavLink
        key={item.id}
        component="button"
        type="button"
        active={page === item.id}
        aria-current={page === item.id ? "page" : undefined}
        label={item.title}
        leftSection={<Icon name={item.icon} size={18} />}
        onClick={() => setPage(item.id)}
        variant="light"
        className="nav-item"
      />
    );
  const groupLabel = (text: string) =>
    collapsed ? <Divider className="rail-divider" /> : <Text className="nav-label">{text}</Text>;
  return (
    <WorkspaceContext.Provider
      value={{
        page,
        go: setPage,
        library,
        legacyImport,
        libraryState,
        toggleFavorite: (film) => {
          void library.toggleFavorite(film).catch((error: unknown) => notice(libraryError(error)));
        },
        downloads,
        network,
        playbackSettings,
        backgroundSettings,
        logs,
        ai,
        metatube,
        scraping,
        resolution,
        resourceSearch,
        showScrapeQueue: () => {
          if (scraperRef.current) scraperRef.current.showQueue();
          else pendingNavigation.current = () => scraperRef.current?.showQueue();
          setPage("scraper");
        },
        openFilm: (film, view = "info") => {
          detailOriginRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          library.selectFilm(film);
          setDetailView(view);
        },
        play: (film) => {
          const file = film.files?.find((item) => item.kind === "video" && !item.missing);
          if (file)
            playSource(file.streamUrl ?? file.path, {
              title: `${film.code} ${film.title}`.trim(),
              subtitles: file.subtitles,
            });
          else notice("这部影片尚未关联可播放的视频文件。");
        },
        playSource,
        scrape: (film, view = "match") => {
          if (view === "match" && scraping)
            void scraping
              .enqueue({ workId: String(film.id), name: film.title })
              .catch((error: unknown) => notice(libraryError(error)));
          if (scraperRef.current) scraperRef.current.select(film, view);
          else pendingNavigation.current = () => scraperRef.current?.select(film, view);
          setPage("scraper");
        },
        browseFacet: (facet, value) => {
          if (discoverRef.current) discoverRef.current.select(facet, value);
          else pendingNavigation.current = () => discoverRef.current?.select(facet, value);
          setPage("discover");
        },
        notice,
        unavailable,
        theme,
        setTheme: setColorScheme,
        runtime,
        cardClickToPlay: preferences.cardClickToPlay,
        setCardClickToPlay: (value) => changePreference({ cardClickToPlay: value }),
        add,
      }}
    >
      {legacyImport && <LegacyImportModal service={legacyImport} />}
      <AppShell
        header={{ height: 34 }}
        navbar={{ width: collapsed ? 72 : 208, breakpoint: 0 }}
        padding={0}
        transitionDuration={160}
        className="app-window"
      >
        <AppShell.Header className="titlebar">
          <Tooltip label={`${collapsed ? "展开" : "折叠"}导航 (Ctrl+B)`} position="bottom-start">
            <UnstyledButton
              className="window-button nav-toggle"
              aria-label={collapsed ? "展开导航" : "折叠导航"}
              aria-expanded={!collapsed}
              aria-controls="main-navigation"
              onClick={() => changePreference({ navCollapsed: !collapsed })}
            >
              <Icon name="sidebar" size={16} />
            </UnstyledButton>
          </Tooltip>
          <WindowDragRegion runtime={runtime} notice={notice}>
            <BrandMark />
            <Text span fz={12} fw={600}>
              JAVM
            </Text>
            <Text span fz={11} c="dimmed">
              我的片库
            </Text>
          </WindowDragRegion>
          <WindowControls runtime={runtime} notice={notice} />
        </AppShell.Header>
        <AppShell.Navbar className="sidebar" data-collapsed={collapsed || undefined}>
          <AppShell.Section grow component="nav" id="main-navigation" aria-label="主导航">
            {groupLabel("浏览")}
            {pages.slice(0, 2).map(navItem)}
            {groupLabel("工作台")}
            {pages.slice(2, 5).map(navItem)}
          </AppShell.Section>
          <AppShell.Section>{navItem(pages[5]!)}</AppShell.Section>
        </AppShell.Navbar>
        <AppShell.Main>
          <div
            className="page-content"
            ref={mainRef}
            id="main-content"
            tabIndex={-1}
            aria-label={`${current.title}内容`}
          >
            <section hidden={page !== "library"}>
              <Library searchRef={searchRef} />
            </section>
            <section hidden={page !== "discover"}>
              {mounted("discover") && <Discover ref={discoverRef} />}
            </section>
            <section hidden={page !== "downloads"} className="fill-page">
              {mounted("downloads") && <Downloads />}
            </section>
            <section hidden={page !== "scraper"} className="fill-page">
              {mounted("scraper") && <Scraper ref={scraperRef} />}
            </section>
            <section hidden={page !== "directories"}>
              {mounted("directories") && <Directories />}
            </section>
            <section hidden={page !== "settings"}>{mounted("settings") && <Settings />}</section>
          </div>
        </AppShell.Main>
      </AppShell>
      {runtime === "desktop" && <WindowResizeEdges notice={notice} />}
      <FilmDetail
        key={`${filmId}:${detailView}`}
        film={detail}
        initialView={detailView}
        onClose={() => library.selectFilm(null)}
      />
      {downloadOpened && (
        <NewDownloadModal
          key={downloadInitial?.url ?? "manual"}
          opened
          film={downloadFilm}
          initial={downloadInitial}
          onClose={() => {
            setDownloadOpened(false);
            setDownloadInitial(undefined);
          }}
        />
      )}
      <AddMediaDirectoryModal ref={directoryModalRef} runtime={runtime} />
      {runtime === "browser" && playbackState.opened && (
        <Suspense fallback={null}>
          <PlaybackWindow service={playback} snapshot={playbackState} notice={notice} />
        </Suspense>
      )}
      <Affix position={{ bottom: 24, right: 24 }} zIndex={500}>
        <Transition mounted={!!toast} transition="slide-up" duration={180}>
          {(style) => (
            <Notification
              style={style}
              w="min(340px, calc(100vw - 48px))"
              withBorder
              icon={<Icon name="info" size={16} />}
              onClose={() => setToast("")}
              closeButtonProps={{ "aria-label": "关闭提示" }}
              aria-live="polite"
            >
              {toast}
            </Notification>
          )}
        </Transition>
      </Affix>
    </WorkspaceContext.Provider>
  );
}
