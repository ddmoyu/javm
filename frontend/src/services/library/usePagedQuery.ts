import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { PagedQuery } from "./PagedQuery";
import type { LibraryService } from "./LibraryService";

export function usePagedQuery<T, Q>(
  library: LibraryService,
  view: PagedQuery<T, Q>,
  query: Q,
  active: boolean,
) {
  // 查询参数都是有界的可序列化值；稳定身份避免普通重绘重发请求。
  const key = JSON.stringify(query);
  const stableQuery = useMemo(() => JSON.parse(key) as Q, [key]);
  const snapshot = useSyncExternalStore(view.subscribe, view.getSnapshot);
  useEffect(() => library.attach(view), [library, view]);
  useEffect(() => {
    view.configure(stableQuery, active);
  }, [view, stableQuery, active]);
  return snapshot;
}
