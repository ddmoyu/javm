import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Collapse,
  Drawer,
  MantineProvider,
  Modal,
  Textarea,
  TextInput,
  Tooltip,
  createTheme,
} from "@mantine/core";
import { sampleDownloads, sampleFilms } from "./data";
import type { DownloadTask, Film } from "./data";
import { PrototypeContext } from "./state";
import type { FilmDetailView, Page } from "./state";
import { Icon } from "./visuals";
import type { IconName } from "./visuals";
import { Pill } from "./ui";
import { Library } from "./Library";
import { Discover } from "./Discover";
import type { DiscoverHandle } from "./Discover";
import { FilmDetail } from "./FilmDetail";
import { Downloads } from "./Workflows";
import { Scraper } from "./Scraper";
import type { ScraperHandle } from "./Scraper";
import { Directories, Settings } from "./Supporting";
import { PlayerWindows } from "./PlayerWindows";
import type { PlayerWindowsHandle } from "./PlayerWindows";

const theme = createTheme({
  primaryColor: "rose",
  primaryShade: 6,
  defaultRadius: "md",
  fontFamily: '"Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", sans-serif',
  fontSizes: { xs: "12px", sm: "13px", md: "14px", lg: "16px", xl: "19px" },
  headings: {
    fontFamily: '"Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", sans-serif',
    fontWeight: "650",
  },
  colors: {
    rose: [
      "#fff0f3",
      "#ffdde5",
      "#ffbccd",
      "#fb95b0",
      "#f36e92",
      "#e54b77",
      "#cd315d",
      "#b2254f",
      "#942044",
      "#781d3a",
    ],
    dark: [
      "#f0e9ed",
      "#d6cbd2",
      "#a79da6",
      "#81767f",
      "#453c45",
      "#342d35",
      "#272229",
      "#201c23",
      "#171419",
      "#100e12",
    ],
  },
  components: {
    Button: Button.extend({ defaultProps: { size: "sm", radius: "md" } }),
    TextInput: TextInput.extend({ defaultProps: { size: "sm", radius: "md" } }),
    Modal: Modal.extend({
      defaultProps: {
        overlayProps: { backgroundOpacity: 0.6, blur: 3 },
        radius: "lg",
        closeButtonProps: { "aria-label": "关闭对话框" },
      },
    }),
    Drawer: Drawer.extend({ defaultProps: { closeButtonProps: { "aria-label": "关闭面板" } } }),
  },
});
const pages: { id: Page; title: string; icon: IconName }[] = [
  { id: "library", title: "媒体库", icon: "library" },
  { id: "discover", title: "发现", icon: "compass" },
  { id: "downloads", title: "下载管理", icon: "download" },
  { id: "scraper", title: "资源刮削", icon: "scan" },
  { id: "directories", title: "目录管理", icon: "folder" },
  { id: "settings", title: "系统设置", icon: "settings" },
];

export function Prototype() {
  // 原型状态仅保存在内存。组件独立于挂载入口，让 Fast Refresh 保留交互现场。
  const [page, setPage] = useState<Page>("library");
  const [colorScheme, setColorScheme] = useState<"dark" | "light">("dark");
  const [films, setFilms] = useState<Film[]>(sampleFilms);
  const [tasks, setTasks] = useState<DownloadTask[]>(sampleDownloads);
  const [query, setQuery] = useState("");
  const [filmId, setFilmId] = useState<number | null>(null);
  const [detailView, setDetailView] = useState<FilmDetailView>("info");
  const [toast, setToast] = useState("");
  const [addKind, setAddKind] = useState<"import" | "download" | null>(null);
  const [links, setLinks] = useState("");
  const [path, setPath] = useState("D:\\Media\\Library");
  const [extra, setExtra] = useState(false);
  const [error, setError] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.matchMedia("(max-width: 850px)").matches,
  );
  const [maximized, setMaximized] = useState(false);
  const [windowState, setWindowState] = useState<"visible" | "minimized" | "tray" | "closed">(
    "visible",
  );
  const [closeToTray, setCloseToTray] = useState(true);
  const [cardClickToPlay, setCardClickToPlay] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const playersRef = useRef<PlayerWindowsHandle>(null);
  const scraperRef = useRef<ScraperHandle>(null);
  const discoverRef = useRef<DiscoverHandle>(null);
  const detailOriginRef = useRef<HTMLElement | null>(null);
  const detail = films.find((film) => film.id === filmId) ?? null;
  const current = pages.find((item) => item.id === page)!;
  useLayoutEffect(() => {
    if (filmId !== null || !detailOriginRef.current) return;
    const origin = detailOriginRef.current;
    if (origin.isConnected && origin.getClientRects().length) origin.focus({ preventScroll: true });
    else if (page === "library") searchRef.current?.focus({ preventScroll: true });
    else mainRef.current?.focus({ preventScroll: true });
    detailOriginRef.current = null;
  }, [filmId, page]);
  const notice = (message: string) => setToast(message);
  const go = (value: Page) => setPage(value);
  const add = (kind: "import" | "download") => {
    setAddKind(kind);
    setError("");
    setExtra(false);
    setLinks("");
    setPath(kind === "import" ? "D:\\Media\\Library" : "D:\\Media\\Downloads");
  };
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [page]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 5500);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const submit = () => {
    if (addKind === "download") {
      const lines = links
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (!lines.length || lines.some((line) => !/^(https?:\/\/|magnet:\?)/i.test(line))) {
        setError("请粘贴有效的 http、https 或磁力链接，每行一条。");
        return;
      }
      const firstId = Math.max(0, ...tasks.map((task) => task.id)) + 1;
      setTasks((previous) => [
        ...previous,
        ...lines.map((_, i) => ({
          id: firstId + i,
          filmId: 1,
          name: `新建下载 ${firstId + i}`,
          status: "queued" as const,
          progress: 0,
          path,
        })),
      ]);
      notice(`已加入 ${lines.length} 个下载任务`);
      setPage("downloads");
    } else {
      if (!path.trim()) {
        setError("请先选择一个媒体目录。");
        return;
      }
      const id = Math.max(0, ...films.map((film) => film.id)) + 1;
      setFilms((previous) => [
        ...previous,
        {
          ...sampleFilms[0]!,
          id,
          code: `JVM-${String(id).padStart(3, "0")}`,
          title: "新入库影片",
          english: "A NEW COLLECTION",
          rating: undefined,
          missing: true,
          favorite: false,
        },
      ]);
      notice("已导入 1 部影片");
      setPage("library");
      setQuery("");
    }
    setAddKind(null);
  };
  return (
    <MantineProvider theme={theme} forceColorScheme={colorScheme}>
      <PrototypeContext.Provider
        value={{
          page,
          go,
          films,
          setFilms,
          tasks,
          setTasks,
          query,
          setQuery,
          openFilm: (film, view = "info") => {
            const origin =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            const cardOrigin = document.querySelector<HTMLElement>(
              `[data-film-id="${film.id}"] .film-card-open, tr[data-film-id="${film.id}"]`,
            );
            detailOriginRef.current = cardOrigin?.getClientRects().length
              ? cardOrigin
              : origin === document.body
                ? mainRef.current
                : origin;
            setFilmId(film.id);
            setDetailView(view);
          },
          play: (film) => playersRef.current?.open(film),
          scrape: (film, view = "match") => {
            scraperRef.current?.select(film, view);
            setPage("scraper");
          },
          browseFacet: (facet, value) => {
            discoverRef.current?.select(facet, value);
            setPage("discover");
          },
          notice,
          theme: colorScheme,
          setTheme: setColorScheme,
          closeToTray,
          setCloseToTray,
          cardClickToPlay,
          setCardClickToPlay,
          add,
        }}
      >
        {windowState !== "visible" && (
          <div className="window-preview-state">
            <span className="brand-mark">
              <Icon name="play" size={26} />
            </span>
            <h2>
              {windowState === "minimized"
                ? "窗口已最小化"
                : windowState === "closed"
                  ? "窗口已关闭"
                  : "窗口已收起到托盘"}
            </h2>
            <Button onClick={() => setWindowState("visible")}>恢复窗口</Button>
          </div>
        )}
        <div
          className={`app-window ${maximized ? "is-maximized" : ""}`}
          hidden={windowState !== "visible"}
        >
          <div className="window-titlebar">
            <button
              type="button"
              className="window-drag-region"
              aria-label="JAVM 标题栏，双击切换最大化"
              onDoubleClick={() => setMaximized(!maximized)}
            >
              <span className="titlebar-mark" />
              JAVM<span className="titlebar-subtitle">我的片库</span>
            </button>
            <div className="window-controls">
              <button
                type="button"
                title="最小化"
                aria-label="最小化窗口"
                onClick={() => setWindowState("minimized")}
              >
                <Icon name="minimize" size={14} />
              </button>
              <button
                type="button"
                title={maximized ? "还原" : "最大化"}
                aria-label={maximized ? "还原窗口" : "最大化窗口"}
                onClick={() => setMaximized(!maximized)}
              >
                <Icon name={maximized ? "restore" : "maximize"} size={13} />
              </button>
              <button
                type="button"
                className="window-close"
                title={closeToTray ? "关闭到托盘" : "关闭窗口"}
                aria-label={closeToTray ? "关闭窗口到托盘" : "关闭窗口"}
                onClick={() => setWindowState(closeToTray ? "tray" : "closed")}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          </div>
          <div className="prototype-shell">
            <aside className={`sidebar ${sidebarCollapsed ? "is-collapsed" : ""}`}>
              <Tooltip
                label={sidebarCollapsed ? "展开导航" : "折叠导航"}
                position="right"
                offset={10}
                openDelay={250}
                events={{ hover: true, focus: true, touch: false }}
                withArrow
              >
                <button
                  type="button"
                  className="sidebar-toggle"
                  aria-label={sidebarCollapsed ? "展开导航" : "折叠导航"}
                  aria-expanded={!sidebarCollapsed}
                  aria-controls="main-navigation"
                  onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                >
                  <Icon name="chevron" size={14} />
                </button>
              </Tooltip>
              <div className="sidebar-content">
                <nav id="main-navigation" aria-label="主导航">
                  <span className="nav-label">浏览</span>
                  {pages.slice(0, 2).map((item) => (
                    <Tooltip
                      key={item.id}
                      label={item.title}
                      disabled={!sidebarCollapsed}
                      position="right"
                      withArrow
                    >
                      <button
                        type="button"
                        className={`nav-item ${page === item.id ? "active" : ""}`}
                        aria-current={page === item.id ? "page" : undefined}
                        aria-label={item.title}
                        onClick={() => go(item.id)}
                      >
                        <Icon name={item.icon} />
                        <span>{item.title}</span>
                      </button>
                    </Tooltip>
                  ))}
                  <span className="nav-label workspace-group">工作台</span>
                  {pages.slice(2, 5).map((item) => (
                    <Tooltip
                      key={item.id}
                      label={item.title}
                      disabled={!sidebarCollapsed}
                      position="right"
                      withArrow
                    >
                      <button
                        type="button"
                        className={`nav-item ${page === item.id ? "active" : ""}`}
                        aria-current={page === item.id ? "page" : undefined}
                        aria-label={item.title}
                        onClick={() => go(item.id)}
                      >
                        <Icon name={item.icon} />
                        <span>{item.title}</span>
                      </button>
                    </Tooltip>
                  ))}
                </nav>
                <div className="sidebar-bottom">
                  <Tooltip label="系统设置" disabled={!sidebarCollapsed} position="right" withArrow>
                    <button
                      type="button"
                      className={`nav-item ${page === "settings" ? "active" : ""}`}
                      aria-label="系统设置"
                      aria-current={page === "settings" ? "page" : undefined}
                      onClick={() => go("settings")}
                    >
                      <Icon name="settings" />
                      <span>系统设置</span>
                    </button>
                  </Tooltip>
                </div>
              </div>
            </aside>
            <div className="main-shell">
              <main
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
                  <Discover ref={discoverRef} />
                </section>
                <section className="downloads-page" hidden={page !== "downloads"}>
                  <Downloads />
                </section>
                <section className="scraper-page" hidden={page !== "scraper"}>
                  <Scraper ref={scraperRef} />
                </section>
                <section hidden={page !== "directories"}>
                  <Directories />
                </section>
                <section hidden={page !== "settings"}>
                  <Settings />
                </section>
              </main>
            </div>
          </div>
        </div>
        <div hidden={windowState !== "visible"}>
          <PlayerWindows ref={playersRef} />
        </div>
        <FilmDetail
          key={`${filmId}:${detailView}`}
          film={detail}
          initialView={detailView}
          onClose={() => {
            setFilmId(null);
          }}
        />
        <Modal
          opened={addKind !== null}
          onClose={() => setAddKind(null)}
          title={addKind === "download" ? "新建下载" : "导入影片"}
          centered
          size="md"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {addKind === "download" ? (
              <>
                <Textarea
                  label="粘贴资源链接"
                  placeholder="https://example.com/video.mp4"
                  description="支持多条链接，每行一条"
                  minRows={4}
                  autosize
                  value={links}
                  onChange={(event) => {
                    setLinks(event.currentTarget.value);
                    setError("");
                  }}
                  error={error}
                  data-autofocus
                />
                <div className="import-default">
                  <Icon name="folder" size={16} />
                  <span>{path}</span>
                  <Pill>自动匹配画质</Pill>
                </div>
              </>
            ) : (
              <>
                <p className="muted">选择媒体目录，自动识别影片并加入片库。</p>
                <div className="import-folder">
                  <Icon name="folder" size={28} />
                  <div>
                    <strong>媒体目录</strong>
                    <span>{path}</span>
                  </div>
                  <Button
                    variant="default"
                    size="xs"
                    onClick={() => {
                      setExtra(true);
                    }}
                  >
                    更换
                  </Button>
                </div>
                {error && <p className="error-text">{error}</p>}
                <div className="import-default">
                  <Icon name="check" size={16} />
                  <span>包含子目录 · 跳过已入库影片</span>
                </div>
              </>
            )}
            <button
              type="button"
              className="adjust-button"
              aria-expanded={extra}
              onClick={() => setExtra(!extra)}
            >
              调整本次选项
              <Icon name="down" size={14} />
            </button>
            <Collapse expanded={extra}>
              <div className="form-stack">
                <TextInput
                  label="目录"
                  value={path}
                  onChange={(event) => setPath(event.currentTarget.value)}
                />
                <Checkbox
                  label={
                    addKind === "download" ? "完成后补全资料并加入片库" : "导入后自动补全缺失资料"
                  }
                  defaultChecked
                />
              </div>
            </Collapse>
            <div className="modal-footer">
              <Button variant="default" onClick={() => setAddKind(null)}>
                取消
              </Button>
              <Button
                type="submit"
                leftSection={<Icon name={addKind === "download" ? "download" : "plus"} />}
              >
                {addKind === "download" ? "加入下载" : "开始导入"}
              </Button>
            </div>
          </form>
        </Modal>
        {toast && (
          <output className="toast" aria-live="polite">
            <Icon name="check" size={17} />
            <span>{toast}</span>
            <button type="button" aria-label="关闭提示" onClick={() => setToast("")}>
              <Icon name="close" size={15} />
            </button>
          </output>
        )}
      </PrototypeContext.Provider>
    </MantineProvider>
  );
}
