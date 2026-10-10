import type { ResourceSource } from "./sources";

export interface SourcePerformance {
  attempts: number;
  successes: number;
  lastSuccessAt: number;
}
export type SourcePerformanceMap = Record<string, SourcePerformance>;

export function readSourcePerformance(
  value: unknown,
  sources: readonly ResourceSource[],
): SourcePerformanceMap {
  const result: SourcePerformanceMap = {};
  if (!value || typeof value !== "object") return result;
  for (const { id } of sources) {
    const item = (value as Record<string, unknown>)[id];
    if (!item || typeof item !== "object") continue;
    const stats = item as Partial<SourcePerformance>;
    if (
      !Number.isSafeInteger(stats.attempts) ||
      !Number.isSafeInteger(stats.successes) ||
      stats.attempts! < 0 ||
      stats.successes! < 0 ||
      stats.successes! > stats.attempts! ||
      stats.attempts! > 1_000_000_000
    )
      continue;
    result[id] = {
      attempts: stats.attempts!,
      successes: stats.successes!,
      lastSuccessAt: Number.isFinite(stats.lastSuccessAt) ? Math.max(0, stats.lastSuccessAt!) : 0,
    };
  }
  return result;
}

/** 平滑成功率避免一次命中永久领先；同分时优先成功次数，再保持原始顺序。 */
export function rankResourceSources(
  sources: readonly ResourceSource[],
  performance: SourcePerformanceMap,
): ResourceSource[] {
  const score = (id: string) => {
    const stats = performance[id];
    return ((stats?.successes ?? 0) + 1) / ((stats?.attempts ?? 0) + 2);
  };
  return [...sources].sort(
    (a, b) =>
      score(b.id) - score(a.id) ||
      (performance[b.id]?.successes ?? 0) - (performance[a.id]?.successes ?? 0),
  );
}
