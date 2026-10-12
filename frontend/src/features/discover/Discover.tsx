import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useDebouncedValue } from "@mantine/hooks";
import type { Ref } from "react";
import {
  ActionIcon,
  Alert,
  Avatar,
  Button,
  Group,
  Paper,
  Loader,
  SegmentedControl,
  Skeleton,
  Select,
  Slider,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { FilmCollection } from "../library/FilmCollection";
import type { FilmFacet } from "../films/filmMetadata";
import type { FacetValue } from "../../contracts/library";
import { useWorkspace } from "../../app/state";
import { Icon } from "../../components/icons";
import { CountTabs, Empty, Pill } from "../../components/ui";
import { VirtualGrid } from "../../components/VirtualGrid";
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
import { EntityAliasesModal } from "./EntityAliasesModal";
import { OnlineWorks } from "./OnlineWorks";
import { OnlineActorSearch } from "./OnlineActorSearch";
import { WorksProfile } from "./WorksProfile";
import { publicMessage } from "../../services/publicMessage";

export interface DiscoverHandle {
  select: (dimension: FilmFacet, value: string) => void;
}

const FACET_GAP = 12;
const FACET_CARD_HEIGHT = 66;
const facetColumns = (width: number) =>
  width >= 1500 ? 6 : width >= 1200 ? 5 : width >= 900 ? 4 : width >= 600 ? 3 : 2;
const facetCardHeight = () => FACET_CARD_HEIGHT;
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
const noSubscribe = () => () => {};
type WorksTab = "all" | "local" | "missing";
const CARD_WIDTH_KEY = "javm:discover-card-width";
const CARD_WIDTH = { min: 140, max: 640, fallback: 260 };
function readCardWidth() {
  try {
    const value = Number(localStorage.getItem(CARD_WIDTH_KEY));
    return Number.isFinite(value) && value >= CARD_WIDTH.min && value <= CARD_WIDTH.max
      ? value
      : CARD_WIDTH.fallback;
  } catch {
    return CARD_WIDTH.fallback;
  }
}
function saveCardWidth(value: number) {
  try {
    localStorage.setItem(CARD_WIDTH_KEY, String(value));
  } catch {
    /* 存储不可用时只在本次会话生效。 */
  }
}

export function Discover({ ref }: { ref: Ref<DiscoverHandle> }) {
  const { page, library, libraryState, toggleFavorite, openFilm, play, notice } = useWorkspace();
  const root = useRef<HTMLDivElement>(null);
  const returnTo = useRef<{ name: string; top: number } | null>(null);
  const pendingPosition = useRef<{ top: number; name?: string } | null>(null);
  const [dimension, setDimension] = useState<DiscoverCategory>("女演员");
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedFacet, setSelectedFacet] = useState<FilmFacet | null>(null);
  const [worksTab, setWorksTab] = useState<WorksTab>("all");
  const [worksFilter, setWorksFilter] = useState("");
  const [worksSearch] = useDebouncedValue(worksFilter.trim(), 250);
  const [cardWidth, setCardWidth] = useState(readCardWidth);
  const [query, setQuery] = useState("");
  const [search] = useDebouncedValue(query.trim(), 500);
  const onlineSearch =
    !!query.trim() && isActorDirectoryDimension(discoverDimensions[dimension]) && !!library.catalog;
  const [sort, setSort] = useState<"source" | "name" | "videoCount">("source");
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [aliasesOpened, setAliasesOpened] = useState(false);
  const [savingFavorites, setSavingFavorites] = useState<Set<string>>(() => new Set());
  const [range, setRange] = useState<[number, number]>([0, -1]);
  const [facetView] = useState(() => library.createFacetQuery(true));
  const [workView] = useState(() => library.createFilmQuery());
  const facetState = usePagedQuery(
    library,
    facetView,
    {
      dimension: discoverDimensions[dimension],
      query: search,
      sort,
      favoritesOnly: onlyFavorites,
    },
    page === "discover" && !selected && !onlineSearch && (libraryState.ready || !!library.catalog),
  );
  const onlineWorks = !selectedFacet && !!library.catalog;
  const worksFacet = {
    dimension: selectedFacet ? metadataDimensions[selectedFacet] : discoverDimensions[dimension],
    value: selected ?? "",
  };
  const works = usePagedQuery(
    library,
    workView,
    { facet: worksFacet, ...(onlineWorks && worksSearch ? { query: worksSearch } : {}) },
    page === "discover" && !!selected && libraryState.ready,
  );
  // 当前条目的收藏状态与作品总数：按名称检索目录，取名称完全一致的一项。
  const [entryView] = useState(() => library.createFacetQuery(true));
  const entryState = usePagedQuery(
    library,
    entryView,
    { dimension: discoverDimensions[dimension], query: selected ?? "", sort: "source" },
    page === "discover" && !!selected && onlineWorks,
  );
  let entry: FacetValue | undefined;
  for (const item of entryState.items.values())
    if (item.name === selected) {
      entry = item;
      break;
    }
  const worksState = useSyncExternalStore(
    library.catalog?.works.subscribe ?? noSubscribe,
    () => library.catalog?.works.getSnapshot() ?? null,
  );
  const onlineResult =
    worksState?.selection?.dimension === discoverDimensions[dimension] &&
    worksState.selection.name === selected
      ? worksState.result
      : null;
  // 本地已收录番号用于标记在线作品并计数；片库总数变化时重新读取。
  const [localCodes, setLocalCodes] = useState<{ key: string; codes: Set<string> } | null>(null);
  const localKey =
    selected && onlineWorks && libraryState.ready && libraryState.available && !libraryState.error
      ? JSON.stringify([worksFacet, libraryState.total])
      : "";
  useEffect(() => {
    if (!localKey || page !== "discover") return;
    const abort = new AbortController();
    const [facet] = JSON.parse(localKey) as [typeof worksFacet];
    library
      .facetCodes(facet, abort.signal)
      .then((codes) => {
        if (!abort.signal.aborted) setLocalCodes({ key: localKey, codes });
      })
      .catch(() => {
        if (!abort.signal.aborted) setLocalCodes(null);
      });
    return () => abort.abort();
  }, [library, localKey, page]);
  const currentLocalCodes = localCodes && localCodes.key === localKey ? localCodes.codes : null;
  const onlineTotal = onlineResult?.total ?? entry?.videoCount ?? undefined;
  const localCount = currentLocalCodes ? currentLocalCodes.size : null;
  const missingCount =
    onlineTotal !== undefined && localCount !== null
      ? Math.max(0, onlineTotal - localCount)
      : undefined;
  const selectedPortrait = usePortraits(
    library.catalog,
    discoverDimensions[dimension],
    selected ?? "",
    page === "discover" && !!selected && onlineWorks,
  );
  const changeRange = useCallback(
    (first: number, last: number) => {
      setRange((previous) =>
        previous[0] === first && previous[1] === last ? previous : [first, last],
      );
      facetView.loadRange(first, last);
    },
    [facetView],
  );
  const visibleNames: string[] = [];
  for (let index = range[0]; index <= range[1] && visibleNames.length < 100; index++) {
    const item = facetState.items.get(index);
    if (item) visibleNames.push(item.name);
  }
  // 快速滚动时只为停留的可见范围加载头像。
  const [portraitKey] = useDebouncedValue(visibleNames.join("\n"), 200);
  const portraits = usePortraits(
    library.catalog,
    discoverDimensions[dimension],
    portraitKey,
    page === "discover" && !selected && !onlineSearch,
  );
  const labels = library.catalog?.getSnapshot().catalogs[discoverDimensions[dimension]].labels;
  const favoriteKey = (name: string) => `${dimension}:${name}`;
  const toggleFacetFavorite = (name: string, favorite: boolean) => {
    const key = favoriteKey(name);
    setSavingFavorites((previous) => new Set(previous).add(key));
    void library
      .setFacetFavorite(discoverDimensions[dimension], name, !favorite)
      .catch((error: unknown) =>
        notice(error instanceof Error ? error.message : "收藏保存失败，请重试。"),
      )
      .finally(() =>
        setSavingFavorites((previous) => {
          const next = new Set(previous);
          next.delete(key);
          return next;
        }),
      );
  };
  const resetWorks = () => {
    setWorksTab("all");
    setWorksFilter("");
  };
  const resetPosition = () => {
    pendingPosition.current = { top: 0 };
  };
  const changeDimension = (next: DiscoverCategory) => {
    setDimension(next);
    setSelected(null);
    setSelectedFacet(null);
    resetWorks();
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
    if (position.name && !facetState.ready && !onlineSearch) return;
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
              {aliasesOpened && (
                <EntityAliasesModal library={library} onClose={() => setAliasesOpened(false)} />
              )}
              <Button
                size="xs"
                variant="subtle"
                disabled={!libraryState.ready || !libraryState.available}
                onClick={() => setAliasesOpened(true)}
              >
                名称管理
              </Button>
              <TextInput
                size="xs"
                w={200}
                aria-label={`搜索${dimension}`}
                placeholder={
                  isActorDirectoryDimension(discoverDimensions[dimension])
                    ? "在线搜索演员"
                    : `搜索${dimension}`
                }
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
                w={145}
                aria-label="发现排序"
                disabled={onlineSearch}
                value={onlineSearch ? "source" : sort}
                data={[
                  { value: "source", label: "网站顺序" },
                  { value: "name", label: "名称 A–Z" },
                  { value: "videoCount", label: "视频数量最多" },
                ]}
                allowDeselect={false}
                onChange={(value) => {
                  if (value === "source" || value === "name" || value === "videoCount")
                    setSort(value);
                  resetPosition();
                }}
              />
              <Button
                variant={onlyFavorites ? "light" : "subtle"}
                disabled={onlineSearch || !libraryState.available || !libraryState.ready}
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
        {!selected && !onlineSearch && library.catalog && (
          <CatalogStatus service={library.catalog} dimension={discoverDimensions[dimension]} />
        )}
      </div>
      {!selected && onlineSearch && library.catalog ? (
        <OnlineActorSearch
          service={library.catalog.actorSearch}
          query={search}
          active={page === "discover"}
          select={(entity) => {
            returnTo.current = {
              name: entity.name,
              top: root.current?.closest(".page-content")?.scrollTop ?? 0,
            };
            library.catalog!.works.selectEntity(discoverDimensions[dimension], entity);
            setSelected(entity.name);
            resetWorks();
            pendingPosition.current = { top: 0 };
          }}
        />
      ) : !selected ? (
        <>
          <Text size="xs" c="dimmed" my="sm" aria-live="polite">
            {query.trim() || onlyFavorites
              ? `${facetState.total} / ${facetState.available}`
              : facetState.total}{" "}
            项
            {library.catalog &&
              (libraryState.available && libraryState.ready && !libraryState.error
                ? " · 作品总数与本地已收录数量分别显示"
                : " · 本地影片数量尚不可用")}
            {sort === "videoCount" && " · 数量未知的条目排在最后"}
          </Text>
          {portraits.progress && (
            <Text component="output" size="xs" c="dimmed" aria-live="polite" mb="sm">
              正在加载头像 {portraits.progress.completed}/{portraits.progress.total}…
            </Text>
          )}
          {facetState.error && (
            <Alert color="red" role="alert" mb="md">
              {publicMessage(facetState.error)}
              <Button size="xs" variant="subtle" onClick={facetView.retry}>
                重试
              </Button>
            </Alert>
          )}
          {!facetState.error && (!facetState.ready || (facetState.loading && !facetState.total)) ? (
            <Group component="output" justify="center" py="xl">
              <Loader size="sm" />
              <Text size="sm">正在读取条目…</Text>
            </Group>
          ) : facetState.total ? (
            <VirtualGrid
              count={facetState.total}
              columns={facetColumns}
              rowHeight={facetCardHeight}
              gap={FACET_GAP}
              active={page === "discover"}
              getKey={(index) => facetState.items.get(index)?.name ?? `loading:${index}`}
              onRangeChange={changeRange}
              label={`${dimension}列表`}
              renderItem={(index) => {
                const item = facetState.items.get(index);
                if (!item)
                  return (
                    <Paper className="facet-card" withBorder radius="md" aria-busy="true">
                      <Skeleton height={14} width="70%" m="md" />
                    </Paper>
                  );
                const { name, count, videoCount, favorite: savedFavorite, label } = item;
                const favorite = !!savedFavorite;
                const localReady =
                  libraryState.available && libraryState.ready && !libraryState.error;
                const localCount = localReady ? count.toLocaleString() : "—";
                return (
                  <Paper className="facet-card" withBorder radius="md">
                    <UnstyledButton
                      className="facet-open"
                      data-name={name}
                      aria-label={`查看 ${name}，${videoCount == null ? "作品数量未知" : `作品 ${videoCount} 部`}，${localReady ? `本地已收录 ${count} 部` : "本地数量尚不可用"}`}
                      title={name}
                      onClick={() => {
                        returnTo.current = {
                          name,
                          top: root.current?.closest(".page-content")?.scrollTop ?? 0,
                        };
                        setSelected(name);
                        resetWorks();
                        pendingPosition.current = { top: 0 };
                      }}
                    >
                      {dimension === "女演员" && (
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
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <Text span size="sm" fw={500} truncate style={{ display: "block" }}>
                          {label || (labels && Object.hasOwn(labels, name) ? labels[name] : name)}
                        </Text>
                        <Text
                          span
                          size="xs"
                          c="dimmed"
                          style={{ display: "block", fontVariantNumeric: "tabular-nums" }}
                          title={`${videoCount == null ? "尚未取得作品总数" : `作品 ${videoCount.toLocaleString()} 部`} · ${localReady ? `本地已收录 ${localCount} 部` : "本地数量尚不可用"}`}
                        >
                          {videoCount == null
                            ? "数量未知"
                            : `${videoCount.toLocaleString()} 部作品`}
                          {" · "}本地 {localCount}
                        </Text>
                      </span>
                    </UnstyledButton>
                    <ActionIcon
                      color={favorite ? "champagne" : "gray"}
                      aria-label={`${favorite ? "取消收藏" : "收藏"}${dimension} ${name}`}
                      aria-pressed={favorite}
                      loading={savingFavorites.has(favoriteKey(name))}
                      disabled={!libraryState.available || !libraryState.ready}
                      onClick={() => toggleFacetFavorite(name, favorite)}
                    >
                      <Icon name="star" size={15} filled={favorite} />
                    </ActionIcon>
                  </Paper>
                );
              }}
            />
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
                    ? "演员名单更新后，条目会显示在这里。"
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
            {onlineWorks ? (
              <Text size="sm" c="dimmed">
                {dimension}：{selected}
              </Text>
            ) : (
              <>
                <Title order={3} fz={18}>
                  {selected}
                </Title>
                {selectedFacet && <Pill>{selectedFacet}</Pill>}
                <Pill>本地 {works.total.toLocaleString()} 部</Pill>
              </>
            )}
          </Group>
          {onlineWorks && library.catalog && (
            <>
              <WorksProfile
                name={selected}
                actor={isActorDirectoryDimension(discoverDimensions[dimension])}
                portrait={selectedPortrait.images[selected]}
                profile={onlineResult?.profile}
                total={onlineTotal}
                local={localCount}
                missing={missingCount}
                loading={!!worksState?.loading && !worksState.detail}
                onRefresh={library.catalog.works.retry}
                onCancel={library.catalog.works.cancel}
                favorite={entry ? !!entry.favorite : null}
                favoriteBusy={savingFavorites.has(favoriteKey(selected))}
                onToggleFavorite={
                  libraryState.available && libraryState.ready
                    ? () => entry && toggleFacetFavorite(selected, !!entry.favorite)
                    : undefined
                }
              />
              <div className="works-toolbar">
                <CountTabs
                  label="作品范围"
                  value={worksTab}
                  onChange={setWorksTab}
                  items={[
                    ["all", "全部", onlineTotal ?? onlineResult?.items.length ?? 0],
                    ["local", "本地", localCount ?? works.total],
                    ["missing", "缺失", missingCount ?? 0],
                  ]}
                />
                <Group gap="sm" wrap="nowrap" ml="auto">
                  <TextInput
                    size="xs"
                    w={180}
                    aria-label="过滤作品"
                    placeholder="过滤番号/名字"
                    leftSection={<Icon name="filter" size={14} />}
                    rightSection={
                      worksFilter ? (
                        <ActionIcon
                          size={22}
                          aria-label="清除作品过滤"
                          onClick={() => setWorksFilter("")}
                        >
                          <Icon name="close" size={13} />
                        </ActionIcon>
                      ) : undefined
                    }
                    value={worksFilter}
                    onChange={(event) => setWorksFilter(event.currentTarget.value)}
                  />
                  <Text size="xs" c="dimmed" component="label" htmlFor="discover-card-width">
                    卡片
                  </Text>
                  <Slider
                    id="discover-card-width"
                    w={120}
                    size="sm"
                    min={CARD_WIDTH.min}
                    max={CARD_WIDTH.max}
                    step={10}
                    label={null}
                    aria-label="封面大小"
                    value={cardWidth}
                    onChange={setCardWidth}
                    onChangeEnd={saveCardWidth}
                  />
                </Group>
              </div>
              <div hidden={worksTab === "local"}>
                <OnlineWorks
                  service={library.catalog.works}
                  name={selected}
                  dimension={discoverDimensions[dimension]}
                  active={page === "discover" && worksTab !== "local"}
                  filter={worksFilter}
                  scope={worksTab === "missing" ? "missing" : "all"}
                  localCodes={currentLocalCodes}
                  cardWidth={cardWidth}
                />
              </div>
            </>
          )}
          {(!onlineWorks || worksTab === "local") && (
            <>
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
                layout={onlineWorks ? "landscape" : "poster"}
                cardWidth={onlineWorks ? cardWidth : undefined}
                active={page === "discover"}
                openFilm={openFilm}
                play={play}
                toggleFavorite={toggleFavorite}
              />
              {works.ready && works.total === 0 && !works.error && (
                <Empty
                  title={worksSearch ? "无匹配作品" : "暂未收录"}
                  description={
                    worksSearch
                      ? "换个番号或名字再试。"
                      : "保存在线作品资料或导入本地视频后会显示在这里。"
                  }
                />
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
