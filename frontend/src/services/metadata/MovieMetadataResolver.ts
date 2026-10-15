import type { MovieCandidate, MovieDetails } from "./MetaTubeService";
import { MovieDetailsCache, movieCandidate } from "./MovieDetailsCache";
import { requireMovieDetails } from "./movieSearch";
import type { ScrapeProvider } from "../scraping/ScrapeService";
import { normalizeCode as identityCode } from "../scraping/identity";
import { normalizeCode } from "../streamResolution/sources";
import { StopUnconfirmedError } from "../downloads/ports";

export interface MovieCatalogLookup {
  available: boolean;
  read(code: string, signal: AbortSignal): Promise<MovieDetails>;
}
export interface ResolvedMovie {
  candidate: MovieCandidate;
  details: MovieDetails;
}
function exactCode(value: string) {
  try {
    return normalizeCode(value);
  } catch {
    return undefined;
  }
}
export const isCatalogCandidate = (candidate: MovieCandidate) =>
  candidate.provider === "JavBus" &&
  !!candidate.code &&
  identityCode(candidate.id) === identityCode(candidate.code);

/** 复用已读详情；来源直接读取与后备查询均保留真实来源身份。 */
export class MovieMetadataResolver implements ScrapeProvider {
  constructor(
    private primary: ScrapeProvider,
    private cache = new MovieDetailsCache(),
    private catalog?: MovieCatalogLookup,
  ) {}
  private resolved(details: MovieDetails, code: string): ResolvedMovie {
    const candidate = movieCandidate(details);
    requireMovieDetails(details, { ...candidate, code });
    this.cache.remember(details);
    return { candidate, details };
  }
  async search(query: string, signal: AbortSignal, options?: { refresh?: boolean }) {
    signal.throwIfAborted();
    const code = exactCode(query);
    const cached = code && !options?.refresh ? this.cache.code(code) : undefined;
    if (cached) return [movieCandidate(cached)];
    let results: MovieCandidate[] = [];
    let failure: unknown;
    try {
      results = (await this.primary.search(query, signal)).filter(
        (item) => item.provider.trim() && item.id.trim(),
      );
      signal.throwIfAborted();
      if (!code || results.some((item) => identityCode(item.code) === identityCode(code)))
        return results;
    } catch (error) {
      if (error instanceof StopUnconfirmedError) throw error;
      signal.throwIfAborted();
      failure = error;
    }
    if (code && this.catalog?.available) {
      const details = await this.catalog.read(code, signal);
      signal.throwIfAborted();
      return [this.resolved(details, code).candidate];
    }
    if (failure) throw failure;
    return results;
  }
  async details(candidate: MovieCandidate, signal: AbortSignal) {
    signal.throwIfAborted();
    const cached = this.cache.candidate(candidate);
    if (cached) return cached;
    const details =
      isCatalogCandidate(candidate) && this.catalog?.available
        ? await this.catalog.read(candidate.code, signal)
        : await this.primary.details(candidate, signal);
    signal.throwIfAborted();
    requireMovieDetails(details, candidate);
    this.cache.remember(details);
    return details;
  }
  async resolve(candidate: MovieCandidate, signal: AbortSignal): Promise<ResolvedMovie> {
    signal.throwIfAborted();
    // 目录番号大小写等表示差异由真实返回身份统一，不能伪装成旧候选 ID。
    if (isCatalogCandidate(candidate) && this.catalog?.available) {
      const details =
        this.cache.candidate(candidate) ?? (await this.catalog.read(candidate.code, signal));
      signal.throwIfAborted();
      return this.resolved(details, candidate.code);
    }
    try {
      const details = await this.details(candidate, signal);
      signal.throwIfAborted();
      return this.resolved(details, candidate.code);
    } catch (error) {
      if (error instanceof StopUnconfirmedError) throw error;
      signal.throwIfAborted();
      const code = exactCode(candidate.code);
      if (!code) throw error;
      const cached = this.cache.code(code);
      if (cached) return this.resolved(cached, code);
      // 明确的目录候选已经直接读过该来源，不再重复同一请求。
      if (!this.catalog?.available || isCatalogCandidate(candidate)) throw error;
      const details = await this.catalog.read(code, signal);
      signal.throwIfAborted();
      return this.resolved(details, code);
    }
  }
}
