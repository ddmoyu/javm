import { memo, useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  Table,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Film } from "./data";
import { Poster } from "./Cover";
import { Icon } from "./icons";
import { IconButton, Pill } from "./ui";
import { FilmMenuItems } from "./FilmMenu";
import { ObjectMenu, ObjectMenuButton, objectMenuKey } from "./ObjectMenu";
import { usePrototype } from "./state";

interface CollectionProps {
  films: Film[];
  layout: string;
  active: boolean;
  openFilm: (film: Film) => void;
  play: (film: Film) => void;
  toggleFavorite: (id: number) => void;
}

const GAP = 18;
const META_HEIGHT = 98;

const FilmCard = memo(function FilmCard({
  film,
  index,
  total,
  activateFilm,
  toggleFavorite,
  cardClickToPlay,
  remove,
  top,
  left,
  width,
  height,
}: {
  top: number;
  left: number;
  width: number;
  height: number;
  film: Film;
  index: number;
  total: number;
  activateFilm: CollectionProps["openFilm"];
  toggleFavorite: CollectionProps["toggleFavorite"];
  cardClickToPlay: boolean;
  remove: () => void;
}) {
  const statsId = useId();
  return (
    <ObjectMenu items={<FilmMenuItems film={film} remove={remove} />}>
      <li
        style={{ transform: `translateY(${top}px)`, left, width, height }}
        aria-posinset={index + 1}
        aria-setsize={total}
        data-film-id={film.id}
        className="film-card"
      >
        <UnstyledButton
          className="film-card-open"
          aria-label={`${cardClickToPlay ? "播放" : "查看详情"} ${film.code} ${film.title}`}
          aria-describedby={statsId}
          title={`${cardClickToPlay ? "单击播放" : "单击查看详情"} · 右键管理`}
          onKeyDown={objectMenuKey}
          onClick={() => activateFilm(film)}
        >
          <span className="film-cover">
            <Poster film={film} />
            <span className="cover-hover">
              <span className="cover-hint">{cardClickToPlay ? "播放影片" : "查看详情"}</span>
              <span className="cover-stats" id={statsId}>
                <span className={film.rating == null ? undefined : "cover-rating"}>
                  <Icon name="star" size={14} filled={film.rating != null} />
                  {film.rating == null ? "暂无评分" : `${film.rating.toFixed(1)} 分`}
                </span>
                <span>
                  <Icon name="clock" size={14} />
                  {film.duration > 0 ? `${film.duration} 分钟` : "时长未知"}
                </span>
              </span>
            </span>
            <Badge
              className="cover-quality"
              size="xs"
              radius="sm"
              variant="filled"
              color={film.quality === "4K" ? "champagne.5" : "dark.6"}
              c={film.quality === "4K" ? "dark.9" : "gray.2"}
            >
              {film.quality}
            </Badge>
            {film.missing && (
              <Badge
                className="cover-warning"
                size="sm"
                radius="sm"
                variant="filled"
                color="dark.8"
                c="champagne.4"
                leftSection={<Icon name="warning" size={11} />}
              >
                资料待补全
              </Badge>
            )}
          </span>
          <Text span size="xs" c="dimmed" ff="monospace" className="film-code">
            {film.code}
          </Text>
          <Text span fw={600} size="sm" truncate className="film-title">
            {film.title}
          </Text>
          <span className="film-meta">
            <Text span size="xs" c="dimmed" truncate>
              {film.actor}
            </Text>
            <Text span size="xs" c="dimmed" style={{ flex: "none" }}>
              {film.year} · {film.genre}
            </Text>
          </span>
        </UnstyledButton>
        <ActionIcon
          className="cover-favorite"
          radius="xl"
          size={30}
          variant={film.favorite ? "filled" : "transparent"}
          color={film.favorite ? "rouge" : "dark"}
          aria-label={`${film.favorite ? "取消收藏" : "收藏"} ${film.code}`}
          aria-pressed={film.favorite}
          onClick={() => toggleFavorite(film.id)}
        >
          <Icon name="heart" size={16} filled={film.favorite} />
        </ActionIcon>
        <div className="film-card-menu" style={{ top: width * 1.39 + 6 }}>
          <ObjectMenuButton label={`${film.code} 更多操作`} />
        </div>
      </li>
    </ObjectMenu>
  );
});

export function FilmCollection({
  films,
  layout,
  active,
  openFilm,
  play,
  toggleFavorite,
}: CollectionProps) {
  const { setFilms, notice, cardClickToPlay } = usePrototype();
  const activateFilm = useCallback(
    (film: Film) => (cardClickToPlay ? play(film) : openFilm(film)),
    [cardClickToPlay, play, openFilm],
  );
  const [removing, setRemoving] = useState<Film | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState({ width: 900, margin: 0 });
  const poster = layout === "poster";
  const columns = poster ? Math.max(2, Math.min(8, Math.floor((geometry.width + GAP) / 188))) : 1;
  const cardWidth = (geometry.width - (columns - 1) * GAP) / columns;
  const rowHeight = poster ? cardWidth * 1.39 + META_HEIGHT : 72;
  const getScrollElement = useCallback(
    () => rootRef.current?.closest<HTMLElement>(".page-content") ?? null,
    [],
  );
  const measureGeometry = useCallback(() => {
    const element = rootRef.current;
    const scrollElement = getScrollElement();
    if (!active || !element || !scrollElement || element.clientWidth === 0) return;
    const width = element.clientWidth;
    const margin =
      element.getBoundingClientRect().top -
      scrollElement.getBoundingClientRect().top +
      scrollElement.scrollTop +
      (poster ? 0 : 40);
    setGeometry((previous) =>
      previous.width === width && previous.margin === margin ? previous : { width, margin },
    );
  }, [active, getScrollElement, poster]);
  // 筛选条件、工具栏换行、主题和窗口大小都可能改变列表起点。
  useLayoutEffect(measureGeometry);
  useLayoutEffect(() => {
    const scrollElement = getScrollElement();
    if (!active || !rootRef.current || !scrollElement) return;
    const observer = new ResizeObserver(measureGeometry);
    observer.observe(rootRef.current);
    observer.observe(scrollElement);
    return () => observer.disconnect();
  }, [active, getScrollElement, measureGeometry]);
  const getItemKey = useCallback(
    (index: number) => `${columns}:${films[index * columns]?.id}`,
    [columns, films],
  );
  // oxlint-disable-next-line react/incompatible-library -- TanStack Virtual 官方 API，当前工程未启用 React Compiler。
  const virtualizer = useVirtualizer({
    count: Math.ceil(films.length / columns),
    getScrollElement,
    estimateSize: () => rowHeight,
    getItemKey,
    overscan: poster ? 2 : 6,
    scrollMargin: geometry.margin,
    enabled: active,
  });
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);
  const rows = virtualizer.getVirtualItems();
  const first = rows[0];
  const last = rows.at(-1);
  const totalHeight = virtualizer.getTotalSize();
  return (
    <>
      <div ref={rootRef} className={poster ? "virtual-posters" : "table-shell"}>
        {poster ? (
          <ul className="virtual-canvas" aria-label="影片海报" style={{ height: totalHeight }}>
            {rows.flatMap((row) =>
              films
                .slice(row.index * columns, (row.index + 1) * columns)
                .map((film, offset) => (
                  <FilmCard
                    key={film.id}
                    film={film}
                    index={row.index * columns + offset}
                    total={films.length}
                    activateFilm={activateFilm}
                    toggleFavorite={toggleFavorite}
                    cardClickToPlay={cardClickToPlay}
                    remove={() => setRemoving(film)}
                    top={row.start - geometry.margin}
                    left={offset * (cardWidth + GAP)}
                    width={cardWidth}
                    height={rowHeight}
                  />
                )),
            )}
          </ul>
        ) : (
          <Table
            aria-label="影片列表"
            aria-rowcount={films.length + 1}
            highlightOnHover
            verticalSpacing={10}
            horizontalSpacing="md"
            layout="fixed"
          >
            <Table.Thead>
              <Table.Tr aria-rowindex={1}>
                <Table.Th w="38%">影片</Table.Th>
                <Table.Th w="16%">演员</Table.Th>
                <Table.Th w="17%">画质 / 大小</Table.Th>
                <Table.Th w="15%">资料状态</Table.Th>
                <Table.Th w="14%">操作</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {first && (
                <Table.Tr aria-hidden="true">
                  <Table.Td
                    colSpan={5}
                    p={0}
                    style={{ height: Math.max(0, first.start - geometry.margin), border: 0 }}
                  />
                </Table.Tr>
              )}
              {rows.map((row) => {
                const film = films[row.index]!;
                return (
                  <ObjectMenu
                    key={film.id}
                    items={<FilmMenuItems film={film} remove={() => setRemoving(film)} />}
                  >
                    <Table.Tr
                      aria-rowindex={row.index + 2}
                      data-film-id={film.id}
                      className="clickable-row"
                      tabIndex={0}
                      onClick={(event) => {
                        const target = event.target;
                        if (!(target instanceof Element) || target.closest("button, input, label"))
                          return;
                        activateFilm(film);
                      }}
                      onKeyDown={(event) => {
                        if (objectMenuKey(event)) return;
                        if (
                          (event.key === "Enter" || event.key === " ") &&
                          event.target === event.currentTarget
                        ) {
                          event.preventDefault();
                          activateFilm(film);
                        }
                      }}
                    >
                      <Table.Td>
                        <Group gap="sm" wrap="nowrap">
                          <UnstyledButton
                            className="mini-poster"
                            aria-label={`${cardClickToPlay ? "播放" : "查看详情"} ${film.code} 封面`}
                            onKeyDown={objectMenuKey}
                            onClick={() => activateFilm(film)}
                          >
                            <Poster film={film} compact />
                          </UnstyledButton>
                          <UnstyledButton
                            onClick={() => activateFilm(film)}
                            onKeyDown={objectMenuKey}
                            style={{ minWidth: 0 }}
                          >
                            <Text size="sm" fw={600} truncate>
                              {film.title}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {film.code} · {film.year}
                            </Text>
                          </UnstyledButton>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" truncate>
                          {film.actor}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{film.quality}</Text>
                        <Text size="xs" c="dimmed">
                          {film.size}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Pill tone={film.missing ? "warning" : "success"}>
                          {film.missing ? "待补全" : "完整"}
                        </Pill>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={2} wrap="nowrap">
                          <IconButton
                            icon="play"
                            label={`播放 ${film.code}`}
                            onClick={() => play(film)}
                          />
                          <ObjectMenuButton label={`${film.code} 更多操作`} />
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  </ObjectMenu>
                );
              })}
              {last && (
                <Table.Tr aria-hidden="true">
                  <Table.Td
                    colSpan={5}
                    p={0}
                    style={{
                      height: Math.max(0, totalHeight - (last.end - geometry.margin)),
                      border: 0,
                    }}
                  />
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        )}
      </div>
      <Modal
        opened={removing !== null}
        onClose={() => setRemoving(null)}
        title="从片库移除"
        centered
      >
        <Text size="sm">移除“{removing?.title}”的片库记录？</Text>
        <Text size="sm" c="dimmed" mt={4}>
          原视频、封面和 NFO 文件会保留。
        </Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setRemoving(null)}>
            取消
          </Button>
          <Button
            color="red"
            onClick={() => {
              setFilms((previous) => previous.filter((film) => film.id !== removing?.id));
              setRemoving(null);
              notice("影片已从片库移除");
            }}
          >
            移除
          </Button>
        </Group>
      </Modal>
    </>
  );
}
