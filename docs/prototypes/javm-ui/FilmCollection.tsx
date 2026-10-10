import { memo, useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { Button, Modal } from "@mantine/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Film } from "./data";
import { Icon, Poster } from "./visuals";
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
        <button
          className="film-card-open"
          type="button"
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
                <span className={film.rating == null ? "cover-unrated" : "cover-rating"}>
                  <Icon name="star" size={14} />
                  {film.rating == null ? "暂无评分" : `${film.rating.toFixed(1)} 分`}
                </span>
                <span>
                  <Icon name="clock" size={14} />
                  {film.duration > 0 ? `${film.duration} 分钟` : "时长未知"}
                </span>
              </span>
            </span>
            <span className="quality-label">{film.quality}</span>
            {film.missing && (
              <span className="cover-warning">
                <Icon name="warning" size={12} />
                资料待补全
              </span>
            )}
          </span>
          <span className="film-code">
            <span>{film.code}</span>
          </span>
          <span className="film-title">{film.title}</span>
          <span className="film-meta">
            <span>{film.actor}</span>
            <span>
              {film.year} · {film.genre}
            </span>
          </span>
        </button>
        <button
          type="button"
          className={`cover-favorite ${film.favorite ? "is-favorite" : ""}`}
          aria-label={`${film.favorite ? "取消收藏" : "收藏"} ${film.code}`}
          aria-pressed={film.favorite}
          onClick={() => toggleFavorite(film.id)}
        >
          <Icon name="heart" size={16} />
        </button>
        <div className="film-card-menu" style={{ top: width * 1.39 + 8 }}>
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
  const columns = poster ? Math.max(2, Math.min(8, Math.floor((geometry.width + 18) / 188))) : 1;
  const rowHeight = poster ? ((geometry.width - (columns - 1) * 18) / columns) * 1.39 + 98 : 80;
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
      (poster ? 0 : 42);
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
  // 使用显式虚拟范围；不把可变 virtualizer 实例传入 memo 子组件。
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
      <div
        ref={rootRef}
        className={`virtual-collection ${poster ? "virtual-posters" : "table-shell"}`}
        data-total={films.length}
        data-rendered={rows.reduce(
          (count, row) => count + Math.min(columns, films.length - row.index * columns),
          0,
        )}
      >
        {poster ? (
          <ul
            className="virtual-poster-canvas"
            aria-label="影片海报"
            style={{ height: totalHeight }}
          >
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
                    left={offset * ((geometry.width + 18) / columns)}
                    width={(geometry.width - (columns - 1) * 18) / columns}
                    height={rowHeight}
                  />
                )),
            )}
          </ul>
        ) : (
          <table
            className="data-table virtual-film-table"
            aria-label="影片列表"
            aria-rowcount={films.length + 1}
          >
            <colgroup>
              <col style={{ width: "38%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "17%" }} />
              <col style={{ width: "15%" }} />
              <col style={{ width: "14%" }} />
            </colgroup>
            <thead>
              <tr aria-rowindex={1}>
                <th>影片</th>
                <th>演员</th>
                <th>画质 / 大小</th>
                <th>资料状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {first && (
                <tr aria-hidden="true" className="virtual-spacer">
                  <td
                    aria-label="未渲染区域"
                    colSpan={5}
                    style={{ height: Math.max(0, first.start - geometry.margin) }}
                  />
                </tr>
              )}
              {rows.map((row) => {
                const film = films[row.index]!;
                return (
                  <ObjectMenu
                    key={film.id}
                    items={<FilmMenuItems film={film} remove={() => setRemoving(film)} />}
                  >
                    <tr
                      aria-rowindex={row.index + 2}
                      data-film-id={film.id}
                      className="virtual-film-row"
                      tabIndex={0}
                      onClick={(event) => {
                        const target = event.target;
                        if (
                          !(target instanceof Element) ||
                          !event.currentTarget.contains(target) ||
                          target.closest("button, input, label")
                        )
                          return;
                        activateFilm(film);
                      }}
                      onContextMenu={(event) => {
                        event.currentTarget.focus();
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
                      <td>
                        <div className="table-film">
                          <button
                            type="button"
                            className="mini-poster mini-poster-button"
                            aria-label={`${cardClickToPlay ? "播放" : "查看详情"} ${film.code} 封面`}
                            title={cardClickToPlay ? "播放影片" : "查看详情"}
                            onKeyDown={objectMenuKey}
                            onClick={() => activateFilm(film)}
                          >
                            <Poster film={film} compact />
                          </button>
                          <button
                            type="button"
                            className="plain-title"
                            onClick={() => activateFilm(film)}
                            onKeyDown={objectMenuKey}
                          >
                            {film.title}
                            <small>
                              {film.code} · {film.year}
                            </small>
                          </button>
                        </div>
                      </td>
                      <td>{film.actor}</td>
                      <td>
                        {film.quality}
                        <small>{film.size}</small>
                      </td>
                      <td>
                        <Pill tone={film.missing ? "warning" : "success"}>
                          {film.missing ? "待补全" : "完整"}
                        </Pill>
                      </td>
                      <td>
                        <div className="row">
                          <IconButton
                            icon="play"
                            label={`播放 ${film.code}`}
                            onClick={() => play(film)}
                          />
                          <ObjectMenuButton label={`${film.code} 更多操作`} />
                        </div>
                      </td>
                    </tr>
                  </ObjectMenu>
                );
              })}
              {last && (
                <tr aria-hidden="true" className="virtual-spacer">
                  <td
                    colSpan={5}
                    aria-label="未渲染区域"
                    style={{ height: Math.max(0, totalHeight - (last.end - geometry.margin)) }}
                  />
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <Modal
        opened={removing !== null}
        onClose={() => setRemoving(null)}
        title="从片库移除"
        centered
      >
        <p>移除“{removing?.title}”的片库记录？</p>
        <p className="muted">原视频、封面和 NFO 文件会保留。</p>
        <div className="modal-footer">
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
        </div>
      </Modal>
    </>
  );
}
