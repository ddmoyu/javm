import type { SavedResource } from "./archive";
import type { ResourceRow } from "./ResourceSearchService";

export interface ResourceLinkRow extends SavedResource {
  liveSourceIds: string[];
  savedIds: string[];
  added: boolean;
}

export function resourceLinkKey(url: string) {
  const value = new URL(url);
  value.hash = "";
  // 保留签名、清晰度等查询参数，只合并同一个实际地址。
  return value.href;
}

export function resourceVideoTrack(row: SavedResource) {
  return row.stream.tracks
    .filter((track) => track.kind === "video")
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
}

export function mergeResourceLinks(
  live: readonly ResourceRow[],
  saved: readonly SavedResource[],
  code: string,
  workId?: string,
) {
  const links = new Map<string, ResourceLinkRow>();
  for (const row of live) {
    if (!row.stream || row.saved) continue;
    const key = resourceLinkKey(row.stream.manifestUrl);
    const existing = links.get(key);
    if (existing) {
      existing.liveSourceIds.push(row.sourceId);
      existing.added ||= row.added;
    } else
      links.set(key, {
        id: row.taskId,
        code,
        workId,
        sourceId: row.sourceId,
        sourceName: row.sourceName,
        stream: row.stream,
        savedAt: row.stream.checkedAt,
        liveSourceIds: [row.sourceId],
        savedIds: [],
        added: row.added,
      });
  }
  for (const row of saved) {
    const key = resourceLinkKey(row.stream.manifestUrl);
    const existing = links.get(key);
    if (existing) existing.savedIds.push(row.id);
    else links.set(key, { ...row, liveSourceIds: [], savedIds: [row.id], added: false });
  }
  return [...links.values()];
}
