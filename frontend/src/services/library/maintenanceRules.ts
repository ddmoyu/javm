import type {
  AdRules,
  MaintenanceRow,
  MaintenanceVideo,
  RemovalTarget,
} from "../../contracts/maintenance";
import { normalizedPath, pathComparisonKey } from "../paths";

export function filename(path: string) {
  return normalizedPath(path).split("/").at(-1) ?? "";
}
export function parentDirectory(path: string) {
  const parent = normalizedPath(path).replace(/\/[^/]*$/, "");
  return /^[a-z]:$/i.test(parent) ? `${parent}/` : parent || (path.startsWith("/") ? "/" : "");
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
  const short = /8k|4k|4320|2160|1440|1080|720|480/i.exec(resolution)?.[0].toLowerCase();
  const height = short === "8k" ? 4320 : short === "4k" ? 2160 : Number(short ?? 0);
  return height ** 2 * (16 / 9);
}
const positive = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
function estimatedBitrate(video: MaintenanceVideo) {
  return positive(video.size) && positive(video.duration) ? (video.size * 8) / video.duration : 0;
}
export function videoBitrate(video: MaintenanceVideo) {
  return positive(video.bitrate)
    ? { value: video.bitrate, estimated: false }
    : { value: estimatedBitrate(video), estimated: true };
}
function codecKey(codec = "") {
  const key = codec.toLowerCase().replace(/[\s._-]/g, "");
  if (["avc", "avc1", "h264", "x264"].includes(key)) return "h264";
  if (["hevc", "h265", "x265", "hev1", "hvc1"].includes(key)) return "h265";
  return key;
}
export function videoPart(video: MaintenanceVideo) {
  if (positive(video.part)) return video.part;
  return Number(
    /(?:^|[ ._-])(?:cd|disc|disk|part)[ ._-]*(\d{1,2})(?:$|[ ._-])/i.exec(
      filename(video.path).replace(/\.[^.]+$/, ""),
    )?.[1] ?? 0,
  );
}
export function retentionKey(row: MaintenanceRow) {
  const part = videoPart(row);
  return part ? `${row.groupId}:part:${part}` : row.groupId;
}
function similarDuration(a: number, b: number) {
  return (
    positive(a) &&
    positive(b) &&
    Math.abs(a - b) <= Math.max(5, Math.min(60, Math.max(a, b) * 0.02))
  );
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
  for (const row of rows) {
    const key = retentionKey(row);
    if (row.groupId && usableCopy(row) && !selected.has(row.id) && !retained.has(key))
      retained.set(key, { id: row.id, path: row.path });
  }
  return retained;
}

/** 参数建议不代表画面质量检测；未知参数、分段及不同剪辑不自动清理。 */
function qualityAdvice(keep: MaintenanceVideo, video: MaintenanceVideo) {
  if (!usableCopy(video)) return { review: true, advice: "文件不可用，请先核对磁盘状态" };
  if (
    !positive(keep.size) ||
    !positive(video.size) ||
    !positive(keep.duration) ||
    !positive(video.duration) ||
    !pixels(keep.resolution) ||
    !pixels(video.resolution)
  )
    return { review: true, advice: "视频参数不完整，请重新扫描后核对" };
  if (!similarDuration(keep.duration, video.duration))
    return { review: true, advice: "时长差异明显，可能是分段或不同剪辑版本" };
  if (pixels(keep.resolution) > pixels(video.resolution))
    return { review: false, advice: "时长接近，分辨率低于建议保留版本" };
  const codec = codecKey(keep.codec);
  if (!codec || !codecKey(video.codec))
    return { review: true, advice: "编码信息不完整，无法可靠比较码率" };
  if (codec !== codecKey(video.codec))
    return { review: true, advice: "编码不同，不能仅凭码率或大小判断画质" };
  const measured = positive(keep.bitrate) && positive(video.bitrate);
  const keepRate = measured ? keep.bitrate! : estimatedBitrate(keep);
  const rate = measured ? video.bitrate! : estimatedBitrate(video);
  if (keepRate > rate * 1.05)
    return {
      review: false,
      advice: measured
        ? "同分辨率、同编码，视频码率较低"
        : "同分辨率、同编码，估算总码率较低，仅供参考",
    };
  if (rate > keepRate * 1.05) return { review: true, advice: "码率与其他参数结论冲突，请人工核对" };
  if (keepRate !== rate) return { review: true, advice: "码率差异很小，无法确定明显较差的版本" };
  if (keep.hash && keep.hash === video.hash && keep.size === video.size)
    return { review: false, advice: "文件指纹、大小与视频参数一致，建议清理此副本" };
  if (keep.size > video.size)
    return { review: false, advice: "画质参数接近，按文件大小辅助选择保留版本" };
  return { review: false, advice: "画质参数接近，优先保留无副本后缀的文件" };
}

function keepAdvice(keep: MaintenanceVideo, other: MaintenanceVideo) {
  if (pixels(keep.resolution) > pixels(other.resolution))
    return "时长接近，优先保留分辨率更高的版本";
  const measured = positive(keep.bitrate) && positive(other.bitrate);
  const rate = measured ? keep.bitrate! : estimatedBitrate(keep);
  const otherRate = measured ? other.bitrate! : estimatedBitrate(other);
  if (rate > otherRate * 1.05)
    return measured
      ? "同分辨率、同编码，优先保留视频码率更高的版本"
      : "同分辨率、同编码，估算总码率更高，仅供参考";
  if ((keep.size ?? 0) > (other.size ?? 0)) return "画质参数接近，按文件大小辅助选择保留版本";
  return "画质参数接近，优先保留无副本后缀的文件";
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
  const works = new Map<string, number>();
  videos.forEach((video, index) => {
    for (const [map, key] of [
      [works, video.workId ?? ""],
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
      const available = group.filter(usableCopy);
      const codecs = new Set(available.map((video) => codecKey(video.codec)));
      const sameCodec = codecs.size === 1 && !codecs.has("");
      // 全组采用同一口径，避免实测视频码率与估算总码率混排产生不稳定排序。
      const measured = available.every((video) => positive(video.bitrate));
      const rank = new Map(
        group.map((video) => [
          video.id,
          {
            pixels: pixels(video.resolution),
            bitrate: sameCodec ? (measured ? (video.bitrate ?? 0) : estimatedBitrate(video)) : 0,
            penalty: copyPenalty(video.path),
          },
        ]),
      );
      group.sort(
        (a, b) =>
          Number(usableCopy(b)) - Number(usableCopy(a)) ||
          Number(similarDuration(b.duration, maxDuration)) -
            Number(similarDuration(a.duration, maxDuration)) ||
          (!similarDuration(a.duration, maxDuration) ? b.duration - a.duration : 0) ||
          rank.get(b.id)!.pixels - rank.get(a.id)!.pixels ||
          rank.get(b.id)!.bitrate - rank.get(a.id)!.bitrate ||
          (b.size ?? 0) - (a.size ?? 0) ||
          rank.get(a.id)!.penalty - rank.get(b.id)!.penalty ||
          a.path.localeCompare(b.path) ||
          a.id.localeCompare(b.id),
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
        new Set(group.map((video) => pathComparisonKey(parentDirectory(video.path)))).size > 1;
      const name = group.find((video) => video.code.trim())?.code || `文件指纹 ${group[0]!.hash}`;
      const reason =
        sameCode && sameHash
          ? "番号与文件指纹关联"
          : sameHash
            ? "相同文件指纹"
            : sameCode
              ? "相同番号"
              : "同一作品";
      const hasUsableCopy = usableCopy(group[0]!);
      const groupWarning = group.some((video) => videoPart(video) > 0 || (video.parts ?? 0) > 1)
        ? "包含分段视频，请按分段核对，未自动选择清理项"
        : groupCodes.size > 1
          ? "分组包含不同番号，请先核对作品关联"
          : "";
      const advice = group.map((video) =>
        groupWarning ? { review: true, advice: groupWarning } : qualityAdvice(group[0]!, video),
      );
      const replacement = advice.findIndex((item, index) => index > 0 && !item.review);
      const hasSuggestion = hasUsableCopy && replacement > 0;
      return group.map((video, index) => ({
        ...video,
        group: sameCode || sameHash ? name : group[0]!.title || "同一作品",
        groupId: group[0]!.id,
        reason,
        crossDirectory,
        suggested: hasSuggestion && index > 0 && !advice[index]!.review,
        suggestedKeep: hasSuggestion && index === 0,
        review: index === 0 ? !hasSuggestion : advice[index]!.review,
        advice:
          hasSuggestion && index === 0
            ? keepAdvice(group[0]!, group[replacement]!)
            : advice[index]!.review || index > 0
              ? advice[index]!.advice
              : "没有明确较差的版本，请人工核对",
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
