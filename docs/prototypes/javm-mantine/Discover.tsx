import {
  useDeferredValue,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Ref } from "react";
import {
  ActionIcon,
  Avatar,
  Button,
  Group,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { FilmCollection } from "./FilmCollection";
import { facetNames, getFacetValues } from "./filmMetadata";
import type { FilmFacet } from "./filmMetadata";
import { usePrototype } from "./state";
import { Icon } from "./icons";
import { Empty, Pill } from "./ui";

export interface DiscoverHandle {
  select: (dimension: FilmFacet, value: string) => void;
}

const nameCollator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const avatarGradients = [
  { from: "rouge.6", to: "orchid.7" },
  { from: "wine.6", to: "rouge.4" },
  { from: "orchid.6", to: "rouge.7" },
  { from: "champagne.6", to: "wine.7" },
  { from: "orchid.8", to: "orchid.4" },
];
const avatarGradient = (name: string) =>
  avatarGradients[
    Array.from(name).reduce((sum, char) => sum + char.codePointAt(0)!, 0) % avatarGradients.length
  ]!;

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
      Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[data-name]") ?? [])
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
    <div ref={root}>
      <div className="page-toolbar discover-toolbar">
        <Group justify="space-between" wrap="wrap" gap="sm" pb="sm">
          <SegmentedControl
            aria-label="发现维度"
            value={dimension}
            onChange={(value) => changeDimension(value as FilmFacet)}
            data={[...facetNames]}
          />
          {!selected && (
            <Group gap="xs" wrap="nowrap">
              <TextInput
                size="xs"
                w={200}
                aria-label={`搜索${dimension}`}
                placeholder={`搜索${dimension}`}
                leftSection={<Icon name="search" size={15} />}
                rightSection={
                  query ? (
                    <ActionIcon
                      size={22}
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
                w={110}
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
                color={onlyFavorites ? "rouge" : "gray"}
                size="xs"
                aria-label={`只看收藏${dimension}`}
                aria-pressed={onlyFavorites}
                leftSection={<Icon name="star" size={14} filled={onlyFavorites} />}
                onClick={() => {
                  setOnlyFavorites(!onlyFavorites);
                  resetPosition();
                }}
              >
                收藏
              </Button>
            </Group>
          )}
        </Group>
      </div>
      {!selected ? (
        <>
          <Text size="xs" c="dimmed" my="sm" aria-live="polite">
            {query.trim() || onlyFavorites ? `${shown.length} / ${values.length}` : values.length}{" "}
            项
          </Text>
          {shown.length ? (
            <SimpleGrid
              component="ul"
              type="container"
              cols={{ base: 2, "600px": 3, "900px": 4, "1200px": 5, "1500px": 6 }}
              spacing="sm"
              verticalSpacing="sm"
              className="facet-grid"
              aria-label={`${dimension}列表`}
            >
              {shown.map(({ name, count }) => {
                const favorite = favorites.has(favoriteKey(name));
                return (
                  <Paper component="li" key={name} className="facet-card" withBorder radius="md">
                    <UnstyledButton
                      className="facet-open"
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
                          size={34}
                          radius="xl"
                          variant="gradient"
                          gradient={avatarGradient(name)}
                          aria-hidden="true"
                        >
                          {name.slice(-2)}
                        </Avatar>
                      )}
                      <Text span size="sm" fw={500} truncate style={{ flex: 1 }}>
                        {name}
                      </Text>
                      <Text span size="xs" c="dimmed" title={`${count} 部影片`}>
                        {count.toLocaleString()}
                      </Text>
                    </UnstyledButton>
                    <ActionIcon
                      color={favorite ? "champagne" : "gray"}
                      aria-label={`${favorite ? "取消收藏" : "收藏"}${dimension} ${name}`}
                      aria-pressed={favorite}
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
                      <Icon name="star" size={15} filled={favorite} />
                    </ActionIcon>
                  </Paper>
                );
              })}
            </SimpleGrid>
          ) : (
            <Empty
              icon={onlyFavorites && !query.trim() ? "star" : "search"}
              title={
                query.trim()
                  ? `未找到匹配的${dimension}`
                  : onlyFavorites
                    ? `暂无收藏${dimension}`
                    : `暂无${dimension}`
              }
              description="换个关键词，或显示全部条目。"
            >
              {(query.trim() || onlyFavorites) && (
                <Button variant="subtle" size="xs" onClick={clearFilters}>
                  显示全部
                </Button>
              )}
            </Empty>
          )}
        </>
      ) : (
        <section>
          <Group gap="sm" my="md">
            <Button
              variant="subtle"
              size="xs"
              leftSection={<Icon name="arrow" size={14} />}
              onClick={() => {
                setSelected(null);
                pendingPosition.current = returnTo.current ?? { top: 0 };
              }}
            >
              返回{dimension}
            </Button>
            <Title order={3} fz={18}>
              {selected}
            </Title>
            <Pill>{works.length.toLocaleString()} 部</Pill>
          </Group>
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
