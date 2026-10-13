import { useEffect, useEffectEvent, useState } from "react";
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
    key: string;
    images: Record<string, string>;
    tried: ReadonlySet<string>;
    progress: { completed: number; total: number } | null;
  }>({ dimension: "", key: "", images: {}, tried: new Set(), progress: null });
  const known = state.dimension === dimension ? state : null;
  const missing = names
    ? names
        .split("\n")
        .filter((name) => !known?.tried.has(name) && !Object.hasOwn(known?.images ?? {}, name))
    : [];
  const enabled = active && !!service?.portraits && isActorDirectoryDimension(dimension);
  // 只在可见范围切换时读取待加载名单，头像回传不能重启当前批次。
  const getMissing = useEffectEvent(() => missing);
  useEffect(() => {
    if (!enabled || !isActorDirectoryDimension(dimension)) return;
    const batch = getMissing();
    const abort = new AbortController();
    let finished = false;
    const merge = (
      images: Record<string, string>,
      progress: { completed: number; total: number } | null,
      attempted = false,
    ) =>
      setState((previous) => {
        const same = previous.dimension === dimension;
        let merged = { ...(same ? previous.images : {}), ...images };
        const cachedNames = Object.keys(merged);
        if (cachedNames.length > MAX_REMEMBERED)
          merged = Object.fromEntries(
            cachedNames.slice(-MAX_REMEMBERED).map((name) => [name, merged[name]!]),
          );
        let tried = same ? previous.tried : new Set<string>();
        // 服务繁忙时会直接返回空结果；只有确实执行过的批次才标记为已尝试。
        if (attempted) tried = new Set([...(tried.size > MAX_REMEMBERED ? [] : tried), ...batch]);
        return {
          dimension,
          key: names,
          images: merged,
          tried,
          progress,
        };
      });
    merge({}, batch.length ? { completed: 0, total: batch.length } : null);
    if (!batch.length) return;
    void service!
      .portraits!.load(dimension, batch, abort.signal, (completed, total, images) => {
        if (abort.signal.aborted) return;
        finished = completed === total;
        merge(images, { completed, total });
      })
      .then((images) => {
        if (!abort.signal.aborted) merge(images, null, finished);
      })
      .catch(() => {
        if (!abort.signal.aborted) merge({}, null);
      });
    return () => abort.abort();
  }, [service, dimension, names, enabled]);
  return {
    images: enabled && known ? known.images : {},
    progress:
      !enabled || !names
        ? null
        : known?.key === names
          ? known.progress
          : missing.length
            ? { completed: 0, total: missing.length }
            : null,
  };
}
