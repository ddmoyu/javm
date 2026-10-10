import type { MovieCandidate } from "./MetaTubeService";
import { normalizeCode } from "../scraping/identity";

export interface MovieSearchGroup {
  key: string;
  candidate: MovieCandidate;
  candidates: MovieCandidate[];
}

/** 番号优先；没有番号时仅合并完整片名相同且无番号冲突的结果。 */
export async function mergeMovieCandidates(rows: readonly MovieCandidate[]) {
  const groups = new Map<string, MovieSearchGroup>();
  const titles = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const withoutCode: MovieCandidate[] = [];
  const titleKey = (title: string) =>
    title.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  const add = (key: string, candidate: MovieCandidate) => {
    const group = groups.get(key);
    if (group) group.candidates.push(candidate);
    else groups.set(key, { key, candidate, candidates: [candidate] });
  };
  const input = rows.slice(0, 500);
  for (let index = 0; index < input.length; index++) {
    if (index && index % 50 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const candidate = input[index]!;
    const identity = JSON.stringify([candidate.provider, candidate.id]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const code = normalizeCode(candidate.code);
    if (!code) {
      withoutCode.push(candidate);
      continue;
    }
    const key = `code:${code}`;
    add(key, candidate);
    const title = titleKey(candidate.title);
    if (title) {
      const keys = titles.get(title) ?? new Set<string>();
      keys.add(key);
      titles.set(title, keys);
    }
  }
  for (let index = 0; index < withoutCode.length; index++) {
    if (index && index % 50 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const candidate = withoutCode[index]!;
    const title = titleKey(candidate.title);
    const known = titles.get(title);
    const key =
      known?.size === 1
        ? [...known][0]!
        : title
          ? `title:${title}`
          : `item:${JSON.stringify([candidate.provider, candidate.id])}`;
    add(key, candidate);
  }
  return [...groups.values()];
}
