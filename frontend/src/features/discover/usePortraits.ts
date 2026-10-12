import { useEffect, useState } from "react";
import type { DiscoveryCatalogService } from "../../services/catalog/DiscoveryCatalogService";
import type { CatalogDimension } from "../../services/catalog/discoveryData";
import { isActorDirectoryDimension } from "../../services/catalog/discoveryData";

const MAX_REMEMBERED = 1000;

// names 为换行分隔的可见名称（至多一百项）。滚动时保留已取得的头像，只请求新出现的名称。
export function usePortraits(
  service: DiscoveryCatalogService | undefined,
  dimension: CatalogDimension,
  names: string,
  active: boolean,
) {
  const [state, setState] = useState<{
    dimension: CatalogDimension | "";
    images: Record<string, string>;
    tried: ReadonlySet<string>;
    progress: { key: string; completed: number; total: number } | null;
  }>({ dimension: "", images: {}, tried: new Set(), progress: null });
  const known = state.dimension === dimension ? state : null;
  const missing = names
    ? names
        .split("\n")
        .filter((name) => !known?.tried.has(name) && !Object.hasOwn(known?.images ?? {}, name))
    : [];
  const key = missing.join("\n");
  const enabled = active && !!service?.portraits && isActorDirectoryDimension(dimension);
  useEffect(() => {
    if (!enabled || !key || !isActorDirectoryDimension(dimension)) return;
    const batch = key.split("\n");
    const abort = new AbortController();
    const merge = (images: Record<string, string>, done: boolean, completed = 0) =>
      setState((previous) => {
        const same = previous.dimension === dimension;
        let merged = { ...(same ? previous.images : {}), ...images };
        const names = Object.keys(merged);
        if (names.length > MAX_REMEMBERED)
          merged = Object.fromEntries(
            names.slice(-MAX_REMEMBERED).map((name) => [name, merged[name]!]),
          );
        let tried = same ? previous.tried : new Set<string>();
        // 服务繁忙时会直接返回空结果；只有确实执行过的批次才标记为已尝试。
        if (done && Object.keys(images).length)
          tried = new Set([...(tried.size > MAX_REMEMBERED ? [] : tried), ...batch]);
        return {
          dimension,
          images: merged,
          tried,
          progress: done ? null : { key, completed, total: batch.length },
        };
      });
    void service!
      .portraits!.load(dimension, batch, abort.signal, (completed, _total, images) => {
        if (!abort.signal.aborted) merge(images, false, completed);
      })
      .then((images) => {
        if (!abort.signal.aborted) merge(images, true);
      })
      .catch(() => {
        if (!abort.signal.aborted) merge({}, true);
      });
    return () => abort.abort();
  }, [service, dimension, key, enabled]);
  return {
    images: enabled && known ? known.images : {},
    progress:
      !enabled || !key
        ? null
        : known?.progress?.key === key
          ? known.progress
          : { completed: 0, total: missing.length },
  };
}
