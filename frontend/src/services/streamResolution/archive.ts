import type { ResolvedStream } from "../../contracts/streamResolution";
import { normalizeCode } from "./sources";
import { normalizeRequest, webUrl } from "./shared";
import type { SourcePerformanceMap } from "./sourcePerformance";

export interface SavedResource {
  id: string;
  code: string;
  workId?: string;
  sourceId: string;
  sourceName: string;
  stream: ResolvedStream;
  savedAt: number;
}
export type ResourceRecord = Omit<SavedResource, "id" | "savedAt">;
export interface ResourcePreferences {
  query: string;
  code: string;
  selected: string[];
  filter: "all" | "found" | "failed";
  workId?: string;
  sourcePerformance?: SourcePerformanceMap;
}
export interface ResourceArchive {
  read(code: string, workId?: string): Promise<SavedResource[]>;
  save(record: ResourceRecord): Promise<void>;
  remove(id: string): Promise<void>;
  readPreferences(): Promise<unknown>;
  writePreferences(value: ResourcePreferences): Promise<void>;
}
/** Persist only technical stream data and reproducible public headers. */
export function archivedStream(stream: ResolvedStream): ResolvedStream {
  const request = normalizeRequest({
    url: stream.manifestUrl,
    provider: "direct-hls",
    publicHeaders: stream.context?.publicHeaders,
    preferProxy: stream.context?.preferProxy,
  });
  if (
    !Array.isArray(stream.tracks) ||
    stream.tracks.length > 16 ||
    !Number.isFinite(stream.checkedAt) ||
    !Number.isFinite(stream.expiresAt)
  )
    throw new Error("保存的资源记录无效，请重新查找。");
  return {
    pageUrl: webUrl(stream.pageUrl),
    manifestUrl: request.url,
    discoveredBy: stream.discoveredBy === "webview" ? "webview" : "http",
    checkedAt: stream.checkedAt,
    expiresAt: stream.expiresAt,
    validation: "playlist-and-sample",
    context: {
      origin: new URL(request.url).origin,
      headers: {},
      publicHeaders: request.publicHeaders,
      preferProxy: request.preferProxy,
    },
    tracks: stream.tracks.map((track) => ({
      kind: track.kind === "audio" ? "audio" : "video",
      url: webUrl(track.url),
      duration: Number.isFinite(track.duration) ? Math.max(0, track.duration) : 0,
      bandwidth: Number.isFinite(track.bandwidth) ? Math.max(0, track.bandwidth!) : undefined,
      width: Number.isFinite(track.width) ? Math.max(0, track.width!) : undefined,
      height: Number.isFinite(track.height) ? Math.max(0, track.height!) : undefined,
    })),
  };
}
export function resourceRecord(record: ResourceRecord): ResourceRecord {
  return {
    code: normalizeCode(record.code),
    workId: record.workId,
    sourceId: record.sourceId.slice(0, 100),
    sourceName: record.sourceName.slice(0, 256),
    stream: archivedStream(record.stream),
  };
}
