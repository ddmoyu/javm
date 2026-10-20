import type { MovieCandidate, MovieDetails } from "./MetaTubeService";
import { requireMovieDetails } from "./movieSearch";
import { normalizeCode } from "../scraping/identity";

export const movieCandidate = (details: MovieDetails): MovieCandidate => ({
  provider: details.provider,
  id: details.id,
  code: details.fields.code || "",
  title: details.fields.title || "",
});
const keyOf = (candidate: Pick<MovieCandidate, "provider" | "id">) =>
  JSON.stringify([candidate.provider, candidate.id]);
const ttl = 15 * 60_000;
const byteLimit = 4 * 1024 * 1024;

/** 只保留用户实际读取过的有效详情，不预取作品；发现、搜索与刮削共用。 */
export class MovieDetailsCache {
  private entries = new Map<string, { value: MovieDetails; at: number; bytes: number }>();
  private bytes = 0;
  constructor(private now = Date.now) {}
  private remove(key: string) {
    this.bytes -= this.entries.get(key)?.bytes ?? 0;
    this.entries.delete(key);
  }
  remember(value: MovieDetails) {
    requireMovieDetails(value, movieCandidate(value));
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const key = keyOf(value);
    this.remove(key);
    if (bytes > 256 * 1024) return;
    while (this.entries.size >= 64 || this.bytes + bytes > byteLimit)
      this.remove(this.entries.keys().next().value!);
    this.entries.set(key, { value: structuredClone(value), at: this.now(), bytes });
    this.bytes += bytes;
  }
  private read(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (this.now() - entry.at >= ttl) {
      this.remove(key);
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return structuredClone(entry.value);
  }
  candidate(candidate: MovieCandidate) {
    const value = this.read(keyOf(candidate));
    return value && normalizeCode(value.fields.code ?? "") === normalizeCode(candidate.code)
      ? value
      : undefined;
  }
  code(code: string, provider?: string) {
    const normalized = normalizeCode(code);
    for (const [key, entry] of [...this.entries].reverse()) {
      if (
        (!provider || entry.value.provider === provider) &&
        normalized &&
        normalizeCode(entry.value.fields.code ?? "") === normalized
      ) {
        const value = this.read(key);
        if (value) return value;
      }
    }
  }
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}
