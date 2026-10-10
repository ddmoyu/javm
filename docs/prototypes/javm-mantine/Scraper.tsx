import { useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { Ref } from "react";
import {
  Button,
  Group,
  Loader,
  Menu,
  Pagination,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import type { Film } from "./data";
import { getFilmMetadata } from "./filmMetadata";
import { usePrototype } from "./state";
import { Poster } from "./Cover";
import { Icon } from "./icons";
import { Empty, IconButton, Pill } from "./ui";
import { ObjectMenu, ObjectMenuButton, objectMenuKey } from "./ObjectMenu";
import { BatchScraper } from "./BatchScraper";
import { ScraperMetadata } from "./ScraperMetadata";
import { SearchMovieInfo } from "./SearchMovieInfo";
import { SearchResources } from "./SearchResources";
import { useResourceSearch } from "./useResourceSearch";
import { createResourcePacket, resourcePageSize } from "./resourceSearch";
import type { ResourceMatch } from "./resourceSearch";

export interface ScraperHandle {
  select: (film: Film, view: "match" | "links") => void;
}

const orderMatches = (matches: ResourceMatch[], scope: string, sort: string) => {
  const result = matches.filter(
    (match) => scope === "all" || (scope === "library" ? !!match.libraryId : !match.libraryId),
  );
  if (sort === "code") result.sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
  if (sort === "year") result.sort((a, b) => (b.film?.year ?? 0) - (a.film?.year ?? 0));
  return result;
};

export function Scraper({ ref }: { ref: Ref<ScraperHandle> }) {
  const { films, notice } = usePrototype();
  const { session, start, ensure, stop, retry, searching } = useResourceSearch(films);
  const [search, setSearch] = useState("JVM");
  const [tab, setTab] = useState<string | null>("search");
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [scope, setScope] = useState("all");
  const [sort, setSort] = useState<string | null>("relevance");
  const [sent, setSent] = useState<Set<string>>(() => new Set());
  const [metadataId, setMetadataId] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const listPosition = useRef(0);
  const returnCode = useRef<string | null>(null);
  const matches = orderMatches(session.matches, scope, sort ?? "relevance");
  const totalPages = Math.max(1, Math.ceil(matches.length / resourcePageSize));
  const pageMatches = matches.slice((page - 1) * resourcePageSize, page * resourcePageSize);
  const selected = session.matches.find((match) => match.code === selectedCode);
  const selectedIndex = matches.findIndex((match) => match.code === selectedCode);
  const target = films.find((film) => film.id === selected?.libraryId);
  const packet = selected ? (session.packets[selected.code] ?? createResourcePacket()) : null;
  const metadataFilm = films.find((film) => film.id === metadataId);

  useLayoutEffect(() => {
    if (!detailOpen) return;
    detailRef.current?.scrollTo({ top: 0 });
    backRef.current?.focus({ preventScroll: true });
  }, [detailOpen, selectedCode]);
  useLayoutEffect(() => {
    if (detailOpen || !returnCode.current) return;
    const button = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("[data-search-code]") ?? [],
    ).find((item) => item.dataset.searchCode === returnCode.current);
    listRef.current?.scrollTo({ top: listPosition.current });
    button?.focus({ preventScroll: true });
    returnCode.current = null;
  }, [detailOpen]);

  const openMatch = (match: ResourceMatch) => {
    if (!detailOpen) listPosition.current = listRef.current?.scrollTop ?? 0;
    ensure([match]);
    setSelectedCode(match.code);
    setDetailOpen(true);
    detailRef.current?.scrollTo({ top: 0 });
  };
  const back = () => {
    returnCode.current = selectedCode;
    setDetailOpen(false);
  };
  const runSearch = (query: string) => {
    if (!query.trim()) return;
    setSearch(query);
    setSelectedCode(null);
    setDetailOpen(false);
    setScope("all");
    setSort("relevance");
    setPage(1);
    listPosition.current = 0;
    listRef.current?.scrollTo({ top: 0 });
    return start(query);
  };
  useImperativeHandle(ref, () => ({
    select(film, view) {
      setTab("search");
      const result = runSearch(film.code);
      const match = result?.find((item) => item.code === film.code);
      if (match) {
        setSelectedCode(match.code);
        setDetailOpen(true);
      }
      if (view === "match") setMetadataId(film.id);
    },
  }));
  const changePage = (next: number) => {
    setPage(next);
    listPosition.current = 0;
    listRef.current?.scrollTo({ top: 0 });
    ensure(matches.slice((next - 1) * resourcePageSize, next * resourcePageSize));
  };
  const changeResults = (nextScope: string, nextSort: string) => {
    setScope(nextScope);
    setSort(nextSort);
    setPage(1);
    listPosition.current = 0;
    listRef.current?.scrollTo({ top: 0 });
    ensure(orderMatches(session.matches, nextScope, nextSort).slice(0, resourcePageSize));
  };
  const adjacent = (step: number) => {
    const next = matches[selectedIndex + step];
    if (!next) return;
    const nextPage = Math.floor((selectedIndex + step) / resourcePageSize) + 1;
    if (nextPage !== page) changePage(nextPage);
    openMatch(next);
  };
  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      notice("番号已复制");
    } catch {
      notice("复制失败，请重试");
    }
  };

  return (
    <>
      <Tabs value={tab} onChange={setTab} keepMounted className="fill-column">
        <Tabs.List mb="md">
          <Tabs.Tab value="search" leftSection={<Icon name="search" size={16} />}>
            搜索资源
          </Tabs.Tab>
          <Tabs.Tab value="batch" leftSection={<Icon name="scan" size={16} />}>
            批量刮削
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="search" className="fill-column">
          <div className="fill-column" hidden={detailOpen}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                runSearch(search);
              }}
            >
              <Group gap="sm" wrap="nowrap">
                <TextInput
                  aria-label="搜索番号、片名或演员"
                  placeholder="搜索番号、片名或演员"
                  leftSection={<Icon name="search" size={17} />}
                  value={search}
                  onChange={(event) => setSearch(event.currentTarget.value)}
                  rightSection={
                    search ? (
                      <IconButton label="清空搜索" icon="close" onClick={() => setSearch("")} />
                    ) : null
                  }
                  size="md"
                  style={{ flex: 1 }}
                />
                <Button
                  type="submit"
                  size="md"
                  disabled={!search.trim()}
                  leftSection={<Icon name="search" size={16} />}
                >
                  搜索
                </Button>
                {searching && (
                  <Button variant="default" size="md" onClick={stop}>
                    停止
                  </Button>
                )}
              </Group>
            </form>
            <Group justify="space-between" my="md">
              <Group gap={8}>
                <Text size="sm" c="dimmed">
                  {matches.length.toLocaleString()} 部影片
                </Text>
                {searching && <Loader size={12} />}
              </Group>
              <Group gap="xs">
                <SegmentedControl
                  aria-label="结果入库状态"
                  size="xs"
                  value={scope}
                  onChange={(value) => changeResults(value, sort ?? "relevance")}
                  data={[
                    { value: "all", label: "全部" },
                    { value: "new", label: "未入库" },
                    { value: "library", label: "已在片库" },
                  ]}
                />
                <Select
                  aria-label="影片结果排序"
                  size="xs"
                  w={110}
                  value={sort}
                  onChange={(value) => value && changeResults(scope, value)}
                  allowDeselect={false}
                  data={[
                    { value: "relevance", label: "相关度" },
                    { value: "year", label: "最近发行" },
                    { value: "code", label: "番号排序" },
                  ]}
                />
              </Group>
            </Group>
            <div className="scroll-pane" ref={listRef} aria-label="影片搜索结果">
              <SimpleGrid
                component="ul"
                type="container"
                cols={{ base: 1, "720px": 2, "1280px": 3 }}
                spacing="sm"
                className="plain-list"
              >
                {pageMatches.map((match) => {
                  const film = match.film;
                  const info = film
                    ? getFilmMetadata({ ...film, metadata: undefined, missing: false })
                    : null;
                  const result = session.packets[match.code];
                  const magnets =
                    result?.resources.filter((item) => item.kind === "magnet").length ?? 0;
                  const videos =
                    result?.resources.filter((item) => item.kind === "online").length ?? 0;
                  const resourceBusy =
                    !result || Object.values(result.sources).includes("searching");
                  const failed =
                    result && Object.values(result.sources).some((status) => status === "error");
                  return (
                    <ObjectMenu
                      key={match.code}
                      items={
                        <>
                          <Menu.Item onClick={() => openMatch(match)}>查看资料与资源</Menu.Item>
                          <Menu.Item onClick={() => void copyCode(match.code)}>复制番号</Menu.Item>
                          {match.libraryId && (
                            <Menu.Item onClick={() => setMetadataId(match.libraryId!)}>
                              补全片库资料
                            </Menu.Item>
                          )}
                        </>
                      }
                    >
                      <Paper component="li" withBorder radius="md" className="result-card">
                        <UnstyledButton
                          className="result-open"
                          data-search-code={match.code}
                          aria-label={`${match.code} ${film?.title ?? "未匹配资料"}，查看资料与资源`}
                          onClick={() => openMatch(match)}
                          onKeyDown={objectMenuKey}
                        >
                          <span className="result-poster">
                            {film ? (
                              <Poster film={film} compact />
                            ) : (
                              <Icon name="image" size={24} />
                            )}
                          </span>
                          <Stack gap={5} style={{ flex: 1, minWidth: 0 }}>
                            <Group gap={8} wrap="nowrap">
                              <Text size="xs" ff="monospace" c="dimmed">
                                {match.code}
                              </Text>
                              <Pill tone={match.libraryId ? "success" : "neutral"}>
                                {match.libraryId ? "已在片库" : "未入库"}
                              </Pill>
                              {(match.metadataSources?.length ?? 0) > 1 && (
                                <Text
                                  size="xs"
                                  c="dimmed"
                                  title={match.metadataSources!.join("、")}
                                >
                                  {match.metadataSources!.length} 个来源
                                </Text>
                              )}
                            </Group>
                            <Text fw={600} truncate>
                              {film?.title ?? "影片资料未匹配"}
                            </Text>
                            <Text size="xs" c="dimmed" truncate>
                              {film
                                ? `${film.actor ?? "演员未知"} · ${film.year} · ${film.duration} 分钟`
                                : "可查看已找到的资源"}
                            </Text>
                            <Group gap={8}>
                              <Text size="xs" c="dimmed">
                                {info?.studio ?? "资料待获取"}
                              </Text>
                              {film?.rating !== undefined && (
                                <Group gap={3} c="champagne.4">
                                  <Icon name="star" size={11} filled />
                                  <Text size="xs" fw={600}>
                                    {film.rating.toFixed(1)}
                                  </Text>
                                </Group>
                              )}
                            </Group>
                            <Group gap="sm" c="dimmed">
                              <Group gap={4}>
                                <Icon name="magnet" size={12} />
                                <Text size="xs">
                                  {resourceBusy && !magnets ? "磁力查询中" : `${magnets} 条磁力`}
                                </Text>
                              </Group>
                              <Group gap={4}>
                                <Icon name="play" size={12} />
                                <Text size="xs">
                                  {resourceBusy && !videos ? "视频查询中" : `${videos} 个视频`}
                                </Text>
                              </Group>
                              {resourceBusy && <Loader size={10} />}
                              {failed && (
                                <Text size="xs" c="champagne.4">
                                  来源待重试
                                </Text>
                              )}
                            </Group>
                          </Stack>
                          <Icon name="chevron" size={16} />
                        </UnstyledButton>
                        <span className="result-more">
                          <ObjectMenuButton label={`${match.code} 搜索结果更多操作`} />
                        </span>
                      </Paper>
                    </ObjectMenu>
                  );
                })}
              </SimpleGrid>
              {!matches.length && (
                <Empty
                  title="没有匹配的影片"
                  description={
                    scope === "all" ? "试试其他番号、片名或演员。" : "切换入库状态可查看其他结果。"
                  }
                >
                  {scope !== "all" && (
                    <Button
                      size="xs"
                      variant="default"
                      onClick={() => changeResults("all", sort ?? "relevance")}
                    >
                      显示全部结果
                    </Button>
                  )}
                </Empty>
              )}
            </div>
            <Group justify="space-between" pt="md">
              <Text size="xs" c="dimmed">
                {matches.length ? (page - 1) * resourcePageSize + 1 : 0}–
                {Math.min(page * resourcePageSize, matches.length)} /{" "}
                {matches.length.toLocaleString()}
              </Text>
              <Pagination
                aria-label="影片搜索分页"
                value={page}
                onChange={changePage}
                total={totalPages}
                size="sm"
                radius="md"
                siblings={1}
                boundaries={1}
                getItemProps={(value) => ({ "aria-label": `搜索结果第 ${value} 页` })}
              />
            </Group>
          </div>
          <div className="fill-column" hidden={!detailOpen}>
            <Group justify="space-between" mb="sm">
              <Button
                ref={backRef}
                size="xs"
                variant="subtle"
                color="gray"
                leftSection={<Icon name="arrow" size={16} />}
                onClick={back}
              >
                返回结果
              </Button>
              <Group gap={4}>
                <Text size="xs" c="dimmed" mr={6}>
                  {selectedIndex + 1} / {matches.length.toLocaleString()}
                </Text>
                <IconButton
                  icon="chevronLeft"
                  label="上一部搜索影片"
                  disabled={selectedIndex <= 0}
                  onClick={() => adjacent(-1)}
                />
                <IconButton
                  icon="chevron"
                  label="下一部搜索影片"
                  disabled={selectedIndex < 0 || selectedIndex >= matches.length - 1}
                  onClick={() => adjacent(1)}
                />
              </Group>
            </Group>
            <div className="scroll-pane" ref={detailRef}>
              {selected && packet && (
                <Stack gap="lg">
                  <SearchMovieInfo
                    key={`info:${selected.code}`}
                    match={selected}
                    packet={packet}
                    localFilm={target}
                    onFill={() => target && setMetadataId(target.id)}
                  />
                  <SearchResources
                    key={`resources:${selected.code}`}
                    packet={packet}
                    target={target}
                    retry={(source) => retry(selected.code, source)}
                    sent={sent}
                    setSent={setSent}
                  />
                </Stack>
              )}
            </div>
          </div>
        </Tabs.Panel>
        <Tabs.Panel value="batch">
          <BatchScraper />
        </Tabs.Panel>
      </Tabs>
      {metadataFilm && (
        <ScraperMetadata
          key={metadataFilm.id}
          film={metadataFilm}
          onClose={() => setMetadataId(null)}
        />
      )}
    </>
  );
}
