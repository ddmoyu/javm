import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, Ref } from "react";
import { Button, Slider } from "@mantine/core";
import type { Film } from "./data";
import { usePrototype } from "./state";
import { Art } from "./Cover";
import { Icon } from "./icons";
import { IconButton } from "./ui";

export interface PlayerWindowsHandle {
  open: (film: Film) => void;
}
interface Entry {
  id: number;
  film: Film;
  minimized: boolean;
  origin: HTMLElement | null;
}
interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function constrain(bounds: Bounds): Bounds {
  const width = Math.min(
    Math.max(Math.min(400, window.innerWidth - 24), bounds.width),
    window.innerWidth - 24,
  );
  const height = Math.min(Math.max(280, bounds.height), window.innerHeight - 76);
  return {
    width,
    height,
    x: Math.min(Math.max(12, bounds.x), window.innerWidth - width - 12),
    y: Math.min(Math.max(12, bounds.y), window.innerHeight - height - 64),
  };
}

function PlayerWindow({
  entry,
  order,
  active,
  activate,
  minimize,
  close,
}: {
  entry: Entry;
  order: number;
  active: boolean;
  activate: () => void;
  minimize: () => void;
  close: () => void;
}) {
  const { openFilm, notice } = usePrototype();
  const [paused, setPaused] = useState(true);
  const [progress, setProgress] = useState(0);
  const [volume, setVolume] = useState(70);
  const [maximized, setMaximized] = useState(false);
  const [bounds, setBounds] = useState<Bounds>(() =>
    constrain({
      x: window.innerWidth - 680 - (order % 4) * 44,
      y: 128 + (order % 4) * 38,
      width: 640,
      height: 410,
    }),
  );
  const rootRef = useRef<HTMLDialogElement>(null);
  const gesture = useRef<{ x: number; y: number; bounds: Bounds; resize: boolean } | null>(null);
  const film = entry.film;
  useEffect(() => {
    const resize = () => setBounds((previous) => constrain(previous));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useLayoutEffect(() => {
    if (active && !entry.minimized) rootRef.current?.focus({ preventScroll: true });
  }, [active, entry.minimized]);
  const begin = (event: PointerEvent<HTMLButtonElement>, resize: boolean) => {
    if (event.button !== 0 || maximized) return;
    activate();
    gesture.current = { x: event.clientX, y: event.clientY, bounds, resize };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const start = gesture.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    setBounds(
      constrain(
        start.resize
          ? { ...start.bounds, width: start.bounds.width + dx, height: start.bounds.height + dy }
          : { ...start.bounds, x: start.bounds.x + dx, y: start.bounds.y + dy },
      ),
    );
  };
  const end = () => {
    gesture.current = null;
  };
  const keyboardGeometry = (event: KeyboardEvent<HTMLButtonElement>, resize: boolean) => {
    if (maximized || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key))
      return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 10;
    const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    setBounds((previous) =>
      constrain(
        resize
          ? { ...previous, width: previous.width + dx, height: previous.height + dy }
          : { ...previous, x: previous.x + dx, y: previous.y + dy },
      ),
    );
  };
  return (
    <dialog
      ref={rootRef}
      open={!entry.minimized}
      aria-modal="false"
      aria-labelledby={`player-title-${entry.id}`}
      tabIndex={-1}
      hidden={entry.minimized}
      data-player-id={entry.id}
      className={`player-window ${active ? "is-active" : ""} ${maximized ? "is-maximized" : ""}`}
      style={{
        left: maximized ? 12 : bounds.x,
        top: maximized ? 12 : bounds.y,
        width: maximized ? "calc(100vw - 24px)" : bounds.width,
        height: maximized ? "calc(100dvh - 76px)" : bounds.height,
        zIndex: 120 + order,
      }}
      onPointerDownCapture={activate}
      onFocusCapture={activate}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <header className="player-window-titlebar">
        <button
          type="button"
          className="player-drag-region"
          aria-label={`移动播放器 ${film.code}，方向键微调，双击最大化`}
          onPointerDown={(event) => begin(event, false)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onLostPointerCapture={end}
          onKeyDown={(event) => keyboardGeometry(event, false)}
          onDoubleClick={() => setMaximized(!maximized)}
        >
          <span className="player-title-icon">
            <Icon name="play" size={13} />
          </span>
          <span id={`player-title-${entry.id}`}>
            {film.title}
            <small>
              {film.code} · {film.quality}
            </small>
          </span>
        </button>
        <div className="window-controls">
          <button
            type="button"
            title="最小化"
            aria-label={`最小化播放器 ${film.code}`}
            onClick={minimize}
          >
            <Icon name="minimize" size={14} />
          </button>
          <button
            type="button"
            title={maximized ? "还原" : "最大化"}
            aria-label={`${maximized ? "还原" : "最大化"}播放器 ${film.code}`}
            onClick={() => setMaximized(!maximized)}
          >
            <Icon name={maximized ? "restore" : "maximize"} size={13} />
          </button>
          <button
            type="button"
            className="window-close"
            title="关闭"
            aria-label={`关闭播放器 ${film.code}`}
            onClick={close}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      </header>
      <div className="player-stage">
        <div className="player-art">
          <Art seed={film.id + 77} tone={film.id} wide />
        </div>
        <div className="player-vignette" />
        <button
          className="play-center"
          type="button"
          aria-label={`${paused ? "开始播放" : "暂停播放"} ${film.code}`}
          onClick={() => setPaused(!paused)}
        >
          <Icon name={paused ? "play" : "pause"} size={28} filled />
        </button>
        <div className="player-caption">
          <span>{paused ? "已暂停" : "正在播放"}</span>
          <h2>{film.english}</h2>
        </div>
        <div className="player-controls">
          <Slider
            aria-label={`播放进度 ${film.code}`}
            thumbLabel={`播放进度 ${film.code}`}
            value={progress}
            onChange={setProgress}
            color="rouge"
            size="xs"
            label={(value) => `${Math.round((value * film.duration) / 100)} 分钟`}
          />
          <div className="row">
            <IconButton
              icon={paused ? "play" : "pause"}
              label={`${paused ? "播放" : "暂停"} ${film.code}`}
              onClick={() => setPaused(!paused)}
            />
            <span className="numeric small">
              {Math.floor((film.duration * progress) / 100)}:00{" "}
              <span className="muted">/ {film.duration}:00</span>
            </span>
            <div className="spacer" />
            <IconButton
              icon="volume"
              label={`${volume ? "静音" : "开启声音"} ${film.code}`}
              onClick={() => setVolume(volume ? 0 : 70)}
              active={volume === 0}
            />
            <Slider
              aria-label={`播放音量 ${film.code}`}
              thumbLabel={`播放音量 ${film.code}`}
              value={volume}
              onChange={setVolume}
              w={66}
              size="xs"
            />
            <IconButton
              icon="image"
              label={`查看视频截图 ${film.code}`}
              onClick={() => openFilm(film, "screenshots")}
            />
          </div>
        </div>
      </div>
      <footer className="player-window-footer">
        <span>
          {film.actor} · {film.year}
        </span>
        <div className="row">
          <Button
            variant="subtle"
            size="compact-xs"
            onClick={() => notice("未找到外部播放器，请在设置中指定路径")}
            leftSection={<Icon name="external" size={12} />}
          >
            外部播放
          </Button>
          <Button variant="subtle" size="compact-xs" onClick={() => openFilm(film)}>
            影片资料 <Icon name="chevron" size={12} />
          </Button>
        </div>
      </footer>
      {!maximized && (
        <button
          className="player-resize-handle"
          type="button"
          aria-label={`调整播放器大小 ${film.code}，支持方向键`}
          onPointerDown={(event) => begin(event, true)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onLostPointerCapture={end}
          onKeyDown={(event) => keyboardGeometry(event, true)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="m5 13 8-8 M10 13l3-3" />
          </svg>
        </button>
      )}
    </dialog>
  );
}

export function PlayerWindows({ ref }: { ref: Ref<PlayerWindowsHandle> }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const nextId = useRef(1);
  const activeId = entries.findLast((entry) => !entry.minimized)?.id;
  // 层级变化只改 z-index，保持 DOM 顺序，避免取消正在进行的指针捕获。
  const stableEntries = entries.toSorted((a, b) => a.id - b.id);
  const activate = (id: number) =>
    setEntries((previous) => {
      const entry = previous.find((item) => item.id === id);
      if (!entry || (previous.at(-1) === entry && !entry.minimized)) return previous;
      return [...previous.filter((item) => item.id !== id), { ...entry, minimized: false }];
    });
  const close = (id: number) => {
    const entry = entries.find((item) => item.id === id);
    setEntries((previous) => previous.filter((item) => item.id !== id));
    if (entry?.origin?.isConnected) entry.origin.focus({ preventScroll: true });
  };
  useImperativeHandle(
    ref,
    () => ({
      open(film) {
        const origin =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const id = nextId.current++;
        setEntries((previous) => {
          const existing = previous.find((entry) => entry.film.id === film.id);
          // 重复点同一部影片唤回原窗口；不同影片各自保留播放状态。
          return existing
            ? [...previous.filter((entry) => entry !== existing), { ...existing, minimized: false }]
            : [...previous, { id, film, origin, minimized: false }];
        });
      },
    }),
    [],
  );
  return (
    <>
      {stableEntries.map((entry) => (
        <PlayerWindow
          key={entry.id}
          entry={entry}
          order={entries.indexOf(entry)}
          active={entry.id === activeId}
          activate={() => activate(entry.id)}
          minimize={() =>
            setEntries((previous) =>
              previous.map((item) => (item.id === entry.id ? { ...item, minimized: true } : item)),
            )
          }
          close={() => close(entry.id)}
        />
      ))}
      {entries.length > 0 && (
        <div className="player-dock" aria-label="已打开的播放器">
          <span className="player-dock-label">
            <Icon name="play" size={13} />
            {entries.length} 个窗口
          </span>
          {stableEntries.map((entry) => (
            <div
              key={entry.id}
              className={`player-dock-item ${entry.id === activeId ? "active" : ""}`}
            >
              <button
                type="button"
                aria-label={`${entry.minimized ? "恢复" : "切换到"}播放器 ${entry.film.code}`}
                onClick={() => activate(entry.id)}
              >
                <span className={`dock-status ${entry.minimized ? "minimized" : ""}`} />
                <span>{entry.film.title}</span>
              </button>
              <button
                type="button"
                aria-label={`关闭窗口卡片 ${entry.film.code}`}
                onClick={() => close(entry.id)}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
