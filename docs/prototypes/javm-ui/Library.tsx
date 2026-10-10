import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, Select, TextInput } from "@mantine/core";
import type { RefObject } from "react";
import { FilmCollection } from "./FilmCollection";
import { usePrototype } from "./state";
import { Icon } from "./visuals";
import { Empty, IconButton } from "./ui";
import { LibraryFilterButton, libraryFilterLabels } from "./LibraryFilters";
import { emptyLibraryFilters, librarySortOptions, selectLibraryFilms } from "./libraryQuery";
import type { LibraryScope, LibrarySort, SortDirection } from "./libraryQuery";

export function Library({ searchRef }: { searchRef: RefObject<HTMLInputElement | null> }) {
  const { page, films, setFilms, query, setQuery, openFilm, play, add } = usePrototype();
  const collectionStart = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const search = useDeferredValue(query.trim().toLowerCase());
  const [filter, setFilter] = useState<LibraryScope>("all");
  const [layout, setLayout] = useState("poster");
  const [sort, setSort] = useState<LibrarySort>("added");
  const [direction, setDirection] = useState<SortDirection>("desc");
  const [filters, setFilters] = useState(emptyLibraryFilters);
  const chips = libraryFilterLabels(filters);
  const clearFilters = () => {
    setFilters(emptyLibraryFilters());
    setFilter("all");
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
    () => selectLibraryFilms(films, { filters, scope: filter, query: search, sort, direction }),
    [films, filters, filter, search, sort, direction],
  );
  const favoriteCount = useMemo(() => films.filter((film) => film.favorite).length, [films]);
  useLayoutEffect(() => {
    collectionStart.current?.closest(".page-content")?.scrollTo({ top: 0 });
  }, [query, filter, filters, sort, direction, layout]);
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const measure = () =>
      collectionStart.current?.style.setProperty(
        "--library-toolbar-height",
        `${toolbar.offsetHeight}px`,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, []);
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
    <div className="library-workspace" ref={collectionStart}>
      <div className="library-toolbar" ref={toolbarRef}>
        <div className="library-controls">
          <div className="text-tabs" aria-label="媒体库筛选">
            {(
              [
                ["all", "全部影片", films.length],
                ["favorites", "我的收藏", favoriteCount],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                className={filter === key ? "active" : ""}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {label}
                <span>{count.toLocaleString()}</span>
              </button>
            ))}
          </div>
          <TextInput
            ref={searchRef}
            className="library-search"
            aria-label="搜索媒体库"
            aria-keyshortcuts="Control+K Meta+K"
            placeholder="片名、番号、演员"
            leftSection={<Icon name="search" size={16} />}
            rightSection={<kbd>Ctrl K</kbd>}
            rightSectionWidth={55}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <div className="row control-actions">
            <Select
              aria-label="排序方式"
              value={sort}
              data={librarySortOptions}
              allowDeselect={false}
              w={112}
              size="xs"
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
            <div className="view-toggle">
              <IconButton
                icon="library"
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
            </div>
            <Button
              size="xs"
              leftSection={<Icon name="plus" size={15} />}
              onClick={() => add("import")}
            >
              导入
            </Button>
          </div>
        </div>
        {(chips.length > 0 || query.trim()) && (
          <div className="active-library-filters" aria-label="已选筛选条件">
            <output aria-live="polite" className="filter-result-count">
              {shown.length.toLocaleString()} 部
            </output>
            {query.trim() && (
              <button
                type="button"
                className="filter-chip"
                aria-label={`清除搜索 ${query.trim()}`}
                onClick={() => setQuery("")}
              >
                <span>搜索：{query.trim()}</span>
                <Icon name="close" size={12} />
              </button>
            )}
            {chips.map((chip) => (
              <button
                type="button"
                className="filter-chip"
                key={`${chip.key}:${chip.value}`}
                aria-label={`移除筛选 ${chip.label}`}
                onClick={() =>
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
                <span>{chip.label}</span>
                <Icon name="close" size={12} />
              </button>
            ))}
            <button
              type="button"
              className="text-link clear-library-filters"
              onClick={clearFilters}
            >
              清除全部
            </button>
          </div>
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
      <div className="list-footer">
        <span>
          共 {shown.length.toLocaleString()} 部影片 / 片库 {films.length.toLocaleString()} 部
        </span>
        <button
          type="button"
          className="text-link"
          onClick={() => collectionStart.current?.closest(".page-content")?.scrollTo({ top: 0 })}
        >
          回到顶部 ↑
        </button>
      </div>
    </div>
  );
}
