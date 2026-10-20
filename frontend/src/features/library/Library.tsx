import { getLocale, t, useLocale } from "../../i18n/index";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useDebouncedValue } from "@mantine/hooks";
import type { RefObject } from "react";
import {
  Affix,
  Alert,
  Anchor,
  Button,
  Group,
  Loader,
  Pill as MantinePill,
  Text,
  TextInput,
} from "@mantine/core";
import { FilmCollection } from "./FilmCollection";
import { LibrarySortMenu } from "./LibrarySortMenu";
import { LibraryViewMenu } from "./LibraryViewMenu";
import { useWorkspace } from "../../app/state";
import { Icon } from "../../components/icons";
import { CountTabs, Empty } from "../../components/ui";
import { LibraryFilterButton, libraryFilterLabels } from "./LibraryFilters";
import { emptyLibraryFilters } from "./libraryQuery";
import type { LibraryScope, LibrarySort, SortDirection } from "./libraryQuery";
import type { LibraryQuery } from "../../contracts/library";
import { usePagedQuery } from "../../services/library/usePagedQuery";
import { createLibraryLayoutSettings } from "../../platform/neutralino/libraryLayout";
import classes from "./Library.module.css";

export function Library({ searchRef }: { searchRef: RefObject<HTMLInputElement | null> }) {
  useLocale();
  const { page, toggleFavorite, libraryState, library, openFilm, play, add, runtime } =
    useWorkspace();
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [search] = useDebouncedValue(query.trim(), 180);
  const [scope, setScope] = useState<LibraryScope>("all");
  const [availability, setAvailability] =
    useState<NonNullable<LibraryQuery["availability"]>>("all");
  const layoutSettings = createLibraryLayoutSettings(runtime);
  const { layout, error: layoutError } = useSyncExternalStore(
    layoutSettings.subscribe,
    layoutSettings.getSnapshot,
  );
  const [sort, setSort] = useState<LibrarySort>("added");
  const [direction, setDirection] = useState<SortDirection>("desc");
  const [filters, setFilters] = useState(emptyLibraryFilters);
  const [backToTopVisible, setBackToTopVisible] = useState(false);
  const scrollPositions = useRef<Record<LibraryScope, number>>({ all: 0, favorites: 0 });
  const pendingScrollScope = useRef<LibraryScope | null>(null);
  const chips = libraryFilterLabels(filters, availability);
  const scrollTop = () => {
    pendingScrollScope.current = null;
    scrollPositions.current[scope] = 0;
    rootRef.current?.closest(".page-content")?.scrollTo({ top: 0 });
  };
  const changeScope = (next: LibraryScope) => {
    if (next === scope) return;
    const viewport = rootRef.current?.closest(".page-content");
    // 加载期间再次离开时，不能用被浏览器截短的位置覆盖尚未恢复的进度。
    if (viewport && pendingScrollScope.current !== scope)
      scrollPositions.current[scope] = viewport.scrollTop;
    pendingScrollScope.current = next;
    setScope(next);
  };
  const clearFilters = () => {
    setFilters(emptyLibraryFilters());
    changeScope("all");
    setAvailability("all");
    setQuery("");
  };
  // 两个页签分别保留有界分页缓存，切换时不清空总数和虚拟列表高度。
  const [views] = useState(() => ({
    all: library.createFilmQuery(),
    favorites: library.createFilmQuery(),
  }));
  const active = page === "library" && libraryState.ready;
  const allResults = usePagedQuery(
    library,
    views.all,
    { filters, scope: "all", availability, query: search, sort, direction },
    active && scope === "all",
  );
  const favoriteResults = usePagedQuery(
    library,
    views.favorites,
    { filters, scope: "favorites", availability, query: search, sort, direction },
    active && scope === "favorites",
  );
  const snapshots = { all: allResults, favorites: favoriteResults };
  const results = snapshots[scope];
  // 查询失效时先保留恢复请求；下一帧再读取虚拟列表完成测量后的滚动高度。
  useLayoutEffect(() => {
    if (page !== "library" || !results.ready || pendingScrollScope.current !== scope) return;
    const frame = requestAnimationFrame(() => {
      if (pendingScrollScope.current !== scope) return;
      const viewport = rootRef.current?.closest(".page-content");
      if (!viewport) return;
      viewport.scrollTo({ top: scrollPositions.current[scope] });
      pendingScrollScope.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [page, scope, results.ready, results.total]);
  useLayoutEffect(() => {
    const content = rootRef.current;
    const viewport = content?.closest<HTMLElement>(".page-content");
    if (page !== "library" || !content || !viewport) return;

    const updateVisibility = () => {
      setBackToTopVisible(viewport.scrollHeight > viewport.clientHeight && viewport.scrollTop > 0);
    };
    updateVisibility();
    viewport.addEventListener("scroll", updateVisibility, { passive: true });
    // 内容和窗口尺寸变化都可能消除滚动区域，即使没有新的滚动事件。
    const observer = new ResizeObserver(updateVisibility);
    observer.observe(content);
    observer.observe(viewport);
    return () => {
      viewport.removeEventListener("scroll", updateVisibility);
      observer.disconnect();
    };
  }, [page]);
  useEffect(() => {
    if (page !== "library") return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      const field = searchRef.current;
      if (!field?.getClientRects().length) return;
      if (
        document.activeElement instanceof Element &&
        document.activeElement.closest('[role="dialog"], [role="menu"], dialog[open]')
      )
        return;
      event.preventDefault();
      field.focus();
      field.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, searchRef]);

  return (
    <div ref={rootRef} className="library-content">
      {layoutError && (
        <Alert color="red" title={t("显示方式设置")} mb="md" role="alert">
          {t(layoutError)}
          <Button variant="subtle" size="xs" onClick={() => void layoutSettings.setLayout(layout)}>
            {t("保存当前选择")}
          </Button>
        </Alert>
      )}
      {libraryState.error && (
        <Alert color="red" title={t("媒体库暂时无法读取")} mb="md" role="alert">
          {t(libraryState.error)}
          <Button variant="subtle" size="xs" onClick={() => void library.refresh()}>
            {t("重试连接")}
          </Button>
        </Alert>
      )}
      <div className="page-toolbar">
        <div className={classes.toolbarRow}>
          <div className={classes.scope}>
            <CountTabs
              label={t("媒体库筛选")}
              value={scope}
              onChange={changeScope}
              items={[
                ["all", "全部", libraryState.total],
                ["favorites", "收藏", libraryState.favorites],
              ]}
            />
          </div>
          <div className={classes.tools}>
            <TextInput
              ref={searchRef}
              className={classes.search}
              aria-label={t("搜索媒体库")}
              aria-keyshortcuts="Control+K Meta+K"
              title={t("搜索媒体库 (Ctrl+K)")}
              placeholder={t("搜索影片…")}
              size="sm"
              leftSection={<Icon name="search" size={16} />}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <LibraryFilterButton
              filters={filters}
              resultCount={results.total}
              onChange={setFilters}
              availability={availability}
              onAvailabilityChange={setAvailability}
            />
            <LibrarySortMenu
              sort={sort}
              direction={direction}
              onSortChange={setSort}
              onDirectionChange={setDirection}
            />
            <LibraryViewMenu
              layout={layout}
              onLayoutChange={(value) => void layoutSettings.setLayout(value)}
            />
          </div>
        </div>
        {(chips.length > 0 || query.trim()) && (
          <Group gap={6} py={8} aria-label={t("已选筛选条件")}>
            <Text size="xs" c="dimmed" mr={4} aria-live="polite">
              {results.total.toLocaleString(getLocale())}
              {t(" 部")}
            </Text>
            {query.trim() && (
              <MantinePill
                withRemoveButton
                onRemove={() => setQuery("")}
                removeButtonProps={{ "aria-label": `清除搜索 ${query.trim()}` }}
              >
                {t("搜索：")}
                {query.trim()}
              </MantinePill>
            )}
            {chips.map((chip) => (
              <MantinePill
                key={`${chip.key}:${chip.value}`}
                withRemoveButton
                removeButtonProps={{ "aria-label": `移除筛选 ${chip.label}` }}
                onRemove={() => {
                  const key = chip.key;
                  if (key === "availability") {
                    setAvailability("all");
                    return;
                  }
                  setFilters((previous) => {
                    const value = previous[key];
                    return {
                      ...previous,
                      [key]: Array.isArray(value)
                        ? value.filter((item) => item !== chip.value)
                        : "all",
                    };
                  });
                }}
              >
                {chip.label}
              </MantinePill>
            ))}
            <Anchor component="button" type="button" size="xs" ml={4} onClick={clearFilters}>
              {t("清除全部")}
            </Anchor>
          </Group>
        )}
      </div>
      {(["all", "favorites"] as const).map((tab) => {
        const results = snapshots[tab];
        const view = views[tab];
        return (
          <div key={tab} hidden={scope !== tab}>
            {results.error && (
              <Alert color="red" title={t("影片读取失败")} mb="md" role="alert">
                {t(results.error)}
                <Button variant="subtle" size="xs" onClick={view.retry}>
                  {t("重试")}
                </Button>
              </Alert>
            )}
            {!results.ready && !results.total && !results.error ? (
              <Group component="output" justify="center" py="xl">
                <Loader size="sm" />
                <Text size="sm">{t("正在读取媒体库…")}</Text>
              </Group>
            ) : results.total === 0 && !results.error ? (
              <Empty
                icon="grid"
                title={
                  !libraryState.total
                    ? t("还没有影片")
                    : tab === "favorites" && !chips.length && !query
                      ? t("还没有收藏")
                      : t("没有找到影片")
                }
                description={
                  !libraryState.total
                    ? t("添加媒体目录，开始整理你的片库。")
                    : t("试试其他片名、番号或演员，或清除当前筛选。")
                }
              >
                {!libraryState.total ? (
                  <Button
                    leftSection={<Icon name="plus" size={16} />}
                    onClick={() => add("import")}
                  >
                    {t("导入影片")}
                  </Button>
                ) : (
                  <Button variant="light" onClick={clearFilters}>
                    {t("清除筛选")}
                  </Button>
                )}
              </Empty>
            ) : (
              <div
                className="library-results"
                aria-busy={results.loading || search !== query.trim()}
              >
                <FilmCollection
                  items={results.items}
                  count={results.total}
                  onRangeChange={view.loadRange}
                  layout={layout}
                  active={page === "library" && scope === tab}
                  openFilm={openFilm}
                  play={play}
                  toggleFavorite={toggleFavorite}
                />
              </div>
            )}
          </div>
        );
      })}
      {page === "library" && backToTopVisible && (
        <Affix withinPortal={false} position={{ bottom: 18, right: 30 }} zIndex={7}>
          <Button
            className="library-back-to-top"
            variant="default"
            size="xs"
            aria-label={t("回到顶部")}
            onClick={scrollTop}
          >
            <span className="library-back-to-top-label" aria-hidden="true">
              {t("回到顶部")}
            </span>
            <Icon name="arrowUp" size={14} />
          </Button>
        </Affix>
      )}
    </div>
  );
}
