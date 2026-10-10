export interface FilmMetadata {
  originalTitle: string;
  premiered: string;
  actors: string[];
  director: string;
  studio: string;
  series: string;
  genres: string[];
  resolution: string;
  directory: string;
  fileName: string;
  source: string;
}
export interface Film {
  id: number;
  code: string;
  title: string;
  english: string;
  year: number;
  duration: number;
  rating?: number;
  genre: string;
  quality: string;
  size: string;
  favorite: boolean;
  missing: boolean;
  actor?: string;
  metadata?: FilmMetadata;
  coverFrame?: number | null;
  previewFrames?: number[];
  hasLongScreenshot?: boolean;
  palette: [string, string, string];
  art: "portrait" | "mountain" | "city" | "sea" | "desert" | "forest" | "orbit";
}

// 完全虚构的演示内容。原型不读文件、数据库或远端影视资料。
const baseFilms: Film[] = [
  {
    id: 1,
    code: "JVM-001",
    title: "远山来信",
    english: "LETTERS FROM THE MOUNTAINS",
    year: 2025,
    duration: 108,
    rating: 8.4,
    genre: "纪录片",
    quality: "4K",
    size: "8.4 GB",
    favorite: true,
    missing: false,
    palette: ["#bcc3af", "#476563", "#182f37"],
    art: "mountain",
  },
  {
    id: 2,
    code: "JVM-002",
    title: "午夜漫游",
    english: "AFTER THE LAST TRAIN",
    year: 2024,
    duration: 96,
    rating: 7.8,
    genre: "剧情",
    quality: "1080P",
    size: "3.2 GB",
    favorite: false,
    missing: false,
    palette: ["#292945", "#bd625c", "#181c2a"],
    art: "city",
  },
  {
    id: 3,
    code: "JVM-003",
    title: "蓝色之间",
    english: "SOMEWHERE IN BLUE",
    year: 2025,
    duration: 122,
    rating: 8.9,
    genre: "纪录片",
    quality: "4K",
    size: "12.1 GB",
    favorite: true,
    missing: false,
    palette: ["#8dafb4", "#296978", "#133442"],
    art: "sea",
  },
  {
    id: 4,
    code: "JVM-004",
    title: "沙丘以南",
    english: "SOUTH OF THE DUNES",
    year: 2023,
    duration: 114,
    rating: 7.6,
    genre: "剧情",
    quality: "4K",
    size: "9.7 GB",
    favorite: false,
    missing: true,
    palette: ["#d4c2a0", "#b78356", "#684d3f"],
    art: "desert",
  },
  {
    id: 5,
    code: "JVM-005",
    title: "林间一日",
    english: "A DAY IN THE WOODS",
    year: 2024,
    duration: 89,
    rating: 8.2,
    genre: "纪录片",
    quality: "1080P",
    size: "4.6 GB",
    favorite: false,
    missing: false,
    palette: ["#bbb99a", "#5d7560", "#233f39"],
    art: "forest",
  },
  {
    id: 6,
    code: "JVM-006",
    title: "轨道之外",
    english: "BEYOND THE ORBIT",
    year: 2025,
    duration: 136,
    rating: 9.1,
    genre: "科幻",
    quality: "4K",
    size: "14.3 GB",
    favorite: true,
    missing: false,
    palette: ["#182737", "#ddac6f", "#152533"],
    art: "orbit",
  },
  {
    id: 7,
    code: "JVM-007",
    title: "漫长的夏天",
    english: "AN ENDLESS SUMMER",
    year: 2022,
    duration: 101,
    rating: 8.0,
    genre: "剧情",
    quality: "1080P",
    size: "3.9 GB",
    favorite: false,
    missing: false,
    palette: ["#a9c4bb", "#528a80", "#23474c"],
    art: "sea",
  },
  {
    id: 8,
    code: "JVM-008",
    title: "风经过的地方",
    english: "WHERE THE WIND GOES",
    year: 2024,
    duration: 117,
    rating: 8.6,
    genre: "纪录片",
    quality: "4K",
    size: "7.8 GB",
    favorite: false,
    missing: false,
    palette: ["#b7bbc5", "#7b7891", "#3b475c"],
    art: "mountain",
  },
  {
    id: 9,
    code: "JVM-009",
    title: "第二座城市",
    english: "THE OTHER CITY",
    year: 2023,
    duration: 103,
    rating: 7.9,
    genre: "剧情",
    quality: "1080P",
    size: "3.5 GB",
    favorite: true,
    missing: false,
    palette: ["#9eaaaf", "#567481", "#263a49"],
    art: "city",
  },
  {
    id: 10,
    code: "JVM-010",
    title: "无声荒原",
    english: "THE QUIET LAND",
    year: 2021,
    duration: 98,
    genre: "纪录片",
    quality: "1080P",
    size: "4.1 GB",
    favorite: false,
    missing: true,
    palette: ["#bea691", "#92694e", "#513d3c"],
    art: "desert",
  },
  {
    id: 11,
    code: "JVM-011",
    title: "所有微小的光",
    english: "ALL THE LITTLE LIGHTS",
    year: 2025,
    duration: 125,
    rating: 8.8,
    genre: "科幻",
    quality: "4K",
    size: "10.6 GB",
    favorite: false,
    missing: false,
    palette: ["#2e363f", "#d6b59b", "#30354a"],
    art: "orbit",
  },
  {
    id: 12,
    code: "JVM-012",
    title: "雨后，再出发",
    english: "AFTER THE RAIN",
    year: 2024,
    duration: 94,
    rating: 8.1,
    genre: "剧情",
    quality: "1080P",
    size: "4.2 GB",
    favorite: false,
    missing: false,
    palette: ["#c1c2ac", "#7c8869", "#364f48"],
    art: "forest",
  },
];

const portraitTitles = [
  "绯色时刻",
  "午夜来信",
  "她的假日",
  "余温",
  "晚风",
  "秘密花园",
  "星期日的约定",
  "夜幕之后",
  "心动片刻",
  "漫长告白",
  "夏日私语",
  "雨中的她",
];
const portraitEnglish = [
  "SCARLET HOURS",
  "MIDNIGHT LETTER",
  "HER HOLIDAY",
  "AFTERGLOW",
  "NIGHT BREEZE",
  "SECRET GARDEN",
  "SUNDAY PROMISE",
  "AFTER DARK",
  "A QUIET MOMENT",
  "THE LONG CONFESSION",
  "SUMMER WHISPER",
  "IN THE RAIN",
];
const portraitPalettes: [string, string, string][] = [
  ["#aa5364", "#d0a498", "#321d29"],
  ["#585c78", "#bd9c97", "#1e2236"],
  ["#aaa58d", "#d5b59f", "#33413b"],
  ["#ad755d", "#d1ae92", "#492c29"],
  ["#78868b", "#c9b1a7", "#28383e"],
  ["#7e637c", "#c3a2a3", "#332239"],
];
// 演员同样使用虚构姓名，供发现页检查数百个条目的浏览密度。
const seedActors = ["林纱月", "森川澪", "白石悠", "夏目凛"];
const actorSurnames = [
  "青木",
  "花村",
  "川原",
  "松原",
  "月野",
  "星川",
  "雨宫",
  "北原",
  "藤野",
  "浅井",
  "小野",
  "水原",
  "橘",
  "南条",
  "秋山",
  "池田",
  "远山",
  "西村",
  "桐谷",
  "吉野",
];
const actorGivenNames = [
  "遥",
  "诗织",
  "千夏",
  "优奈",
  "美晴",
  "铃",
  "里奈",
  "葵",
  "真帆",
  "花音",
  "千寻",
  "和叶",
];
const sampleActors = [
  ...seedActors,
  ...actorSurnames.flatMap((surname) => actorGivenNames.map((name) => `${surname}${name}`)),
].slice(0, 240);
const coverFilms: Film[] = baseFilms.map((film, i) => ({
  ...film,
  title: portraitTitles[i] ?? film.title,
  english: portraitEnglish[i] ?? film.english,
  actor: seedActors[i % seedActors.length]!,
  genre: ["剧情", "纪实", "精选"][i % 3] ?? "剧情",
  art: "portrait",
  palette: portraitPalettes[i % portraitPalettes.length] ?? film.palette,
}));

// 固定生成，刷新、排序、搜索时编号均保持稳定；只包含轻量元数据。
// 封面由虚拟列表按视口挂载，不在这里为 5,000 条记录创建 DOM 或图片。
export const sampleFilms: Film[] = Array.from({ length: 5000 }, (_, index) => {
  const template = coverFilms[index % coverFilms.length]!;
  const id = index + 1;
  return {
    ...template,
    id,
    code: `JVM-${String(id).padStart(3, "0")}`,
    actor:
      index < coverFilms.length || id % 5 === 0
        ? template.actor
        : sampleActors[4 + ((index * 17 + Math.floor(index / 11)) % (sampleActors.length - 4))]!,
    title:
      index < coverFilms.length
        ? template.title
        : `${template.title} · ${Math.floor(index / coverFilms.length) + 1}`,
    year: index < coverFilms.length ? template.year : 2021 + (index % 6),
    favorite: index < coverFilms.length ? template.favorite : id % 9 === 0,
    missing: index < coverFilms.length ? template.missing : id % 17 === 0,
  };
});

export type TaskStatus =
  | "downloading"
  | "queued"
  | "merging"
  | "paused"
  | "failed"
  | "completed"
  | "scrapeFailed"
  | "scraping"
  | "cancelled";
export interface DownloadTask {
  id: number;
  filmId?: number;
  resourceId?: string;
  quality?: Film["quality"];
  name: string;
  status: TaskStatus;
  progress: number;
  path: string;
  speed?: string;
  remaining?: string;
}
const baseDownloads: DownloadTask[] = [
  {
    id: 1,
    filmId: 1,
    name: "JVM-001 · 绯色时刻",
    status: "downloading",
    progress: 68,
    path: "D:\\Media\\Downloads",
    speed: "10.2 MB/s",
    remaining: "约 4 分 20 秒",
  },
  {
    id: 2,
    filmId: 3,
    name: "JVM-003 · 她的假日",
    status: "merging",
    progress: 100,
    path: "D:\\Media\\Downloads",
  },
  {
    id: 3,
    filmId: 2,
    name: "JVM-002 · 午夜来信",
    status: "paused",
    progress: 32,
    path: "D:\\Media\\Downloads",
  },
  {
    id: 4,
    filmId: 9,
    name: "JVM-009 · 心动片刻",
    status: "failed",
    progress: 56,
    path: "D:\\Media\\Downloads",
  },
  {
    id: 5,
    filmId: 5,
    name: "JVM-005 · 晚风",
    status: "completed",
    progress: 100,
    path: "D:\\Media\\Downloads",
  },
  {
    id: 6,
    filmId: 4,
    name: "JVM-004 · 余温",
    status: "scrapeFailed",
    progress: 100,
    path: "D:\\Media\\Downloads",
  },
];
const additionalDownloadGroups: [TaskStatus, number][] = [
  ["downloading", 3],
  ["merging", 1],
  ["scraping", 2],
  ["queued", 34],
  ["paused", 17],
  ["failed", 8],
  ["scrapeFailed", 2],
  ["completed", 47],
];
// 固定的 120 条任务覆盖下载、等待、后处理和历史记录；不会启动真实下载。
export const sampleDownloads: DownloadTask[] = [
  ...baseDownloads,
  ...additionalDownloadGroups
    .flatMap(([status, count]) => Array.from({ length: count }, () => status))
    .map((status, index) => {
      const film = sampleFilms[index + 12]!;
      return {
        id: baseDownloads.length + index + 1,
        filmId: film.id,
        name: `${film.code} · ${film.title}`,
        status,
        progress:
          status === "queued"
            ? 0
            : ["merging", "scraping", "scrapeFailed", "completed"].includes(status)
              ? 100
              : 18 + ((index * 23) % 73),
        path: "D:\\Media\\Downloads",
        speed: status === "downloading" ? ["3.8 MB/s", "6.4 MB/s", "8.1 MB/s"][index] : undefined,
        remaining:
          status === "downloading"
            ? ["约 12 分 08 秒", "约 8 分 42 秒", "约 2 分 16 秒"][index]
            : undefined,
      };
    }),
];
export const taskLabels: Record<TaskStatus, string> = {
  downloading: "下载中",
  queued: "等待中",
  merging: "合并中",
  paused: "已暂停",
  failed: "下载失败",
  completed: "已完成",
  scrapeFailed: "刮削失败",
  scraping: "刮削中",
  cancelled: "已停止",
};
