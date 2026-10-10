import type { CSSProperties } from "react";
import type { Film } from "./data";
import { FilmStill } from "./FilmStills";

const paths = {
  library: "M4 4h6v7H4z M14 4h6v7h-6z M4 15h6v5H4z M14 15h6v5h-6z",
  compass: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M16 8l-3 5-5 3 3-5z",
  folder: "M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3z",
  download: "M12 3v12 m-5-5 5 5 5-5 M4 16v5h16v-5",
  scan: "M8 3H3v5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5 M7 12h10 M12 7v10",
  search: "M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0 m-1 5 6 6",
  settings:
    "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2",
  play: "M8 4l13 8-13 8z",
  pause: "M7 4h3v16H7z M15 4h3v16h-3z",
  plus: "M12 5v14 M5 12h14",
  chevron: "m9 5 7 7-7 7",
  down: "m6 9 6 6 6-6",
  heart: "M20 5c-3-3-7-1-8 1-1-2-5-4-8-1-4 5 2 10 8 15 6-5 12-10 8-15z",
  check: "m5 12 4 4L19 6",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  list: "M8 5h13 M8 12h13 M8 19h13 M3 5h.01 M3 12h.01 M3 19h.01",
  filter: "M4 5h16 M7 12h10 M10 19h4",
  sortAsc: "M5 20V4 m-3 3 3-3 3 3 M12 6h4 M12 12h6 M12 18h9",
  sortDesc: "M5 4v16 m-3-3 3 3 3-3 M12 6h9 M12 12h6 M12 18h4",
  refresh: "M20 8a8 8 0 1 0 0 8 M20 3v5h-5",
  warning: "M12 3 2 21h20z M12 9v5 M12 17v.01",
  close: "m6 6 12 12 M6 18 18 6",
  sun: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1 1 M18 18l1 1 M5 19l1-1 M18 6l1-1",
  moon: "M21 14A9 9 0 0 1 10 3a9 9 0 1 0 11 11z",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2",
  star: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z",
  arrow: "M4 12h16 m-6-6 6 6-6 6",
  trash: "M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7",
  edit: "m4 16 12-12 4 4L8 20H4z M13 7l4 4",
  link: "m10 14 4-4 M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0 M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0",
  external: "M14 3h7v7 M10 14 21 3 M10 3H3v18h18v-7",
  volume: "M3 9h4l5-4v14l-5-4H3z M16 8a6 6 0 0 1 0 8 M19 5a10 10 0 0 1 0 14",
  fullscreen: "M8 3H3v5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5",
  image: "M3 3h18v18H3z m0 13 5-5 5 5 4-4 4 4 M16 7h.01",
  stop: "M5 5h14v14H5z",
  lock: "M6 10h12v11H6z M8 10V6a4 4 0 0 1 8 0v4",
  minimize: "M5 12h14",
  maximize: "M5 5h14v14H5z",
  restore: "M8 5V3h13v13h-2 M3 8h13v13H3z",
} as const;

export type IconName = keyof typeof paths;
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

// 原创几何海报，仅用于验证封面尺寸和视觉密度；没有外部图片依赖。
export function Poster({ film, compact = false }: { film: Film; compact?: boolean }) {
  if (film.coverFrame === null) {
    return (
      <div className="poster-placeholder">
        <Icon name="image" size={compact ? 18 : 36} />
        <span>暂无封面</span>
      </div>
    );
  }
  if (typeof film.coverFrame === "number") {
    return (
      <div className="poster-from-frame">
        <FilmStill index={film.coverFrame} label={`${film.title} 封面`} />
      </div>
    );
  }
  const [sky, middle, foreground] = film.palette;
  const style = { "--poster-ink": foreground } as CSSProperties;
  return (
    <div className={`poster-art art-${film.art} ${compact ? "compact-art" : ""}`} style={style}>
      <svg viewBox="0 0 300 450" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <rect width="300" height="450" fill={sky} />
        {film.art === "portrait" && (
          <g transform={film.id % 2 === 0 ? "translate(300 0) scale(-1 1)" : undefined}>
            <path d="M242 0h58v450h-58z" fill={middle} opacity=".18" />
            <circle cx="146" cy="218" r="115" fill={middle} opacity=".16" />
            <path d="M75 318Q53 177 90 128q40-49 91-12 41 24 23 114l29 112Z" fill={foreground} />
            <path d="M121 229q6 42-9 58l-37 34 113 27 20-32-39-34-5-53Z" fill={middle} />
            <path d="M98 146q34-31 77 1l9 51q-6 43-33 50-26-7-39-35Z" fill={middle} />
            <path
              d="M81 189q-3-80 60-82 61 8 53 97l-14-44q-43 6-49-21-16 35-45 48Z"
              fill={foreground}
            />
            <path
              d="m155 188 4 17-8 3 M146 223q8 3 16-1"
              fill="none"
              stroke={foreground}
              strokeWidth="1.3"
              opacity=".45"
            />
            <path d="m116 181 16-2 M162 179l12 4" fill="none" stroke={foreground} strokeWidth="2" />
            <path
              d="M40 450q-8-118 56-153l24-26q22 14 47 0l28 27q76 51 71 152Z"
              fill={foreground}
            />
            <path
              d="m119 277 29 52-27 64-22-91 M169 279l-21 50 23 62 27-81"
              stroke={sky}
              strokeWidth="1.6"
              fill="none"
              opacity=".6"
            />
            <path d="M145 331v119" stroke={sky} opacity=".35" />
            <circle cx="148" cy="362" r="2" fill={middle} />
            <circle cx="148" cy="398" r="2" fill={middle} />
            <path d="M213 166v76" stroke={middle} strokeWidth=".8" opacity=".35" />
          </g>
        )}
        {film.art === "mountain" && (
          <>
            <circle cx="222" cy="132" r="41" fill="#f0e4c5" opacity=".8" />
            <path d="M-20 325 63 114l72 109 53-139 132 244v122H-20Z" fill={middle} />
            <path
              d="m20 280 43-166 33 113-35-17z M150 197l38-113 57 105-40-18-18-32Z"
              fill="#ebe8d7"
              opacity=".7"
            />
            <path d="m-20 380 128-147 45 66 94-78 73 123v106H-20Z" fill={foreground} />
            <path
              d="m161 300-27 44 26 30-14 76"
              stroke={sky}
              strokeWidth="2"
              fill="none"
              opacity=".6"
            />
          </>
        )}
        {film.art === "sea" && (
          <>
            <circle cx="155" cy="163" r="63" fill="#e2d8b4" opacity=".65" />
            <path d="M0 195q80 22 150 0t150 0v255H0Z" fill={middle} />
            {Array.from({ length: 13 }, (_, i) => (
              <path
                key={i}
                d={`M-30 ${220 + i * 17}q100 -20 185 0t175 0`}
                fill="none"
                stroke={sky}
                strokeWidth="1.4"
                opacity=".35"
              />
            ))}
            <path d="m0 349 85-21 52 40 68-13 95 46v49H0Z" fill={foreground} />
            <path d="M202 254h28l-6 5h-18z m14-2v-30l-13 28" fill="#e6e1d6" />
          </>
        )}
        {film.art === "desert" && (
          <>
            <circle cx="222" cy="149" r="44" fill="#efe0b9" />
            <path d="M-60 356Q60 163 324 273v177H-60Z" fill={middle} />
            <path d="M-25 271q174 17 343 161v18H-25Z" fill={foreground} />
            <path d="M-25 268q165 22 340 161" stroke="#e7be8b" strokeWidth="2" fill="none" />
            <path d="m148 280 4-13 5 14 M152 268v-6" stroke={foreground} strokeWidth="3" />
            <path d="m147 294-4 5m-5 5-4 6m-6 4-4 7" stroke={foreground} opacity=".35" />
          </>
        )}
        {film.art === "city" && (
          <>
            <circle cx="210" cy="145" r="55" fill={middle} opacity=".75" />
            {Array.from({ length: 9 }, (_, i) => (
              <g key={i}>
                <rect
                  x={i * 38 - 12}
                  y={178 + ((i * 31) % 100)}
                  width="32"
                  height="300"
                  fill={foreground}
                />
                {Array.from({ length: 5 }, (_, j) => (
                  <rect
                    key={j}
                    x={i * 38 - 3}
                    y={198 + ((i * 31) % 100) + j * 25}
                    width="7"
                    height="9"
                    fill={sky}
                    opacity={j % 2 ? ".7" : ".25"}
                  />
                ))}
              </g>
            ))}
            <path d="m125 450 25-143 28 143" fill={middle} opacity=".8" />
            <path d="M151 367v37m0 15v31" stroke="#e8c29e" strokeWidth="2" />
          </>
        )}
        {film.art === "forest" && (
          <>
            <circle cx="150" cy="186" r="72" fill="#dad5b9" opacity=".7" />
            {Array.from({ length: 11 }, (_, i) => (
              <path
                key={i}
                d={`M${i * 31 - 10} 135l-38 161h29v154h18V296h29Z`}
                fill={i % 2 ? foreground : middle}
                opacity={i % 2 ? 1 : 0.5}
                transform={`translate(0,${(i * 23) % 68})`}
              />
            ))}
            <path d="M150 300q-60 40 20 65t-70 85h95q45-67-8-96t-37-54" fill={sky} opacity=".7" />
          </>
        )}
        {film.art === "orbit" && (
          <>
            {Array.from({ length: 43 }, (_, i) => (
              <circle
                key={i}
                cx={(i * 71) % 300}
                cy={(i * 41) % 450}
                r={i % 4 === 0 ? 1.2 : 0.6}
                fill="#eee4d8"
                opacity=".6"
              />
            ))}
            <circle cx="148" cy="255" r="85" fill={middle} />
            <path
              d="M95 188a85 85 0 0 1 106 130A89 89 0 0 0 95 188"
              fill={foreground}
              opacity=".7"
            />
            <ellipse
              cx="148"
              cy="255"
              rx="145"
              ry="24"
              stroke={middle}
              strokeWidth="3"
              fill="none"
              transform="rotate(-32 148 255)"
            />
            <ellipse
              cx="148"
              cy="255"
              rx="132"
              ry="19"
              stroke={middle}
              opacity=".5"
              fill="none"
              transform="rotate(-32 148 255)"
            />
          </>
        )}
      </svg>
      <div className="poster-type">
        <span className="poster-kicker">THE PRIVATE COLLECTION</span>
        <strong>{film.title}</strong>
        <span className="poster-english">{film.english}</span>
      </div>
      <div className="poster-bottom">
        {film.actor ?? "JAVM COLLECTION"}
        <span>{film.code}</span>
      </div>
    </div>
  );
}
