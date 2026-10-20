import type { MovieCandidate, MovieDetails } from "../metadata/MetaTubeService";
import { Settings, JsonHttpError } from "../metadata/shared";
import type { Store } from "../metadata/shared";
import type { ScrapeProvider } from "./ScrapeService";
import { normalizeCode } from "./identity";
import { StopUnconfirmedError } from "../downloads/ports";
import type { EditableMetadata } from "../../contracts/metadata";
import type { ResolvedMovie } from "../metadata/MovieMetadataResolver";
import { requireMovieDetails } from "../metadata/movieSearch";
import { MetadataQueryError, withMetadataTrace } from "../metadata/diagnostics";
import type { MetadataQueryOptions } from "../metadata/diagnostics";

export interface MetadataPipelineSettings {
  fusion: boolean;
  retries: number;
}
export const defaultPipeline: MetadataPipelineSettings = { fusion: false, retries: 2 };
export function validatePipeline(raw: unknown): MetadataPipelineSettings {
  const value = raw as MetadataPipelineSettings;
  if (
    !value ||
    typeof value.fusion !== "boolean" ||
    !Number.isInteger(value.retries) ||
    value.retries < 0 ||
    value.retries > 3
  )
    throw new Error("资料设置无效。");
  return { fusion: value.fusion, retries: value.retries };
}
export async function retryMetadata<T>(
  operation: () => Promise<T>,
  count: number,
  signal: AbortSignal,
  sleep = (ms: number, active: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer);
        active.removeEventListener("abort", cancel);
        reject(active.reason);
      };
      const timer = setTimeout(() => {
        active.removeEventListener("abort", cancel);
        resolve();
      }, ms);
      active.addEventListener("abort", cancel, { once: true });
      if (active.aborted) cancel();
    }),
) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const result = await operation();
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (error instanceof StopUnconfirmedError) throw error;
      signal.throwIfAborted();
      if (
        attempt >= count ||
        (error instanceof MetadataQueryError
          ? !error.retryable
          : error instanceof JsonHttpError &&
            error.status !== 408 &&
            error.status !== 429 &&
            error.status < 500) ||
        error instanceof SyntaxError
      )
        throw error;
      await sleep(Math.min(8000, 1000 * 2 ** attempt), signal);
    }
  }
}
/** 用户选中的主来源优先，只用同番号来源补空字段；保留每个字段的出处。 */
export function fuseMetadata(primary: MovieDetails, others: MovieDetails[]): MovieDetails {
  const code = normalizeCode(primary.fields.code ?? "");
  const sources = [primary, ...others].filter(
    (item) => !!code && normalizeCode(item.fields.code ?? "") === code,
  );
  const fields: Partial<EditableMetadata> = { code: primary.fields.code };
  const fieldSources: Record<string, { provider: string; id: string }> = {};
  const present = (value: unknown) =>
    Array.isArray(value)
      ? value.length > 0
      : typeof value === "number"
        ? value > 0
        : typeof value === "string" && !!value.trim();
  for (const key of [
    "title",
    "originalTitle",
    "premiered",
    "director",
    "studio",
    "label",
    "plot",
    "series",
    "actors",
    "genres",
    "tags",
    "rating",
    "duration",
  ] as const) {
    const choices = sources.filter((item) => present(item.fields[key])),
      picked = choices[0];
    if (!picked) continue;
    Object.assign(fields, { [key]: picked.fields[key] });
    fieldSources[key] = { provider: picked.provider, id: picked.id };
  }
  // 封面保留主来源，避免补全后图片 URL 与 Referer 身份不一致。
  return {
    ...primary,
    fields,
    fusion: {
      sources: sources.map(({ provider, id, homepage }) => ({ provider, id, homepage })),
      fields: fieldSources,
    },
  };
}
export class MetadataPipeline implements ScrapeProvider {
  readonly settings: Settings<MetadataPipelineSettings>;
  constructor(
    private metatube: ScrapeProvider,
    store: Store<MetadataPipelineSettings>,
    available: boolean,
  ) {
    this.settings = new Settings(store, defaultPipeline, validatePipeline, available);
    void this.settings.initialize();
  }
  async search(query: string, signal: AbortSignal, options?: MetadataQueryOptions) {
    const settings = await this.settings.require(),
      active = AbortSignal.any([signal, AbortSignal.timeout(90000)]);
    return withMetadataTrace("search", options, active, async (traced) =>
      (
        await retryMetadata(
          () => this.metatube.search(query, active, traced),
          settings.retries,
          active,
        )
      ).slice(0, 500),
    );
  }
  async details(candidate: MovieCandidate, signal: AbortSignal, options?: MetadataQueryOptions) {
    return (await this.resolve(candidate, signal, options)).details;
  }
  async resolve(
    candidate: MovieCandidate,
    signal: AbortSignal,
    options?: MetadataQueryOptions,
  ): Promise<ResolvedMovie> {
    return withMetadataTrace("details", options, signal, (traced) =>
      this.resolveTraced(candidate, signal, traced),
    );
  }
  private async resolveTraced(
    candidate: MovieCandidate,
    signal: AbortSignal,
    options: MetadataQueryOptions,
  ): Promise<ResolvedMovie> {
    const settings = await this.settings.require(),
      active = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
    const load = async (item: MovieCandidate) => {
      const resolved = await retryMetadata(
        async () =>
          this.metatube.resolve
            ? this.metatube.resolve(item, active, options)
            : { candidate: item, details: await this.metatube.details(item, active, options) },
        settings.retries,
        active,
      );
      const result = resolved.details;
      active.throwIfAborted();
      if (
        !result.fields.title ||
        !result.fields.code ||
        normalizeCode(result.fields.code) !== normalizeCode(candidate.code) ||
        normalizeCode(resolved.candidate.code) !== normalizeCode(candidate.code) ||
        result.provider !== resolved.candidate.provider ||
        result.id !== resolved.candidate.id
      )
        throw new Error("资料来源身份不一致，未采用结果。");
      requireMovieDetails(result, resolved.candidate);
      return resolved;
    };
    const primary = await load(candidate);
    if (!settings.fusion) return primary;
    let candidates: MovieCandidate[];
    try {
      candidates = await this.search(candidate.code, active, { ...options, refresh: true });
    } catch (e) {
      if (e instanceof StopUnconfirmedError) throw e;
      active.throwIfAborted();
      return primary;
    }
    const others: MovieDetails[] = [],
      seen = new Set([primary.candidate.provider]);
    for (const item of candidates) {
      if (seen.has(item.provider) || normalizeCode(item.code) !== normalizeCode(candidate.code))
        continue;
      seen.add(item.provider);
      if (
        new Set(
          candidates
            .filter(
              (other) =>
                other.provider === item.provider &&
                normalizeCode(other.code) === normalizeCode(candidate.code),
            )
            .map((other) => other.id),
        ).size !== 1
      )
        continue;
      try {
        const other = (await load(item)).details;
        if (
          other.provider !== primary.details.provider &&
          !others.some((value) => value.provider === other.provider)
        )
          others.push(other);
      } catch (e) {
        if (e instanceof StopUnconfirmedError) throw e;
        active.throwIfAborted();
      }
      if (others.length >= 2) break;
    }
    return { candidate: primary.candidate, details: fuseMetadata(primary.details, others) };
  }
}
