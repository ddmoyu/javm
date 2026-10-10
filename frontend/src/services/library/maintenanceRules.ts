import type {
  AdRules,
  MaintenanceRow,
  MaintenanceVideo,
  RemovalTarget,
} from "../../contracts/maintenance";

export function filename(path: string) {
  return path.split(/[\\/]/).at(-1) ?? "";
}
export function parentDirectory(path: string) {
  const parent = path.replaceAll("\\", "/").replace(/\/[^/]*$/, "");
  return /^[a-z]:$/i.test(parent) ? `${parent}/` : parent;
}
export function normalizeKeywords(lines: string[]) {
  const seen = new Set<string>();
  return lines
    .map((line) => line.trim())
    .filter((line) => {
      const key = line.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
function pixels(resolution: string) {
  const dimensions = /(\d+)\s*[x×]\s*(\d+)/i.exec(resolution);
  if (dimensions) return Number(dimensions[1]) * Number(dimensions[2]);
  const short = /4k|2160|1440|1080|720|480/i.exec(resolution)?.[0].toLowerCase();
  return short === "4k" ? 3840 * 2160 : short ? Number(short) ** 2 * (16 / 9) : 0;
}
function copyPenalty(path: string) {
  const name = filename(path);
  const suffix = /\((\d+)\)\.[^.]+$/.exec(name);
  return (
    name.length +
    (/副本|拷贝|复制|\bcopy\b/i.test(name) ? 1000 : 0) +
    (suffix ? 100 + Number(suffix[1]) : 0)
  );
}

export function usableCopy(video: MaintenanceVideo) {
  return !video.missing && video.size !== 0;
}
export function healthRows(videos: MaintenanceVideo[], all = false): MaintenanceRow[] {
  return videos
    .filter((video) => all || !!video.issues?.length)
    .map((video) => ({
      ...video,
      group: "",
      groupId: "",
      reason: all ? "手动选择的片库资源" : video.issues!.join("；"),
      crossDirectory: false,
      suggested: false,
      suggestedKeep: false,
      selected: false,
    }));
}

// 仅从未选中的可用文件里选择保留副本；实际删除前由原生复核磁盘状态。
export function retainedCopies(rows: MaintenanceRow[], selected: Set<string>) {
  const retained = new Map<string, NonNullable<RemovalTarget["retained"]>>();
  for (const row of rows)
    if (row.groupId && usableCopy(row) && !selected.has(row.id) && !retained.has(row.groupId))
      retained.set(row.groupId, { id: row.id, path: row.path });
  return retained;
}

// 在 Worker 中调用，番号和指纹的交叉关联也必须归入同一组。
export function duplicateRows(videos: MaintenanceVideo[]): MaintenanceRow[] {
  const parents = videos.map((_, index) => index);
  const root = (value: number): number => {
    let current = value;
    while (parents[current] !== current) {
      parents[current] = parents[parents[current]!]!;
      current = parents[current]!;
    }
    return current;
  };
  const codes = new Map<string, number>();
  const hashes = new Map<string, number>();
  videos.forEach((video, index) => {
    for (const [map, key] of [
      [codes, video.code.trim().toLowerCase()],
      [hashes, video.hash],
    ] as const) {
      if (!key) continue;
      const existing = map.get(key);
      if (existing === undefined) map.set(key, index);
      else parents[root(index)] = root(existing);
    }
  });
  const groups = new Map<number, MaintenanceVideo[]>();
  videos.forEach((video, index) => {
    const key = root(index);
    const group = groups.get(key) ?? [];
    group.push(video);
    groups.set(key, group);
  });
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      let maxDuration = 0;
      for (const video of group)
        if (usableCopy(video)) maxDuration = Math.max(maxDuration, video.duration);
      group.sort(
        (a, b) =>
          Number(usableCopy(b)) - Number(usableCopy(a)) ||
          Number(b.duration >= maxDuration * 0.9) - Number(a.duration >= maxDuration * 0.9) ||
          pixels(b.resolution) - pixels(a.resolution) ||
          (b.size ?? 0) - (a.size ?? 0) ||
          copyPenalty(a.path) - copyPenalty(b.path) ||
          a.path.localeCompare(b.path),
      );
      const groupCodes = new Set<string>(),
        groupHashes = new Set<string>();
      let sameCode = false,
        sameHash = false;
      for (const video of group) {
        const code = video.code.trim().toLowerCase();
        if (code && groupCodes.has(code)) sameCode = true;
        if (video.hash && groupHashes.has(video.hash)) sameHash = true;
        if (code) groupCodes.add(code);
        if (video.hash) groupHashes.add(video.hash);
      }
      const crossDirectory =
        new Set(group.map((video) => parentDirectory(video.path).toLowerCase())).size > 1;
      const name = group.find((video) => video.code.trim())?.code || `文件指纹 ${group[0]!.hash}`;
      const reason =
        sameCode && sameHash ? "番号与文件指纹关联" : sameHash ? "相同文件指纹" : "相同番号";
      const hasUsableCopy = usableCopy(group[0]!);
      return group.map((video, index) => ({
        ...video,
        group: name,
        groupId: group[0]!.id,
        reason,
        crossDirectory,
        suggested: hasUsableCopy && index > 0,
        suggestedKeep: hasUsableCopy && index === 0,
        selected: false,
      }));
    })
    .sort(
      (a, b) => Number(b[0]!.crossDirectory) - Number(a[0]!.crossDirectory) || b.length - a.length,
    )
    .flat();
}

export function adRows(videos: MaintenanceVideo[], rules: AdRules): MaintenanceRow[] {
  const names = new Map<string, number>();
  if (rules.duplicateNames)
    for (const video of videos) {
      const name = filename(video.path);
      names.set(name, (names.get(name) ?? 0) + 1);
    }
  const include = normalizeKeywords(rules.keywords);
  const exclude = normalizeKeywords(rules.excludeKeywords).map((keyword) => keyword.toLowerCase());
  const result: MaintenanceRow[] = [];
  for (const video of videos) {
    const name = filename(video.path),
      title = video.title.toLowerCase(),
      lowerName = name.toLowerCase();
    if (exclude.some((keyword) => lowerName.includes(keyword) || title.includes(keyword))) continue;
    const reasons: string[] = [];
    if (video.size === 0) reasons.push("文件大小为 0");
    else {
      const count = names.get(name) ?? 0;
      if (count > 1) reasons.push(`文件名重复 ${count} 次`);
      const keyword = include.find(
        (value) => lowerName.includes(value.toLowerCase()) || title.includes(value.toLowerCase()),
      );
      if (keyword) reasons.push(`包含关键词：${keyword}`);
    }
    if (reasons.length)
      result.push({
        ...video,
        group: "",
        groupId: "",
        reason: reasons.join("；"),
        crossDirectory: false,
        suggested: false,
        suggestedKeep: false,
        selected: false,
      });
  }
  return result;
}
