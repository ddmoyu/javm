import { useState } from "react";
import { Button, Checkbox, Modal, Select } from "@mantine/core";
import type { Film } from "./data";
import { allFrames, FilmStill, scenes, stillsUrl, timestamp } from "./FilmStills";
import { Icon } from "./visuals";
import { usePrototype } from "./state";

export type ArtworkMode = "cover" | "capture" | "fetch" | "long";
export function FilmArtworkEditor({
  film,
  mode,
  onClose,
}: {
  film: Film;
  mode: ArtworkMode;
  onClose: () => void;
}) {
  const { setFilms, notice } = usePrototype();
  const [selected, setSelected] = useState<number[]>(
    mode === "cover" ? [film.coverFrame ?? 0] : allFrames,
  );
  const [updateCover, setUpdateCover] = useState(true);
  const [updateScreenshots, setUpdateScreenshots] = useState(true);
  const title = {
    cover: "选取封面",
    capture: "截取视频截图",
    fetch: "获取封面与截图",
    long: "获取长截图",
  }[mode];
  const save = () => {
    setFilms((previous) =>
      previous.map((item) =>
        item.id === film.id
          ? {
              ...item,
              ...(mode === "cover" || (mode === "fetch" && updateCover)
                ? { coverFrame: selected[0] ?? 0 }
                : {}),
              ...(mode === "capture" || (mode === "fetch" && updateScreenshots)
                ? { previewFrames: selected }
                : {}),
              ...(mode === "long" ? { hasLongScreenshot: true } : {}),
            }
          : item,
      ),
    );
    notice(mode === "cover" ? "封面已更新" : mode === "long" ? "长截图已保存" : "图片已更新");
    onClose();
  };
  return (
    <Modal
      opened
      onClose={onClose}
      title={title}
      size={760}
      centered
      zIndex={400}
      returnFocus={false}
    >
      {mode === "fetch" && (
        <div className="artwork-source">
          <Select
            label="资料来源"
            defaultValue="首选资料源"
            data={["首选资料源", "MetaTube"]}
            allowDeselect={false}
          />
          <div className="row">
            <Checkbox
              label="更新封面"
              checked={updateCover}
              onChange={(event) => setUpdateCover(event.currentTarget.checked)}
            />
            <Checkbox
              label="更新截图"
              checked={updateScreenshots}
              onChange={(event) => setUpdateScreenshots(event.currentTarget.checked)}
            />
          </div>
        </div>
      )}
      {mode === "long" ? (
        <img className="long-screenshot-preview" src={stillsUrl} alt={`${film.title} 长截图`} />
      ) : (
        <div className="artwork-candidates">
          {allFrames.map((index) => (
            <button
              type="button"
              key={index}
              aria-label={`选择画面 ${index + 1}`}
              aria-pressed={selected.includes(index)}
              onClick={() =>
                setSelected((previous) =>
                  mode === "cover"
                    ? [index]
                    : previous.includes(index)
                      ? previous.filter((value) => value !== index)
                      : [...previous, index].sort((a, b) => a - b),
                )
              }
            >
              <FilmStill index={index} label={scenes[index]!} />
              <span className="artwork-candidate-meta">
                <time>{timestamp(film, index)}</time>
                {selected.includes(index) && <Icon name="check" size={16} />}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="modal-footer">
        {mode === "capture" && (
          <Button variant="subtle" onClick={() => setSelected(allFrames)}>
            选取全部画面
          </Button>
        )}
        <Button variant="default" onClick={onClose}>
          取消
        </Button>
        <Button
          disabled={
            mode !== "long" &&
            (!selected.length || (mode === "fetch" && !updateCover && !updateScreenshots))
          }
          onClick={save}
        >
          {mode === "cover"
            ? "设为封面"
            : mode === "long"
              ? "保存长截图"
              : mode === "fetch"
                ? "应用图片"
                : `保存 ${selected.length} 张截图`}
        </Button>
      </div>
    </Modal>
  );
}
