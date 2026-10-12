import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

// 以 .page-content 为滚动容器的定高网格；只渲染可见行，并在接近末尾时请求更多数据。
export function VirtualGrid({
  count,
  columns: columnsFor,
  rowHeight: rowHeightFor,
  gap,
  active,
  getKey,
  renderItem,
  onRangeChange,
  onEndReached,
  label,
  overscan = 3,
}: {
  count: number;
  columns: (width: number) => number;
  rowHeight: (cardWidth: number) => number;
  gap: number;
  active: boolean;
  getKey: (index: number) => string | number;
  renderItem: (index: number) => ReactNode;
  onRangeChange?: (first: number, last: number) => void;
  onEndReached?: () => void;
  label: string;
  overscan?: number;
}) {
  const rootRef = useRef<HTMLUListElement>(null);
  const [geometry, setGeometry] = useState({ width: 900, margin: 0 });
  const columns = Math.max(1, columnsFor(geometry.width));
  const cardWidth = (geometry.width - (columns - 1) * gap) / columns;
  const cardHeight = rowHeightFor(cardWidth);
  const getScrollElement = useCallback(
    () => rootRef.current?.closest<HTMLElement>(".page-content") ?? null,
    [],
  );
  const measureGeometry = useCallback(() => {
    const element = rootRef.current;
    const scrollElement = getScrollElement();
    if (!active || !element || !scrollElement || element.clientWidth === 0) return;
    const width = element.clientWidth;
    const margin =
      element.getBoundingClientRect().top -
      scrollElement.getBoundingClientRect().top +
      scrollElement.scrollTop;
    setGeometry((previous) =>
      previous.width === width && previous.margin === margin ? previous : { width, margin },
    );
  }, [active, getScrollElement]);
  useLayoutEffect(measureGeometry);
  useLayoutEffect(() => {
    const scrollElement = getScrollElement();
    if (!active || !rootRef.current || !scrollElement) return;
    const observer = new ResizeObserver(measureGeometry);
    observer.observe(rootRef.current);
    observer.observe(scrollElement);
    return () => observer.disconnect();
  }, [active, getScrollElement, measureGeometry]);
  const getItemKey = useCallback((index: number) => `${columns}:${index}`, [columns]);
  // oxlint-disable-next-line react/incompatible-library -- TanStack Virtual 官方 API，当前工程未启用 React Compiler。
  const virtualizer = useVirtualizer({
    count: Math.ceil(count / columns),
    getScrollElement,
    estimateSize: () => cardHeight + gap,
    getItemKey,
    overscan,
    scrollMargin: geometry.margin,
    enabled: active,
  });
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [cardHeight, gap, virtualizer]);
  const rows = virtualizer.getVirtualItems();
  const firstRow = rows[0]?.index ?? 0;
  const lastRow = rows.at(-1)?.index ?? -1;
  const rowCount = Math.ceil(count / columns);
  useEffect(() => {
    if (active && count && lastRow >= 0)
      onRangeChange?.(firstRow * columns, Math.min(count - 1, (lastRow + 1) * columns - 1));
  }, [active, count, columns, firstRow, lastRow, onRangeChange]);
  const nearEnd = active && lastRow >= 0 && lastRow >= rowCount - 1 - overscan;
  useEffect(() => {
    if (nearEnd) onEndReached?.();
  }, [nearEnd, count, onEndReached]);
  return (
    <ul
      ref={rootRef}
      className="virtual-canvas"
      aria-label={label}
      style={{ height: Math.max(0, virtualizer.getTotalSize() - gap) }}
    >
      {rows.flatMap((row) =>
        Array.from({ length: Math.min(columns, count - row.index * columns) }, (_, offset) => {
          const index = row.index * columns + offset;
          return (
            <li
              key={getKey(index)}
              className="virtual-grid-item"
              style={{
                transform: `translateY(${row.start - geometry.margin}px)`,
                left: offset * (cardWidth + gap),
                width: cardWidth,
                height: cardHeight,
              }}
            >
              {renderItem(index)}
            </li>
          );
        }),
      )}
    </ul>
  );
}
