import type { Film } from "./data";

export const stillsUrl = new URL("./assets/film-stills.png", import.meta.url).href;
export const scenes = [
  "车窗与雨夜",
  "海港灯塔",
  "街角咖啡馆",
  "暮色街道",
  "落日渡轮",
  "车站候车室",
];
export const allFrames = [0, 1, 2, 3, 4, 5];
const positions = [0.06, 0.2, 0.37, 0.52, 0.73, 0.89];

export function timestamp(film: Film, index: number) {
  const seconds = Math.round(film.duration * 60 * positions[index]!);
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function FilmStill({ index, label }: { index: number; label: string }) {
  return (
    <span className="film-still">
      <img
        src={stillsUrl}
        alt={label}
        draggable={false}
        decoding="async"
        style={{ left: `${-(index % 3) * 100}%`, top: `${-Math.floor(index / 3) * 100}%` }}
      />
    </span>
  );
}
