import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDebouncedValue } from "@mantine/hooks";
import type { RefObject } from "react";
import {
  Affix,
  Alert,
  Anchor,
  Button,
  Group,
  Kbd,
  Loader,
  Pill as MantinePill,
  Select,
  Text,
  TextInput,
} from "@mantine/core";
import { FilmCollection } from "./FilmCollection";
import type { FilmLayout } from "./FilmCollection";
import { useWorkspace } from "../../app/state";
import { Icon } from "../../components/icons";
import { CountTabs, Empty, IconButton } from "../../components/ui";
import { LibraryFilterButton, libraryFilterLabels } from "./LibraryFilters";
import { emptyLibraryFilters, librarySortOptions } from "./libraryQuery";
import type { LibraryScope, LibrarySort, SortDirection } from "./libraryQuery";
import type { LibraryQuery } from "../../contracts/library";
import { usePagedQuery } from "../../services/library/usePagedQuery";

export function Library({ searchRef }: { searchRef: RefObject<HTMLInputElement | null> }) {
  const { page, toggleFavorite, libraryState, library, openFilm, play, add } = useWorkspace();
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [search] = useDebouncedValue(query.trim(), 180);
  const [scope, setScope] = useState<LibraryScope>("all");
  const [availability, setAvailability] =
    useState<NonNullable<LibraryQuery["availability"]>>("all");
  const [layout, setLayout] = useState<FilmLayout>("poster");
  const [sort, setSort] = useState<LibrarySort>("added");
  const [direction, setDirection] = useState<SortDirection>("desc");
  const [filters, setFilters] = useState(emptyLibraryFilters);
  const [backToTopVisible, setBackToTopVisible] = useState(false);
  const chips = libraryFilterLabels(filters, availability);
  const scrollTop = () => {
    rootRef.current?.closest(".page-content")?.scrollTo({ top: 0 });
  };
  const clearFilters = () => {
    setFilters(emptyLibraryFilters());
    setScope("all");
    setAvailability("all");
    setQuery("");
  };
  const [view] = useState(() => library.createFilmQuery());
  const results = usePagedQuery(
    library,
    view,
    { filters, scope, availability, query: search, sort, direction },
    page === "library" && libraryState.ready,
  );
  useLayoutEffect(scrollTop, [query, scope, availability, filters, sort, direction, layout]);
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
      {libraryState.error && (
        <Alert color="red" title="媒体库暂时无法读取" mb="md" role="alert">
          {libraryState.error}
          <Button variant="subtle" size="xs" onClick={() => void library.refresh()}>
            重试连接
          </Button>
        </Alert>
      )}
      <div className="page-toolbar">
        <Group justify="space-between" wrap="nowrap" gap="md" align="flex-end">
          <CountTabs
            label="媒体库筛选"
            value={scope}
            onChange={setScope}
            items={[
              ["all", "全部影片", libraryState.total],
              ["favorites", "我的收藏", libraryState.favorites],
            ]}
          />
          <TextInput
            ref={searchRef}
            className="toolbar-search"
            aria-label="搜索媒体库"
            aria-keyshortcuts="Control+K Meta+K"
            placeholder="片名、番号、演员"
            leftSection={<Icon name="search" size={16} />}
            rightSection={<Kbd size="xs">Ctrl K</Kbd>}
            rightSectionWidth={58}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <Group gap={6} wrap="nowrap" pb={8}>
            <Select
              aria-label="排序方式"
              value={sort}
              data={librarySortOptions}
              allowDeselect={false}
              w={112}
              size="xs"
              variant="unstyled"
              onChange={(value) => {
                const option = librarySortOptions.find((item) => item.value === value);
                if (option) {
                  setSort(option.value);
                  setDirection(option.direction);
                }
              }}
            />
            <IconButton
              icon={direction === "desc" ? "sortDesc" : "sortAsc"}
              label={direction === "desc" ? "当前降序，切换为升序" : "当前升序，切换为降序"}
              onClick={() => setDirection(direction === "desc" ? "asc" : "desc")}
            />
            <LibraryFilterButton
              filters={filters}
              resultCount={results.total}
              onChange={setFilters}
              availability={availability}
              onAvailabilityChange={setAvailability}
            />
            <Group gap={2} className="toolbar-divider">
              <IconButton
                icon="grid"
                label="竖版海报视图"
                active={layout === "poster"}
                onClick={() => setLayout("poster")}
              />
              <IconButton
                icon="image"
                label="横版封面视图"
                active={layout === "landscape"}
                onClick={() => setLayout("landscape")}
              />
              <IconButton
                icon="list"
                label="列表视图"
                active={layout === "list"}
                onClick={() => setLayout("list")}
              />
            </Group>
          </Group>
        </Group>
        {(chips.length > 0 || query.trim()) && (
          <Group gap={6} py={8} aria-label="已选筛选条件">
            <Text size="xs" c="dimmed" mr={4} aria-live="polite">
              {results.total.toLocaleString()} 部
            </Text>
            {query.trim() && (
              <MantinePill
                withRemoveButton
                onRemove={() => setQuery("")}
                removeButtonProps={{ "aria-label": `清除搜索 ${query.trim()}` }}
              >
                搜索：{query.trim()}
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
              清除全部
            </Anchor>
          </Group>
        )}
      </div>
      {results.error && (
        <Alert color="red" title="影片读取失败" mb="md" role="alert">
          {results.error}
          <Button variant="subtle" size="xs" onClick={view.retry}>
            重试
          </Button>
        </Alert>
      )}
      {!results.ready && !results.total && !results.error ? (
        <Group component="output" justify="center" py="xl">
          <Loader size="sm" />
          <Text size="sm">正在读取媒体库…</Text>
        </Group>
      ) : results.total === 0 && !results.error ? (
        <Empty
          icon="grid"
          title={
            !libraryState.total
              ? "还没有影片"
              : scope === "favorites" && !chips.length && !query
                ? "还没有收藏"
                : "没有找到影片"
          }
          description={
            !libraryState.total
              ? "添加媒体目录，开始整理你的片库。"
              : "试试其他片名、番号或演员，或清除当前筛选。"
          }
        >
          {!libraryState.total ? (
            <Button leftSection={<Icon name="plus" size={16} />} onClick={() => add("import")}>
              导入影片
            </Button>
          ) : (
            <Button variant="light" onClick={clearFilters}>
              清除筛选
            </Button>
          )}
        </Empty>
      ) : (
        <div className="library-results" aria-busy={results.loading || search !== query.trim()}>
          <FilmCollection
            items={results.items}
            count={results.total}
            onRangeChange={view.loadRange}
            layout={layout}
            active={page === "library"}
            openFilm={openFilm}
            play={play}
            toggleFavorite={toggleFavorite}
          />
        </div>
      )}
      {page === "library" && backToTopVisible && (
        <Affix withinPortal={false} position={{ bottom: 18, right: 30 }} zIndex={7}>
          <Button
            variant="default"
            size="xs"
            rightSection={<Icon name="arrowUp" size={14} />}
            onClick={scrollTop}
          >
            回到顶部
          </Button>
        </Affix>
      )}
    </div>
  );
}
