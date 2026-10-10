import { useEffect, useState } from "react";
import type { DiscoveryCatalogService } from "../../services/catalog/DiscoveryCatalogService";
import type { CatalogDimension } from "../../services/catalog/discoveryData";
import { isActorDirectoryDimension } from "../../services/catalog/discoveryData";

export function usePortraits(
  service: DiscoveryCatalogService | undefined,
  dimension: CatalogDimension,
  names: string[],
  active: boolean,
) {
  const [state, setState] = useState<{
    key: string;
    images: Record<string, string>;
    progress: { completed: number; total: number } | null;
  }>({ key: "", images: {}, progress: null });
  const key = JSON.stringify(names),
    scope = `${dimension}:${key}`;
  useEffect(() => {
    if (!active || !service?.portraits || !isActorDirectoryDimension(dimension)) return;
    const batch = JSON.parse(key) as string[];
    if (!batch.length) return;
    const abort = new AbortController();
    void service.portraits
      .load(dimension, batch, abort.signal, (completed, total, images) => {
        if (!abort.signal.aborted) setState({ key: scope, images, progress: { completed, total } });
      })
      .then((images) => {
        if (!abort.signal.aborted) setState({ key: scope, images, progress: null });
      })
      .catch(() => {
        if (!abort.signal.aborted) setState({ key: scope, images: {}, progress: null });
      });
    return () => abort.abort();
  }, [service, dimension, key, scope, active]);
  const enabled =
    active && !!service?.portraits && isActorDirectoryDimension(dimension) && names.length > 0;
  return {
    images: enabled && state.key === scope ? state.images : {},
    progress: !enabled
      ? null
      : state.key === scope
        ? state.progress
        : { completed: 0, total: names.length },
  };
}
