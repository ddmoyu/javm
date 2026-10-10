import { useId } from "react";
import type { Film } from "./data";
import { Icon } from "./icons";

// Velvet 色组：深底、主色、光晕。封面、截图、播放画面都由它程序生成，不含任何真实图像。
export const palettes: [string, string, string][] = [
  ["#2a0617", "#c2185b", "#ff8fb8"],
  ["#14051f", "#7c18d1", "#f0a6ff"],
  ["#1c0509", "#ad1631", "#ffb38a"],
  ["#0f0a1f", "#3b2a8c", "#ff6d9f"],
  ["#210b0b", "#8e3b2e", "#f4dba6"],
  ["#1a0612", "#e0115f", "#ffd0e0"],
  ["#0c0b16", "#55306e", "#e7b54b"],
  ["#240414", "#ff2672", "#9024ea"],
];

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** 抽象“丝绸与光晕”图案。 */
export function Art({
  seed,
  tone,
  wide = false,
  label,
}: {
  seed: number;
  tone: number;
  wide?: boolean;
  label?: string;
}) {
  const id = useId().replace(/:/g, "");
  const [deep, mid, light] = palettes[tone % palettes.length]!;
  const r = rng(seed);
  const w = wide ? 320 : 200;
  const h = wide ? 180 : 280;
  const gx = 0.2 + r() * 0.6;
  const gy = 0.15 + r() * 0.5;
  const waves = Array.from({ length: 3 }, (_, i) => {
    const y = h * (0.35 + i * 0.18 + r() * 0.1);
    const a = h * (0.15 + r() * 0.25);
    return [
      `M-20 ${y} C ${w * 0.3} ${y - a}, ${w * 0.6} ${y + a}, ${w + 20} ${y - a * 0.4}`,
      ` L ${w + 20} ${h + 20} L -20 ${h + 20} Z`,
    ] as const;
  });
  const bokeh = Array.from({ length: 9 }, () => ({
    x: r() * w,
    y: r() * h * 0.7,
    r: 2 + r() * (wide ? 14 : 10),
    o: 0.08 + r() * 0.25,
  }));
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="xMidYMid slice"
      width="100%"
      height="100%"
      aria-hidden={label ? undefined : true}
      style={{ display: "block" }}
    >
      {label && <title>{label}</title>}
      <defs>
        <linearGradient id={`${id}bg`} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor={deep} />
          <stop offset="1" stopColor={mid} stopOpacity="0.85" />
        </linearGradient>
        <radialGradient id={`${id}glow`} cx={gx} cy={gy} r="0.55">
          <stop offset="0" stopColor={light} stopOpacity="0.85" />
          <stop offset="0.45" stopColor={mid} stopOpacity="0.35" />
          <stop offset="1" stopColor={deep} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}silk`} x1="0" y1="0" x2="1" y2="0.3">
          <stop offset="0" stopColor={light} stopOpacity="0.05" />
          <stop offset="0.5" stopColor={light} stopOpacity="0.32" />
          <stop offset="1" stopColor={mid} stopOpacity="0.1" />
        </linearGradient>
        <filter id={`${id}blur`}>
          <feGaussianBlur stdDeviation="2.4" />
        </filter>
      </defs>
      <rect width={w} height={h} fill={`url(#${id}bg)`} />
      <rect width={w} height={h} fill={`url(#${id}glow)`} />
      <g filter={`url(#${id}blur)`}>
        {bokeh.map((b, i) => (
          <circle key={i} cx={b.x} cy={b.y} r={b.r} fill={light} opacity={b.o} />
        ))}
      </g>
      {waves.map(([line, close], i) => (
        <path key={i} d={line + close} fill={`url(#${id}silk)`} opacity={0.55 - i * 0.12} />
      ))}
      {waves.map(([line], i) => (
        <path
          key={`l${i}`}
          d={line}
          fill="none"
          stroke={light}
          strokeOpacity={0.35 - i * 0.08}
          strokeWidth={0.8}
        />
      ))}
      <rect width={w} height={h} fill={deep} opacity="0.18" />
    </svg>
  );
}

export const scenes = ["霓虹雨窗", "酒店长廊", "香槟吧台", "丝绒幕布", "落日露台", "午夜车站"];
export const allFrames = [0, 1, 2, 3, 4, 5];
const positions = [0.06, 0.2, 0.37, 0.52, 0.73, 0.89];

export function timestamp(film: Film, index: number) {
  const seconds = Math.round(film.duration * 60 * positions[index]!);
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

/** 视频截图占位：每个画面编号对应固定的宽幅图案。 */
export function Still({ index, label }: { index: number; label: string }) {
  return (
    <span className="still">
      <Art seed={index * 131 + 7} tone={index + 2} wide label={label} />
    </span>
  );
}

const tone = (film: Film) => film.id % palettes.length;

/** 影片海报。默认图案上叠加片名排版；选用截图做封面时直接显示该画面。 */
export function Poster({ film, compact = false }: { film: Film; compact?: boolean }) {
  if (film.coverFrame === null) {
    return (
      <span className="poster-empty">
        <Icon name="image" size={compact ? 18 : 34} />
        {!compact && <span>暂无封面</span>}
      </span>
    );
  }
  if (typeof film.coverFrame === "number") {
    return (
      <span className="poster-fill">
        <Still index={film.coverFrame} label={`${film.title} 封面`} />
      </span>
    );
  }
  return (
    <span className="poster-fill">
      <Art seed={film.id} tone={tone(film)} />
      {!compact && (
        <span className="poster-type" aria-hidden="true">
          <span className="poster-kicker">The Velvet Collection</span>
          <span className="poster-title">{film.title}</span>
          <span className="poster-english">{film.english}</span>
          <span className="poster-foot">
            <span>{film.actor}</span>
            <span>{film.code}</span>
          </span>
        </span>
      )}
    </span>
  );
}
