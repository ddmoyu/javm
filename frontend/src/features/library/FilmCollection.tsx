import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  Skeleton,
  Table,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Film } from "../../contracts/media";
import { Poster } from "../../components/Cover";
import { Icon } from "../../components/icons";
import { IconButton, Pill } from "../../components/ui";
import { FilmMenuItems } from "../films/FilmMenu";
import { ObjectMenu, ObjectMenuButton, objectMenuKey } from "../../components/ObjectMenu";
import { useWorkspace } from "../../app/state";

export type FilmLayout = "poster" | "landscape" | "list";

interface CollectionProps {
  items: ReadonlyMap<number, Film>;
  count: number;
  onRangeChange: (first: number, last: number) => void;
  layout: FilmLayout;
  active: boolean;
  openFilm: (film: Film) => void;
  play: (film: Film) => void;
  toggleFavorite: (film: Film) => void;
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
  remove: (film: Film) => void;
}) {
  const statsId = useId();
  cardClickToPlay =
    cardClickToPlay &&
    (film.files?.some((file) => file.kind === "video" && !file.missing) ?? false);
  return (
    <ObjectMenu items={<FilmMenuItems film={film} remove={() => remove(film)} />}>
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
                  {film.rating == null ? "暂无评分" : `${film.rating.toFixed(1)} / 5`}
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
              {film.availability === "metadata_only"
                ? "未下载"
                : film.availability === "unavailable"
                  ? "文件不可用"
                  : film.quality}
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
          onClick={() => toggleFavorite(film)}
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

const FilmRow = memo(function FilmRow({
  film,
  index,
  activateFilm,
  cardClickToPlay,
  play,
  remove,
}: {
  film: Film;
  index: number;
  activateFilm: (film: Film) => void;
  cardClickToPlay: boolean;
  play: (film: Film) => void;
  remove: (film: Film) => void;
}) {
  return (
    <ObjectMenu items={<FilmMenuItems film={film} remove={() => remove(film)} />}>
      <Table.Tr
        aria-rowindex={index + 2}
        data-film-id={film.id}
        className="clickable-row"
        style={{ height: 72 }}
        tabIndex={0}
        onClick={(event) => {
          const target = event.target;
          if (!(target instanceof Element) || target.closest("button, input, label")) return;
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
          <Text size="sm">
            {film.availability === "metadata_only"
              ? "未下载"
              : film.availability === "unavailable"
                ? "文件不可用"
                : film.quality}
          </Text>
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
              disabled={!film.files?.some((file) => file.kind === "video" && !file.missing)}
              onClick={() => play(film)}
            />
            <ObjectMenuButton label={`${film.code} 更多操作`} />
          </Group>
        </Table.Td>
      </Table.Tr>
    </ObjectMenu>
  );
});

export function FilmCollection({
  items,
  count,
  onRangeChange,
  layout,
  active,
  openFilm,
  play,
  toggleFavorite,
}: CollectionProps) {
  const { notice, cardClickToPlay, library } = useWorkspace();
  const activateFilm = useCallback(
    (film: Film) =>
      cardClickToPlay && film.files?.some((file) => file.kind === "video" && !file.missing)
        ? play(film)
        : openFilm(film),
    [cardClickToPlay, play, openFilm],
  );
  const [removing, setRemoving] = useState<Film | null>(null);
  const [removalBusy, setRemovalBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState({ width: 900, margin: 0 });
  const poster = layout !== "list";
  const landscape = layout === "landscape";
  const columns = poster
    ? Math.max(
        landscape ? 1 : 2,
        Math.min(8, Math.floor((geometry.width + GAP) / (landscape ? 300 : 188))),
      )
    : 1;
  const cardWidth = (geometry.width - (columns - 1) * GAP) / columns;
  const coverHeight = cardWidth * (landscape ? 9 / 16 : 1.39);
  const rowHeight = poster ? coverHeight + META_HEIGHT : 72;
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
  const getItemKey = useCallback((index: number) => `${columns}:${index}`, [columns]);
  // oxlint-disable-next-line react/incompatible-library -- TanStack Virtual 官方 API，当前工程未启用 React Compiler。
  const virtualizer = useVirtualizer({
    count: Math.ceil(count / columns),
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
  const firstIndex = first?.index ?? 0;
  const lastIndex = last?.index ?? 0;
  useEffect(() => {
    if (active && count)
      onRangeChange(firstIndex * columns, Math.min(count - 1, (lastIndex + 1) * columns - 1));
  }, [active, count, columns, firstIndex, lastIndex, onRangeChange]);
  return (
    <>
      <div
        ref={rootRef}
        className={poster ? "virtual-posters" : "table-shell"}
        data-cover-layout={landscape ? "landscape" : "portrait"}
      >
        {poster ? (
          <ul className="virtual-canvas" aria-label="影片海报" style={{ height: totalHeight }}>
            {rows.flatMap((row) =>
              Array.from(
                { length: Math.min(columns, count - row.index * columns) },
                (_, offset) => {
                  const index = row.index * columns + offset;
                  const film = items.get(index);
                  if (!film)
                    return (
                      <li
                        key={`loading:${index}`}
                        className="film-card"
                        aria-label="正在加载影片"
                        aria-busy="true"
                        style={{
                          transform: `translateY(${row.start - geometry.margin}px)`,
                          left: offset * (cardWidth + GAP),
                          width: cardWidth,
                          height: rowHeight,
                        }}
                      >
                        <Skeleton height={coverHeight} />
                        <Skeleton height={14} mt={12} width="80%" />
                        <Skeleton height={12} mt={10} width="60%" />
                      </li>
                    );
                  return (
                    <FilmCard
                      key={film.id}
                      film={film}
                      index={row.index * columns + offset}
                      total={count}
                      activateFilm={activateFilm}
                      toggleFavorite={toggleFavorite}
                      cardClickToPlay={cardClickToPlay}
                      remove={setRemoving}
                      top={row.start - geometry.margin}
                      left={offset * (cardWidth + GAP)}
                      width={cardWidth}
                      height={rowHeight}
                    />
                  );
                },
              ),
            )}
          </ul>
        ) : (
          <Table
            aria-label="影片列表"
            aria-rowcount={count + 1}
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
                const film = items.get(row.index);
                if (!film)
                  return (
                    <Table.Tr
                      key={`loading:${row.index}`}
                      aria-rowindex={row.index + 2}
                      aria-busy="true"
                      style={{ height: 72 }}
                    >
                      <Table.Td colSpan={5}>
                        <Skeleton height={36} aria-label="正在加载影片" />
                      </Table.Td>
                    </Table.Tr>
                  );
                return (
                  <FilmRow
                    key={film.id}
                    film={film}
                    index={row.index}
                    activateFilm={activateFilm}
                    cardClickToPlay={cardClickToPlay}
                    play={play}
                    remove={setRemoving}
                  />
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
        onClose={() => !removalBusy && setRemoving(null)}
        title="从片库移除"
        centered
        closeOnClickOutside={!removalBusy}
        closeOnEscape={!removalBusy}
      >
        <Text size="sm">移除“{removing?.title}”的片库记录？</Text>
        <Text size="sm" c="dimmed" mt={4}>
          封面和 NFO 文件会保留；有关联视频的作品需先在媒体清理中处理视频。
        </Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" disabled={removalBusy} onClick={() => setRemoving(null)}>
            取消
          </Button>
          <Button
            color="red"
            loading={removalBusy}
            onClick={() => {
              if (!removing || removalBusy) return;
              setRemovalBusy(true);
              void library
                .removeWork(removing.id)
                .then(() => {
                  setRemoving(null);
                  notice("已移出片库，资料文件已保留。");
                })
                .catch((error: unknown) =>
                  notice(error instanceof Error ? error.message : "移除失败"),
                )
                .finally(() => setRemovalBusy(false));
            }}
          >
            移除
          </Button>
        </Group>
      </Modal>
    </>
  );
}
