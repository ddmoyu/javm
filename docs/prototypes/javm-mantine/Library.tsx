import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import {
  Anchor,
  Button,
  Group,
  Kbd,
  Pill as MantinePill,
  Select,
  Text,
  TextInput,
} from "@mantine/core";
import { FilmCollection } from "./FilmCollection";
import { usePrototype } from "./state";
import { Icon } from "./icons";
import { CountTabs, Empty, IconButton } from "./ui";
import { LibraryFilterButton, libraryFilterLabels } from "./LibraryFilters";
import { emptyLibraryFilters, librarySortOptions, selectLibraryFilms } from "./libraryQuery";
import type { LibraryScope, LibrarySort, SortDirection } from "./libraryQuery";

export function Library({ searchRef }: { searchRef: RefObject<HTMLInputElement | null> }) {
  const { page, films, setFilms, query, setQuery, openFilm, play, add } = usePrototype();
  const rootRef = useRef<HTMLDivElement>(null);
  const search = useDeferredValue(query.trim().toLowerCase());
  const [scope, setScope] = useState<LibraryScope>("all");
  const [layout, setLayout] = useState("poster");
  const [sort, setSort] = useState<LibrarySort>("added");
  const [direction, setDirection] = useState<SortDirection>("desc");
  const [filters, setFilters] = useState(emptyLibraryFilters);
  const chips = libraryFilterLabels(filters);
  const scrollTop = () => {
    rootRef.current?.closest(".page-content")?.scrollTo({ top: 0 });
  };
  const clearFilters = () => {
    setFilters(emptyLibraryFilters());
    setScope("all");
    setQuery("");
  };
  const toggleFavorite = useCallback(
    (id: number) =>
      setFilms((previous) =>
        previous.map((film) => (film.id === id ? { ...film, favorite: !film.favorite } : film)),
      ),
    [setFilms],
  );
  const shown = useMemo(
    () => selectLibraryFilms(films, { filters, scope, query: search, sort, direction }),
    [films, filters, scope, search, sort, direction],
  );
  const favoriteCount = useMemo(() => films.filter((film) => film.favorite).length, [films]);
  useLayoutEffect(scrollTop, [query, scope, filters, sort, direction, layout]);
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
    <div ref={rootRef}>
      <div className="page-toolbar">
        <Group justify="space-between" wrap="nowrap" gap="md" align="flex-end">
          <CountTabs
            label="媒体库筛选"
            value={scope}
            onChange={setScope}
            items={[
              ["all", "全部影片", films.length],
              ["favorites", "我的收藏", favoriteCount],
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
              films={films}
              filters={filters}
              resultCount={shown.length}
              onChange={setFilters}
            />
            <Group gap={2} className="toolbar-divider">
              <IconButton
                icon="grid"
                label="海报视图"
                active={layout === "poster"}
                onClick={() => setLayout("poster")}
              />
              <IconButton
                icon="list"
                label="列表视图"
                active={layout === "list"}
                onClick={() => setLayout("list")}
              />
            </Group>
            <Button
              size="xs"
              leftSection={<Icon name="plus" size={15} />}
              onClick={() => add("import")}
            >
              导入
            </Button>
          </Group>
        </Group>
        {(chips.length > 0 || query.trim()) && (
          <Group gap={6} py={8} aria-label="已选筛选条件">
            <Text size="xs" c="dimmed" mr={4} aria-live="polite">
              {shown.length.toLocaleString()} 部
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
                onRemove={() =>
                  setFilters((previous) => {
                    const value = previous[chip.key];
                    return {
                      ...previous,
                      [chip.key]: Array.isArray(value)
                        ? value.filter((item) => item !== chip.value)
                        : "all",
                    };
                  })
                }
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
      {shown.length === 0 ? (
        <Empty title="没有找到影片" description="试试其他片名、番号或演员，或清除当前筛选。">
          <Button variant="light" onClick={clearFilters}>
            清除筛选
          </Button>
        </Empty>
      ) : (
        <div aria-busy={search !== query.trim().toLowerCase()}>
          <FilmCollection
            films={shown}
            layout={layout}
            active={page === "library"}
            openFilm={openFilm}
            play={play}
            toggleFavorite={toggleFavorite}
          />
        </div>
      )}
      <Group justify="space-between" py="lg" mt="sm" className="list-footer">
        <Text size="xs" c="dimmed">
          共 {shown.length.toLocaleString()} 部影片 / 片库 {films.length.toLocaleString()} 部
        </Text>
        <Anchor component="button" type="button" size="xs" onClick={scrollTop}>
          回到顶部 ↑
        </Anchor>
      </Group>
    </div>
  );
}
