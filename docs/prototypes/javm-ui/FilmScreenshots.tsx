import { Button, Menu, Modal } from "@mantine/core";
import type { Film } from "./data";
import { Icon } from "./visuals";

import { allFrames, FilmStill, scenes, timestamp } from "./FilmStills";
import { ObjectMenu, objectMenuKey } from "./ObjectMenu";

export type ScreenshotAction = "capture" | "fetch" | "long" | "clear" | "remove" | "cover";

export function FilmScreenshots({
  film,
  frame,
  setFrame,
  onAction,
}: {
  film: Film;
  frame: number | null;
  setFrame: (frame: number | null) => void;
  onAction: (action: ScreenshotAction, index?: number) => void;
}) {
  const frames = film.previewFrames ?? allFrames;
  const navigate = (step: number) =>
    setFrame(
      frames[(frames.indexOf(frame ?? frames[0]!) + step + frames.length) % frames.length] ?? null,
    );
  return (
    <>
      <section className="film-screenshots" aria-label="视频截图">
        <div className="section-caption">
          <h3>
            视频截图 <span className="screenshot-count">{frames.length}</span>
          </h3>
          <Menu position="bottom-end" zIndex={350}>
            <Menu.Target>
              <Button
                size="compact-xs"
                variant="subtle"
                rightSection={<Icon name="down" size={13} />}
              >
                管理截图
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<Icon name="image" />} onClick={() => onAction("capture")}>
                从视频截取
              </Menu.Item>
              <Menu.Item leftSection={<Icon name="download" />} onClick={() => onAction("fetch")}>
                获取封面与截图
              </Menu.Item>
              <Menu.Item leftSection={<Icon name="image" />} onClick={() => onAction("long")}>
                获取长截图
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item color="red" disabled={!frames.length} onClick={() => onAction("clear")}>
                清空截图
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </div>
        <div className="screenshot-grid">
          {frames.map((index) => (
            <ObjectMenu
              key={index}
              items={
                <>
                  <Menu.Item onClick={() => setFrame(index)}>查看大图</Menu.Item>
                  <Menu.Item onClick={() => onAction("cover", index)}>设为封面</Menu.Item>
                  <Menu.Divider />
                  <Menu.Item color="red" onClick={() => onAction("remove", index)}>
                    移除这张截图
                  </Menu.Item>
                </>
              }
            >
              <button
                type="button"
                className="screenshot-thumb"
                aria-label={`查看截图 ${index + 1}，${timestamp(film, index)}`}
                onClick={() => setFrame(index)}
                onKeyDown={objectMenuKey}
              >
                <FilmStill index={index} label={scenes[index]!} />
                <time>{timestamp(film, index)}</time>
                <span className="screenshot-zoom">
                  <Icon name="maximize" size={18} />
                </span>
              </button>
            </ObjectMenu>
          ))}
        </div>
        {!frames.length && (
          <div className="artwork-empty">
            <Icon name="image" size={28} />
            <span>暂无截图</span>
            <Button size="xs" variant="light" onClick={() => onAction("capture")}>
              从视频截取
            </Button>
          </div>
        )}
      </section>
      <Modal
        opened={frame !== null}
        onClose={() => setFrame(null)}
        title={`${film.title} · 视频截图`}
        size={980}
        returnFocus={false}
        centered
        zIndex={400}
        className="screenshot-viewer"
        onKeyDownCapture={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          event.stopPropagation();
          navigate(event.key === "ArrowLeft" ? -1 : 1);
        }}
      >
        {frame !== null && (
          <>
            <div className="screenshot-stage">
              <FilmStill index={frame} label={`${scenes[frame]}，${timestamp(film, frame)}`} />
              <button
                type="button"
                className="screenshot-nav previous"
                aria-label="上一张截图"
                onClick={() => navigate(-1)}
              >
                <Icon name="chevron" size={24} />
              </button>
              <button
                type="button"
                className="screenshot-nav next"
                aria-label="下一张截图"
                onClick={() => navigate(1)}
              >
                <Icon name="chevron" size={24} />
              </button>
              <time>{timestamp(film, frame)}</time>
            </div>
            <div className="screenshot-viewer-bar">
              <span>
                {film.code} <span className="muted">/ {film.quality}</span>
              </span>
              <output aria-live="polite">
                {frames.indexOf(frame) + 1} / {frames.length}
              </output>
            </div>
            <div className="screenshot-filmstrip" aria-label="选择截图">
              {frames.map((index) => (
                <button
                  type="button"
                  key={index}
                  aria-label={`切换到截图 ${index + 1}`}
                  aria-pressed={frame === index}
                  onClick={() => setFrame(index)}
                >
                  <FilmStill index={index} label={scenes[index]!} />
                </button>
              ))}
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
