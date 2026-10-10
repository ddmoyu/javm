import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { useDebouncedValue } from "@mantine/hooks";
import type { Ref } from "react";
import {
  ActionIcon,
  Alert,
  Avatar,
  Button,
  Group,
  Paper,
  Pagination,
  Loader,
  SegmentedControl,
  Select,
  SimpleGrid,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { FilmCollection } from "../library/FilmCollection";
import type { FilmFacet } from "../films/filmMetadata";
import { useWorkspace } from "../../app/state";
import { Icon } from "../../components/icons";
import { Empty, Pill } from "../../components/ui";
import { usePagedQuery } from "../../services/library/usePagedQuery";
import { isActorDirectoryDimension } from "../../services/catalog/discoveryData";
import { CatalogStatus } from "./CatalogStatus";
import { usePortraits } from "./usePortraits";
import {
  categoryForFacet,
  discoverCategories,
  discoverDimensions,
  metadataDimensions,
} from "./discoverCategories";
import type { DiscoverCategory } from "./discoverCategories";

export interface DiscoverHandle {
  select: (dimension: FilmFacet, value: string) => void;
}

const FACET_PAGE_SIZE = 50;
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
  const { page, library, libraryState, toggleFavorite, openFilm, play } = useWorkspace();
  const root = useRef<HTMLDivElement>(null);
  const returnTo = useRef<{ name: string; top: number } | null>(null);
  const pendingPosition = useRef<{ top: number; name?: string } | null>(null);
  const [dimension, setDimension] = useState<DiscoverCategory>("女演员");
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedFacet, setSelectedFacet] = useState<FilmFacet | null>(null);
  const [query, setQuery] = useState("");
  const [search] = useDebouncedValue(query.trim(), 180);
  const [sort, setSort] = useState<"count" | "name">("count");
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set());
  const [pageNumber, setPageNumber] = useState(1);
  const [facetView] = useState(() => library.createFacetQuery(true));
  const [workView] = useState(() => library.createFilmQuery());
  const facetState = usePagedQuery(
    library,
    facetView,
    {
      dimension: discoverDimensions[dimension],
      query: search,
      sort,
      ...(onlyFavorites
        ? {
            names: [...favorites]
              .filter((name) => name.startsWith(`${dimension}:`))
              .map((name) => name.slice(dimension.length + 1)),
          }
        : {}),
    },
    page === "discover" && !selected && (libraryState.ready || !!library.catalog),
  );
  const works = usePagedQuery(
    library,
    workView,
    {
      facet: {
        dimension: selectedFacet
          ? metadataDimensions[selectedFacet]
          : discoverDimensions[dimension],
        value: selected ?? "",
      },
    },
    page === "discover" && !!selected && libraryState.ready,
  );
  const shownPage = facetState.ready
    ? Math.min(pageNumber, Math.max(1, Math.ceil(facetState.total / FACET_PAGE_SIZE)))
    : pageNumber;
  useEffect(() => {
    if (!selected)
      facetView.loadRange((shownPage - 1) * FACET_PAGE_SIZE, shownPage * FACET_PAGE_SIZE - 1);
  }, [facetView, shownPage, selected]);
  const shown = Array.from(
    {
      length: Math.max(
        0,
        Math.min(FACET_PAGE_SIZE, facetState.total - (shownPage - 1) * FACET_PAGE_SIZE),
      ),
    },
    (_, index) => facetState.items.get((shownPage - 1) * FACET_PAGE_SIZE + index),
  ).filter((item) => item !== undefined);
  const portraits = usePortraits(
    library.catalog,
    discoverDimensions[dimension],
    shown.map((item) => item.name),
    page === "discover" && !selected,
  );
  const labels = library.catalog?.getSnapshot().catalogs[discoverDimensions[dimension]].labels;
  const favoriteKey = (name: string) => `${dimension}:${name}`;
  const resetPosition = () => {
    setPageNumber(1);
    pendingPosition.current = { top: 0 };
  };
  const changeDimension = (next: DiscoverCategory) => {
    setDimension(next);
    setSelected(null);
    setSelectedFacet(null);
    setQuery("");
    setOnlyFavorites(false);
    returnTo.current = null;
    resetPosition();
  };
  useImperativeHandle(ref, () => ({
    select: (nextDimension, value) => {
      const category = categoryForFacet(
        nextDimension,
        value,
        library.catalog?.getSnapshot().catalogs,
      );
      changeDimension(category ?? dimension);
      if (!category) setSelectedFacet(nextDimension);
      setSelected(value);
    },
  }));
  useLayoutEffect(() => {
    const position = pendingPosition.current;
    if (page !== "discover" || !position) return;
    if (position.name && !facetState.ready) return;
    root.current?.closest(".page-content")?.scrollTo({ top: position.top });
    if (position.name) {
      Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[data-name]") ?? [])
        .find((button) => button.dataset.name === position.name)
        ?.focus({ preventScroll: true });
    }
    pendingPosition.current = null;
  });

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
            value={selectedFacet ? "" : dimension}
            onChange={(value) => changeDimension(value as DiscoverCategory)}
            data={[...discoverCategories]}
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
                  if (value === "count" || value === "name") setSort(value);
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
        {!selected && library.catalog && (
          <CatalogStatus service={library.catalog} dimension={discoverDimensions[dimension]} />
        )}
      </div>
      {!selected ? (
        <>
          <Text size="xs" c="dimmed" my="sm" aria-live="polite">
            {query.trim() || onlyFavorites
              ? `${facetState.total} / ${facetState.available}`
              : facetState.total}{" "}
            项
            {library.catalog &&
              (libraryState.available && libraryState.ready && !libraryState.error
                ? " · 数量为本地已收录影片数"
                : " · 本地影片数量尚不可用")}
          </Text>
          {portraits.progress && (
            <Text component="output" size="xs" c="dimmed" aria-live="polite" mb="sm">
              正在加载头像 {portraits.progress.completed}/{portraits.progress.total}…
            </Text>
          )}
          {facetState.error && (
            <Alert color="red" role="alert" mb="md">
              {facetState.error}
              <Button size="xs" variant="subtle" onClick={facetView.retry}>
                重试
              </Button>
            </Alert>
          )}
          {!facetState.error && (!facetState.ready || (facetState.loading && !shown.length)) ? (
            <Group component="output" justify="center" py="xl">
              <Loader size="sm" />
              <Text size="sm">正在读取条目…</Text>
            </Group>
          ) : shown.length ? (
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
                        pendingPosition.current = { top: 0 };
                      }}
                    >
                      {(dimension === "女演员" ||
                        dimension === "男演员" ||
                        dimension === "导演") && (
                        <Avatar
                          component="span"
                          size={34}
                          radius="xl"
                          variant="gradient"
                          gradient={avatarGradient(name)}
                          src={portraits.images[name]}
                          imageProps={{
                            loading: "lazy",
                            decoding: "async",
                            referrerPolicy: "no-referrer",
                          }}
                          aria-hidden="true"
                        >
                          {name.slice(-2)}
                        </Avatar>
                      )}
                      <Text span size="sm" fw={500} truncate style={{ flex: 1 }}>
                        {labels && Object.hasOwn(labels, name) ? labels[name] : name}
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
          ) : facetState.error ? null : (
            <Empty
              icon={onlyFavorites && !query.trim() ? "star" : "search"}
              title={
                query.trim()
                  ? `未找到匹配的${dimension}`
                  : onlyFavorites
                    ? `暂无收藏${dimension}`
                    : `暂无${dimension}`
              }
              description={
                facetState.available
                  ? "换个关键词，或显示全部条目。"
                  : isActorDirectoryDimension(discoverDimensions[dimension])
                    ? "AVWikiDB 名单更新后，条目会显示在这里。"
                    : "名单更新或本地资料入库后，条目会显示在这里。"
              }
            >
              {(query.trim() || onlyFavorites) && (
                <Button variant="subtle" size="xs" onClick={clearFilters}>
                  显示全部
                </Button>
              )}
            </Empty>
          )}
          {facetState.total > FACET_PAGE_SIZE && (
            <Group justify="center" py="md">
              <Pagination
                aria-label="发现条目分页"
                total={Math.ceil(facetState.total / FACET_PAGE_SIZE)}
                value={shownPage}
                onChange={(value) => {
                  setPageNumber(value);
                  pendingPosition.current = { top: 0 };
                }}
              />
            </Group>
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
                setSelectedFacet(null);
                pendingPosition.current = returnTo.current ?? { top: 0 };
              }}
            >
              返回{selectedFacet ? "发现" : dimension}
            </Button>
            <Title order={3} fz={18}>
              {selected}
            </Title>
            {selectedFacet && <Pill>{selectedFacet}</Pill>}
            <Pill>{works.total.toLocaleString()} 部</Pill>
          </Group>
          {works.error && (
            <Alert color="red" role="alert" mb="md">
              {works.error}
              <Button size="xs" variant="subtle" onClick={workView.retry}>
                重试
              </Button>
            </Alert>
          )}
          {!works.ready && !works.total && !works.error && (
            <Group component="output" justify="center" py="xl">
              <Loader size="sm" />
              <Text size="sm">正在读取影片…</Text>
            </Group>
          )}
          <FilmCollection
            items={works.items}
            count={works.total}
            onRangeChange={workView.loadRange}
            layout="poster"
            active={page === "discover"}
            openFilm={openFilm}
            play={play}
            toggleFavorite={toggleFavorite}
          />
          {works.ready && works.total === 0 && !works.error && (
            <Empty title="暂未收录" description="相关作品入库后会显示在这里。" />
          )}
        </section>
      )}
    </div>
  );
}
