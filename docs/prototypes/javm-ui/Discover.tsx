import {
  useDeferredValue,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Ref } from "react";
import { ActionIcon, Avatar, Button, SegmentedControl, Select, TextInput } from "@mantine/core";
import { FilmCollection } from "./FilmCollection";
import { facetNames, getFacetValues } from "./filmMetadata";
import type { FilmFacet } from "./filmMetadata";
import { usePrototype } from "./state";
import { Icon } from "./visuals";
import { Empty, Pill } from "./ui";

export interface DiscoverHandle {
  select: (dimension: FilmFacet, value: string) => void;
}

const nameCollator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const avatarColors = ["rose", "grape", "indigo", "teal", "orange"];
const avatarColor = (name: string) =>
  avatarColors[
    Array.from(name).reduce((sum, char) => sum + char.codePointAt(0)!, 0) % avatarColors.length
  ];

export function Discover({ ref }: { ref: Ref<DiscoverHandle> }) {
  const { page, films, setFilms, openFilm, play } = usePrototype();
  const root = useRef<HTMLDivElement>(null);
  const returnTo = useRef<{ name: string; top: number } | null>(null);
  const pendingPosition = useRef<{ top: number; name?: string } | null>(null);
  const [dimension, setDimension] = useState<FilmFacet>("演员");
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query.trim().toLocaleLowerCase());
  const [sort, setSort] = useState("count");
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set());
  const favoriteKey = (name: string) => `${dimension}:${name}`;
  const resetPosition = () => {
    pendingPosition.current = { top: 0 };
  };
  const changeDimension = (next: FilmFacet) => {
    setDimension(next);
    setSelected(null);
    setQuery("");
    setOnlyFavorites(false);
    returnTo.current = null;
    resetPosition();
  };
  useImperativeHandle(ref, () => ({
    select: (nextDimension, value) => {
      changeDimension(nextDimension);
      setSelected(value);
    },
  }));
  useLayoutEffect(() => {
    const position = pendingPosition.current;
    if (page !== "discover" || !position) return;
    root.current?.closest(".page-content")?.scrollTo({ top: position.top });
    if (position.name) {
      Array.from(root.current?.querySelectorAll<HTMLButtonElement>(".discover-open") ?? [])
        .find((button) => button.dataset.name === position.name)
        ?.focus({ preventScroll: true });
    }
    pendingPosition.current = null;
  });

  const values = useMemo(() => {
    const counts = new Map<string, number>();
    for (const film of films) {
      for (const name of new Set(getFacetValues(film, dimension))) {
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    return Array.from(counts, ([name, count]) => ({ name, count }));
  }, [films, dimension]);
  const shown = useMemo(
    () =>
      values
        .filter(
          ({ name }) =>
            name.toLocaleLowerCase().includes(search) &&
            (!onlyFavorites || favorites.has(`${dimension}:${name}`)),
        )
        .sort(
          (a, b) =>
            (sort === "count" ? b.count - a.count : 0) || nameCollator.compare(a.name, b.name),
        ),
    [values, search, onlyFavorites, favorites, dimension, sort],
  );
  const works = useMemo(
    () =>
      selected ? films.filter((film) => getFacetValues(film, dimension).includes(selected)) : [],
    [films, dimension, selected],
  );
  const clearFilters = () => {
    setQuery("");
    setOnlyFavorites(false);
    resetPosition();
  };

  return (
    <div className="discover-workspace" ref={root}>
      <div className="discover-toolbar">
        <SegmentedControl
          aria-label="发现维度"
          value={dimension}
          onChange={(value) => changeDimension(value as FilmFacet)}
          data={[...facetNames]}
        />
        {!selected && (
          <div className="discover-controls">
            <TextInput
              className="discover-search"
              size="xs"
              aria-label={`搜索${dimension}`}
              placeholder={`搜索${dimension}`}
              leftSection={<Icon name="search" size={15} />}
              rightSection={
                query ? (
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size={24}
                    aria-label="清除发现搜索"
                    onClick={() => {
                      setQuery("");
                      resetPosition();
                    }}
                  >
                    <Icon name="close" size={13} />
                  </ActionIcon>
                ) : undefined
              }
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                resetPosition();
              }}
            />
            <Select
              size="xs"
              className="discover-sort"
              aria-label="发现排序"
              value={sort}
              data={[
                { value: "count", label: "作品最多" },
                { value: "name", label: "名称 A–Z" },
              ]}
              allowDeselect={false}
              onChange={(value) => {
                if (value) setSort(value);
                resetPosition();
              }}
            />
            <Button
              variant={onlyFavorites ? "light" : "subtle"}
              color={onlyFavorites ? "rose" : "gray"}
              size="xs"
              aria-label={`只看收藏${dimension}`}
              aria-pressed={onlyFavorites}
              leftSection={<Icon name="star" size={14} />}
              onClick={() => {
                setOnlyFavorites(!onlyFavorites);
                resetPosition();
              }}
            >
              收藏
            </Button>
          </div>
        )}
      </div>
      {!selected ? (
        <>
          <output className="discover-result-count" aria-live="polite">
            {query.trim() || onlyFavorites ? `${shown.length} / ${values.length}` : values.length}{" "}
            项
          </output>
          {shown.length ? (
            <ul
              className="discover-grid"
              aria-label={`${dimension}列表`}
              aria-busy={search !== query.trim().toLocaleLowerCase()}
            >
              {shown.map(({ name, count }) => {
                const favorite = favorites.has(favoriteKey(name));
                return (
                  <li key={name} className="discover-card">
                    <button
                      type="button"
                      className="discover-open"
                      data-name={name}
                      aria-label={`查看 ${name} 的 ${count} 部影片`}
                      title={name}
                      onClick={() => {
                        returnTo.current = {
                          name,
                          top: root.current?.closest(".page-content")?.scrollTop ?? 0,
                        };
                        setSelected(name);
                        resetPosition();
                      }}
                    >
                      {(dimension === "演员" || dimension === "导演") && (
                        <Avatar
                          component="span"
                          size={36}
                          radius="xl"
                          color={avatarColor(name)}
                          aria-hidden="true"
                        >
                          {name.slice(-2)}
                        </Avatar>
                      )}
                      <span className="discover-name">{name}</span>
                      <span className="discover-count" title={`${count} 部影片`}>
                        {count.toLocaleString()}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`discover-favorite ${favorite ? "is-favorite" : ""}`}
                      aria-label={`${favorite ? "取消收藏" : "收藏"}${dimension} ${name}`}
                      aria-pressed={favorite}
                      title={favorite ? "取消收藏" : "收藏"}
                      onClick={() =>
                        setFavorites((previous) => {
                          const next = new Set(previous);
                          const key = favoriteKey(name);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                    >
                      <Icon name="star" size={15} />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="discover-empty">
              <Icon name={onlyFavorites && !query.trim() ? "star" : "search"} size={28} />
              <p>
                {query.trim()
                  ? `未找到匹配的${dimension}`
                  : onlyFavorites
                    ? `暂无收藏${dimension}`
                    : `暂无${dimension}`}
              </p>
              {(query.trim() || onlyFavorites) && (
                <Button variant="subtle" size="xs" onClick={clearFilters}>
                  显示全部
                </Button>
              )}
            </div>
          )}
        </>
      ) : (
        <section className="discover-works">
          <div className="section-caption">
            <Button
              variant="subtle"
              size="xs"
              onClick={() => {
                setSelected(null);
                pendingPosition.current = returnTo.current ?? { top: 0 };
              }}
            >
              返回{dimension}
            </Button>
            <h3>{selected}</h3>
            <Pill>{works.length.toLocaleString()} 部</Pill>
          </div>
          <FilmCollection
            films={works}
            layout="poster"
            active={page === "discover"}
            openFilm={openFilm}
            play={play}
            toggleFavorite={(id) =>
              setFilms((previous) =>
                previous.map((film) =>
                  film.id === id ? { ...film, favorite: !film.favorite } : film,
                ),
              )
            }
          />
          {works.length === 0 && (
            <Empty title="暂未收录" description="相关作品入库后会显示在这里。" />
          )}
        </section>
      )}
    </div>
  );
}
