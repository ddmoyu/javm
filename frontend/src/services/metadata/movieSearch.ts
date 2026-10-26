import type { MovieCandidate, MovieDetails } from "./MetaTubeService";
import { serviceError } from "./shared";
import { normalizeCode as identityCode } from "../scraping/identity";
import { normalizeCode } from "../streamResolution/sources";
import { StopUnconfirmedError } from "../downloads/ports";
import { isMetadataNotice } from "./diagnostics";

export interface MovieSearchPort {
  search(query: string): Promise<MovieCandidate[]>;
  lookupByCode?(code: string, signal: AbortSignal): Promise<MovieDetails>;
}
export interface MovieSearchResult {
  candidates: MovieCandidate[];
  details?: MovieDetails;
  resourceCode?: string;
  error: string;
  notice?: string;
}
export function requireMovieDetails(value: MovieDetails, candidate: MovieCandidate) {
  const { fields } = value;
  if (
    !fields.code?.trim() ||
    !fields.title?.trim() ||
    !value.provider.trim() ||
    !value.id.trim() ||
    value.provider !== candidate.provider ||
    value.id !== candidate.id ||
    (candidate.code && identityCode(fields.code) !== identityCode(candidate.code))
  )
    throw new Error("影片详情为空或与搜索结果不一致，请重试。");
  const content =
    identityCode(fields.title) !== identityCode(fields.code) ||
    fields.plot ||
    fields.premiered ||
    fields.duration ||
    fields.actors?.length ||
    fields.director ||
    fields.studio ||
    fields.series ||
    fields.genres?.length ||
    value.coverUrl ||
    value.bigCoverUrl ||
    value.thumbUrl ||
    value.bigThumbUrl ||
    value.previewImages?.length;
  if (!content) throw new Error("资料服务只返回了番号，尚未取得影片详情。");
  return value;
}

export async function searchMovieMetadata(
  port: MovieSearchPort,
  query: string,
  signal: AbortSignal,
  allowResourceLookup: boolean,
): Promise<MovieSearchResult> {
  signal.throwIfAborted();
  let error = "";
  let notice = "";
  try {
    const candidates = (await port.search(query)).filter(
      (item) => item.provider.trim() && item.id.trim(),
    );
    signal.throwIfAborted();
    if (candidates.length) return { candidates, error: "" };
  } catch (reason) {
    if (reason instanceof StopUnconfirmedError) throw reason;
    signal.throwIfAborted();
    if (isMetadataNotice(reason)) notice = reason.message;
    else error = serviceError(reason);
  }
  let code: string | undefined;
  try {
    code = normalizeCode(query);
  } catch {
    // 片名没有结果时不能构造番号或影片。
  }
  if (code && port.lookupByCode) {
    try {
      const details = await port.lookupByCode(code, signal);
      signal.throwIfAborted();
      const candidate = {
        provider: details.provider,
        id: details.id,
        code: details.fields.code || code,
        title: details.fields.title || "",
      };
      requireMovieDetails(details, { ...candidate, code });
      return { candidates: [candidate], details, error: "" };
    } catch (reason) {
      if (reason instanceof StopUnconfirmedError) throw reason;
      signal.throwIfAborted();
      notice = isMetadataNotice(reason) ? reason.message : "";
      error = notice ? "" : serviceError(reason);
    }
  }
  return {
    candidates: [],
    resourceCode: allowResourceLookup ? code : undefined,
    error,
    ...(notice ? { notice } : {}),
  };
}
