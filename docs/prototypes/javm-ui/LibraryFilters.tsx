import { useMemo, useState } from "react";
import { Button, MultiSelect, Popover, Select } from "@mantine/core";
import type { Film } from "./data";
import { durationOptions, emptyLibraryFilters, metadataOptions, sizeOptions } from "./libraryQuery";
import type { LibraryFilters } from "./libraryQuery";
import { Icon } from "./visuals";

export function libraryFilterLabels(
  filters: LibraryFilters,
): { key: keyof LibraryFilters; value: string; label: string }[] {
  return [
    ...filters.actors.map((value) => ({ key: "actors" as const, value, label: value })),
    ...filters.genres.map((value) => ({ key: "genres" as const, value, label: `分类：${value}` })),
    ...filters.years.map((value) => ({ key: "years" as const, value, label: `${value} 年` })),
    ...filters.qualities.map((value) => ({ key: "qualities" as const, value, label: value })),
    ...(["duration", "size", "metadata"] as const).flatMap((key) => {
      const options =
        key === "duration" ? durationOptions : key === "size" ? sizeOptions : metadataOptions;
      return filters[key] === "all"
        ? []
        : [
            {
              key,
              value: filters[key],
              label: options.find((option) => option.value === filters[key])!.label,
            },
          ];
    }),
  ];
}

export function LibraryFilterButton({
  films,
  filters,
  onChange,
  resultCount,
}: {
  films: Film[];
  filters: LibraryFilters;
  onChange: (filters: LibraryFilters) => void;
  resultCount: number;
}) {
  const [opened, setOpened] = useState(false);
  const options = useMemo(
    () => ({
      actors: [...new Set(films.flatMap((film) => (film.actor ? [film.actor] : [])))].sort((a, b) =>
        a.localeCompare(b, "zh-CN"),
      ),
      genres: [...new Set(films.map((film) => film.genre))],
      years: [...new Set(films.map((film) => String(film.year)))].sort(
        (a, b) => Number(b) - Number(a),
      ),
      qualities: [...new Set(films.map((film) => film.quality))],
    }),
    [films],
  );
  const count = libraryFilterLabels(filters).length;
  const comboboxProps = { withinPortal: false };
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      width={650}
      shadow="lg"
      trapFocus
      returnFocus
      closeOnEscape={false}
      zIndex={250}
    >
      <Popover.Target>
        <Button
          size="xs"
          variant={count || opened ? "light" : "subtle"}
          color={count || opened ? "rose" : "gray"}
          leftSection={<Icon name="filter" size={16} />}
          aria-expanded={opened}
          aria-label="筛选影片"
          onClick={() => setOpened(!opened)}
        >
          筛选{count ? ` ${count}` : ""}
        </Button>
      </Popover.Target>
      <Popover.Dropdown
        className="library-filter-popover"
        onKeyDownCapture={(event) => {
          if (event.key !== "Escape") return;
          // 先关闭正在操作的下拉列表，再按 Esc 才关闭整个筛选面板。
          if ((event.target as HTMLElement).closest('[role="combobox"][aria-expanded="true"]')) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          setOpened(false);
        }}
      >
        <div className="library-filter-heading">
          <strong tabIndex={-1} data-autofocus>
            筛选影片
          </strong>
          <button
            className="text-link"
            type="button"
            disabled={!count}
            onClick={() => onChange(emptyLibraryFilters())}
          >
            重置条件
          </button>
        </div>
        <div className="library-filter-grid">
          <MultiSelect
            label="演员"
            placeholder="全部演员"
            data={options.actors}
            value={filters.actors}
            searchable
            clearable
            comboboxProps={comboboxProps}
            nothingFoundMessage="没有匹配的演员"
            onChange={(actors) => onChange({ ...filters, actors })}
          />
          <MultiSelect
            label="分类"
            placeholder="全部分类"
            data={options.genres}
            value={filters.genres}
            clearable
            comboboxProps={comboboxProps}
            onChange={(genres) => onChange({ ...filters, genres })}
          />
          <MultiSelect
            label="发行年份"
            placeholder="全部年份"
            data={options.years}
            value={filters.years}
            clearable
            comboboxProps={comboboxProps}
            onChange={(years) => onChange({ ...filters, years })}
          />
          <MultiSelect
            label="画质"
            placeholder="全部画质"
            data={options.qualities}
            value={filters.qualities}
            clearable
            comboboxProps={comboboxProps}
            onChange={(qualities) => onChange({ ...filters, qualities })}
          />
          <Select
            label="影片时长"
            data={durationOptions}
            value={filters.duration}
            comboboxProps={comboboxProps}
            allowDeselect={false}
            onChange={(duration) => onChange({ ...filters, duration: duration ?? "all" })}
          />
          <Select
            label="文件大小"
            data={sizeOptions}
            value={filters.size}
            comboboxProps={comboboxProps}
            allowDeselect={false}
            onChange={(size) => onChange({ ...filters, size: size ?? "all" })}
          />
          <Select
            label="资料状态"
            data={metadataOptions}
            value={filters.metadata}
            comboboxProps={comboboxProps}
            allowDeselect={false}
            onChange={(metadata) =>
              onChange({ ...filters, metadata: (metadata ?? "all") as LibraryFilters["metadata"] })
            }
          />
        </div>
        <div className="library-filter-footer">
          <span aria-live="polite">{resultCount.toLocaleString()} 部影片</span>
          <Button size="xs" onClick={() => setOpened(false)}>
            完成
          </Button>
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}
