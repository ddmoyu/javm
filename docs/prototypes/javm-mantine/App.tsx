import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Affix,
  AppShell,
  Button,
  Checkbox,
  Collapse,
  Divider,
  Group,
  Modal,
  NavLink,
  Notification,
  Paper,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
  Transition,
  UnstyledButton,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { sampleDownloads, sampleFilms } from "./data";
import type { DownloadTask, Film } from "./data";
import { PrototypeContext } from "./state";
import type { FilmDetailView, Page } from "./state";
import { BrandMark, Icon } from "./icons";
import type { IconName } from "./icons";
import { Pill } from "./ui";
import { Library } from "./Library";
import { Discover } from "./Discover";
import type { DiscoverHandle } from "./Discover";
import { Downloads } from "./Downloads";
import { Scraper } from "./Scraper";
import type { ScraperHandle } from "./Scraper";
import { Directories } from "./Directories";
import { Settings } from "./Settings";
import { FilmDetail } from "./FilmDetail";
import { PlayerWindows } from "./PlayerWindows";
import type { PlayerWindowsHandle } from "./PlayerWindows";

const NAV_KEY = "javm-velvet:nav-collapsed";
const pages: { id: Page; title: string; short: string; icon: IconName }[] = [
  { id: "library", title: "媒体库", short: "片库", icon: "grid" },
  { id: "discover", title: "发现", short: "发现", icon: "compass" },
  { id: "downloads", title: "下载管理", short: "下载", icon: "download" },
  { id: "scraper", title: "资源刮削", short: "刮削", icon: "scan" },
  { id: "directories", title: "目录管理", short: "目录", icon: "folder" },
  { id: "settings", title: "系统设置", short: "设置", icon: "settings" },
];

export function App() {
  // 原型状态仅保存在内存，布局与交互对齐第一版原型的最新版本。
  const [page, setPage] = useState<Page>("library");
  const { setColorScheme } = useMantineColorScheme();
  const colorScheme = useComputedColorScheme("dark");
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
  // 折叠状态按本机记住；首次打开时窄窗口默认折叠。存储不可用时退回默认值。
  const [collapsed, setCollapsedState] = useState(() => {
    try {
      const saved = localStorage.getItem(NAV_KEY);
      if (saved !== null) return saved === "1";
    } catch {
      /* 隐私模式等场景下存储不可用 */
    }
    return window.matchMedia("(max-width: 850px)").matches;
  });
  const setCollapsed = (value: boolean) => {
    setCollapsedState(value);
    try {
      localStorage.setItem(NAV_KEY, value ? "1" : "0");
    } catch {
      /* 忽略 */
    }
  };
  const [windowState, setWindowState] = useState<"visible" | "minimized" | "tray" | "closed">(
    "visible",
  );
  const [closeToTray, setCloseToTray] = useState(true);
  const [cardClickToPlay, setCardClickToPlay] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
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
    else mainRef.current?.focus({ preventScroll: true });
    detailOriginRef.current = null;
  }, [filmId, page]);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [page]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 5500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const notice = (message: string) => setToast(message);
  const add = (kind: "import" | "download") => {
    setAddKind(kind);
    setError("");
    setExtra(false);
    setLinks("");
    setPath(kind === "import" ? "D:\\Media\\Library" : "D:\\Media\\Downloads");
  };
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

  useHotkeys([["mod+B", () => setCollapsed(!collapsed)]]);
  const navItem = (item: (typeof pages)[number]) =>
    collapsed ? (
      // 折叠后是导航栏样式：图标下方保留短标签，不依赖悬停提示。
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
    <PrototypeContext.Provider
      value={{
        page,
        go: setPage,
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
        <Stack className="window-preview-state" align="center" justify="center" gap="md">
          <BrandMark size={44} />
          <Title order={3}>
            {windowState === "minimized"
              ? "窗口已最小化"
              : windowState === "closed"
                ? "窗口已关闭"
                : "窗口已收起到托盘"}
          </Title>
          <Button onClick={() => setWindowState("visible")}>恢复窗口</Button>
        </Stack>
      )}
      <AppShell
        header={{ height: 34 }}
        navbar={{ width: collapsed ? 72 : 208, breakpoint: 0 }}
        padding={0}
        transitionDuration={160}
        hidden={windowState !== "visible"}
        className="app-window"
      >
        <AppShell.Header className="titlebar">
          <Tooltip label={`${collapsed ? "展开" : "折叠"}导航 (Ctrl+B)`} position="bottom-start">
            <button
              type="button"
              className="window-button nav-toggle"
              aria-label={collapsed ? "展开导航" : "折叠导航"}
              aria-expanded={!collapsed}
              aria-controls="main-navigation"
              onClick={() => setCollapsed(!collapsed)}
            >
              <Icon name="sidebar" size={16} />
            </button>
          </Tooltip>
          <UnstyledButton className="titlebar-drag" aria-label="JAVM 标题栏">
            <BrandMark />
            <Text span fz={12} fw={600}>
              JAVM
            </Text>
            <Text span fz={11} c="dimmed">
              我的片库
            </Text>
          </UnstyledButton>
          <Group gap={0} wrap="nowrap">
            <button
              type="button"
              className="window-button"
              aria-label="最小化窗口"
              onClick={() => setWindowState("minimized")}
            >
              <Icon name="minimize" size={14} />
            </button>
            <button type="button" className="window-button" aria-label="最大化窗口">
              <Icon name="maximize" size={12} />
            </button>
            <button
              type="button"
              className="window-button close"
              aria-label={closeToTray ? "关闭窗口到托盘" : "关闭窗口"}
              onClick={() => setWindowState(closeToTray ? "tray" : "closed")}
            >
              <Icon name="close" size={15} />
            </button>
          </Group>
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
              <Discover ref={discoverRef} />
            </section>
            <section hidden={page !== "downloads"} className="fill-page">
              <Downloads />
            </section>
            <section hidden={page !== "scraper"} className="fill-page">
              <Scraper ref={scraperRef} />
            </section>
            <section hidden={page !== "directories"}>
              <Directories />
            </section>
            <section hidden={page !== "settings"}>
              <Settings />
            </section>
          </div>
        </AppShell.Main>
      </AppShell>

      <div hidden={windowState !== "visible"}>
        <PlayerWindows ref={playersRef} />
      </div>
      <FilmDetail
        key={`${filmId}:${detailView}`}
        film={detail}
        initialView={detailView}
        onClose={() => setFilmId(null)}
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
            <Stack gap="sm">
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
              <Group gap="xs" c="dimmed">
                <Icon name="folder" size={16} />
                <Text size="sm" ff="monospace" style={{ flex: 1 }}>
                  {path}
                </Text>
                <Pill>自动匹配画质</Pill>
              </Group>
            </Stack>
          ) : (
            <Stack gap="sm">
              <Text size="sm" c="dimmed">
                选择媒体目录，自动识别影片并加入片库。
              </Text>
              <Paper withBorder p="md" radius="md">
                <Group wrap="nowrap">
                  <Icon name="folder" size={28} />
                  <div style={{ flex: 1 }}>
                    <Text fw={600} size="sm">
                      媒体目录
                    </Text>
                    <Text size="xs" c="dimmed" ff="monospace">
                      {path}
                    </Text>
                  </div>
                  <Button variant="default" size="xs" onClick={() => setExtra(true)}>
                    更换
                  </Button>
                </Group>
              </Paper>
              {error && (
                <Text size="sm" c="red">
                  {error}
                </Text>
              )}
              <Group gap="xs" c="dimmed">
                <Icon name="check" size={16} />
                <Text size="sm">包含子目录 · 跳过已入库影片</Text>
              </Group>
            </Stack>
          )}
          <Button
            variant="subtle"
            color="gray"
            size="compact-sm"
            mt="sm"
            aria-expanded={extra}
            rightSection={<Icon name="down" size={14} />}
            onClick={() => setExtra(!extra)}
          >
            调整本次选项
          </Button>
          <Collapse expanded={extra}>
            <Stack gap="sm" mt="xs">
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
            </Stack>
          </Collapse>
          <Group justify="flex-end" mt="lg">
            <Button variant="default" onClick={() => setAddKind(null)}>
              取消
            </Button>
            <Button
              type="submit"
              leftSection={<Icon name={addKind === "download" ? "download" : "plus"} size={16} />}
            >
              {addKind === "download" ? "加入下载" : "开始导入"}
            </Button>
          </Group>
        </form>
      </Modal>

      <Affix position={{ bottom: 24, right: 24 }} zIndex={500}>
        <Transition mounted={!!toast} transition="slide-up" duration={180}>
          {(style) => (
            <Notification
              style={style}
              w={340}
              withBorder
              icon={<Icon name="check" size={16} />}
              onClose={() => setToast("")}
              closeButtonProps={{ "aria-label": "关闭提示" }}
              aria-live="polite"
            >
              {toast}
            </Notification>
          )}
        </Transition>
      </Affix>
    </PrototypeContext.Provider>
  );
}
