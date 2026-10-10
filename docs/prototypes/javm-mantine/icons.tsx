import type { SVGProps } from "react";

// 原型自带的线性图标，24 网格、1.8 描边。正式工程选定图标库后整体替换。
const paths = {
  library: "M4 5h4v14H4zM10 5h4v14h-4zM16.5 5.5l3.5 1-3.5 13-3.5-1",
  compass: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM15.5 8.5l-2 5-5 2 2-5z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  radar: "M12 12l6-6M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5",
  settings:
    "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  play: "M8 5.5v13l11-6.5z",
  pause: "M8 5h3v14H8zM13 5h3v14h-3z",
  stop: "M7 7h10v10H7z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  heart: "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z",
  star: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  list: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  filter: "M4 5h16l-6 7.5V19l-4 1.5v-8z",
  plus: "M12 5v14M5 12h14",
  x: "M6 6l12 12M18 6L6 18",
  check: "M5 12.5l4.5 4.5L19 7",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  refresh: "M20 11a8 8 0 0 0-14.8-4M4 4v4h4M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  alert: "M12 4l9 16H3zM12 10v4M12 17h.01",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  copy: "M8 8h11v11H8zM5 16V5h11",
  user: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 20a8 8 0 0 1 16 0",
  building: "M5 20V5l7-2v17M12 9h7v11M8 8h.01M8 12h.01M8 16h.01M15 13h.01M15 17h.01M3 20h18",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  tag: "M4 4h7l9 9-7 7-9-9zM8 8h.01",
  film: "M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
  chevronLeft: "M15 6l-6 6 6 6",
  chevronRight: "M9 6l6 6-6 6",
  chevronDown: "M6 9l6 6 6-6",
  minimize: "M6 12h12",
  maximize: "M6 6h12v12H6z",
  volume: "M5 9h4l5-4v14l-5-4H5zM17 9a4 4 0 0 1 0 6M19.5 6.5a8 8 0 0 1 0 11",
  fullscreen: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  skipBack: "M18 6v12l-9-6zM6 6v12",
  skipForward: "M6 6v12l9-6zM18 6v12",
  sparkles:
    "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  globe:
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z",
  key: "M15 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11.5 12.5L4 20M7 17l2 2M5 19l2 2",
  cpu: "M7 7h10v10H7zM10 10h4v4h-4zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  drive: "M3 13l3-8h12l3 8v6H3zM3 13h18M17 16h.01",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01",
  magnet: "M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4zM6 8h4M14 8h4",
  upload: "M12 20V9M7 14l5-5 5 5M5 4h14",
  sort: "M7 4v16M4 17l3 3 3-3M17 20V4M14 7l3-3 3 3",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  bolt: "M13 3L5 13h6l-1 8 8-10h-6z",
  merge: "M7 4v5a5 5 0 0 0 5 5h5M7 20v-4M14 11l3 3-3 3",
  shield: "M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
  keyboard: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
  subtitles: "M3 5h18v14H3zM7 13h4M13 13h4M7 16h10",
  gauge: "M12 14l4-4M4 18a9 9 0 1 1 16 0",
  scan: "M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M12 8v8M8 12h8",
  chevron: "M9 6l6 6-6 6",
  sidebar: "M4 5h16v14H4zM9.5 5v14M6 9h1.5M6 12h1.5",
  down: "M6 9l6 6 6-6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  sortAsc: "M4 6h7M4 12h5M4 18h3M17 20V5M14 8l3-3 3 3",
  sortDesc: "M4 6h3M4 12h5M4 18h7M17 4v15M14 16l3 3 3-3",
  warning: "M12 4l9 16H3zM12 10v4M12 17h.01",
  close: "M6 6l12 12M18 6L6 18",
  arrow: "M19 12H5M11 6l-6 6 6 6",
  lock: "M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3",
  restore: "M8 8h11v11H8zM5 16V5h11",
} as const;

export type IconName = keyof typeof paths;

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
  filled?: boolean;
}

export function Icon({ name, size = 18, filled = false, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={name === "more" || name === "dots" ? 3 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={paths[name]} />
    </svg>
  );
}

/** 品牌标识：标题栏里的小号爱心播放徽记。 */
export function BrandMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M16 28s-11-6.6-11-15a6 6 0 0 1 11-3.4A6 6 0 0 1 27 13c0 8.4-11 15-11 15z"
        fill="var(--mantine-color-rouge-5)"
      />
      <path d="M13.5 11.5v8l6.5-4z" fill="#fff" />
    </svg>
  );
}
