import { getLocale, t, localizeOptions, useLocale } from "../../i18n/index";
import { useState } from "react";
import { useDebouncedValue } from "@mantine/hooks";
import {
  Anchor,
  Button,
  Group,
  MultiSelect,
  Popover,
  Select,
  SimpleGrid,
  Text,
} from "@mantine/core";
import type { FacetDimension, LibraryQuery } from "../../contracts/library";
import { useWorkspace } from "../../app/state";
import { usePagedQuery } from "../../services/library/usePagedQuery";
import {
  availabilityOptions,
  durationOptions,
  emptyLibraryFilters,
  metadataOptions,
  sizeOptions,
} from "./libraryQuery";
import type { LibraryFilters } from "./libraryQuery";
import { Icon } from "../../components/icons";

export function libraryFilterLabels(
  filters: LibraryFilters,
  availability: NonNullable<LibraryQuery["availability"]>,
): { key: keyof LibraryFilters | "availability"; value: string; label: string }[] {
  return [
    ...availabilityOptions
      .filter((option) => option.value === availability && option.value !== "all")
      .map((option) => ({
        key: "availability" as const,
        value: option.value,
        label: t("本地视频：{0}", t(option.label)),
      })),
    ...filters.actors.map((value) => ({ key: "actors" as const, value, label: value })),
    ...filters.genres.map((value) => ({
      key: "genres" as const,
      value,
      label: t("分类：{0}", value),
    })),
    ...filters.years.map((value) => ({ key: "years" as const, value, label: t("{0} 年", value) })),
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
              label: t(options.find((option) => option.value === filters[key])!.label),
            },
          ];
    }),
  ];
}

export function LibraryFilterButton({
  filters,
  onChange,
  availability,
  onAvailabilityChange,
  resultCount,
}: {
  filters: LibraryFilters;
  onChange: (filters: LibraryFilters) => void;
  availability: NonNullable<LibraryQuery["availability"]>;
  onAvailabilityChange: (availability: NonNullable<LibraryQuery["availability"]>) => void;
  resultCount: number;
}) {
  useLocale();
  const [opened, setOpened] = useState(false);
  const count = libraryFilterLabels(filters, availability).length;
  const comboboxProps = { withinPortal: false };
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      width="min(620px, calc(100vw - 32px))"
      shadow="xl"
      radius="lg"
      trapFocus
      returnFocus
      closeOnEscape={false}
      zIndex={250}
    >
      <Popover.Target>
        <Button
          size="xs"
          variant={count || opened ? "light" : "subtle"}
          color={count || opened ? "rouge" : "gray"}
          leftSection={<Icon name="filter" size={16} />}
          aria-expanded={opened}
          aria-label={t("筛选影片")}
          onClick={() => setOpened(!opened)}
        >
          {t("筛选")}
          {count ? ` ${count}` : ""}
        </Button>
      </Popover.Target>
      <Popover.Dropdown
        p="lg"
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
        <Group justify="space-between" mb="md">
          <Text fw={600} tabIndex={-1} data-autofocus>
            {t("筛选影片")}
          </Text>
          <Anchor
            component="button"
            type="button"
            size="sm"
            disabled={!count}
            c={count ? "rouge.4" : "dimmed"}
            onClick={() => {
              onChange(emptyLibraryFilters());
              onAvailabilityChange("all");
            }}
          >
            {t("重置条件")}
          </Anchor>
        </Group>
        <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="md" verticalSpacing="sm">
          <FacetSelect
            dimension="actors"
            active={opened}
            label={t("演员")}
            placeholder={t("全部演员")}
            value={filters.actors}
            onChange={(actors) => onChange({ ...filters, actors })}
          />
          <FacetSelect
            dimension="genres"
            active={opened}
            label={t("分类")}
            placeholder={t("全部分类")}
            value={filters.genres}
            onChange={(genres) => onChange({ ...filters, genres })}
          />
          <FacetSelect
            dimension="years"
            active={opened}
            label={t("发行年份")}
            placeholder={t("全部年份")}
            value={filters.years}
            onChange={(years) => onChange({ ...filters, years })}
          />
          <FacetSelect
            dimension="qualities"
            active={opened}
            label={t("画质")}
            placeholder={t("全部画质")}
            value={filters.qualities}
            onChange={(qualities) => onChange({ ...filters, qualities })}
          />
          <Select
            label={t("影片时长")}
            data={localizeOptions(durationOptions)}
            value={filters.duration}
            comboboxProps={comboboxProps}
            allowDeselect={false}
            onChange={(duration) => onChange({ ...filters, duration: duration ?? "all" })}
          />
          <Select
            label={t("文件大小")}
            data={localizeOptions(sizeOptions)}
            value={filters.size}
            comboboxProps={comboboxProps}
            allowDeselect={false}
            onChange={(size) => onChange({ ...filters, size: size ?? "all" })}
          />
          <Select
            label={t("本地视频状态")}
            data={localizeOptions(availabilityOptions)}
            value={availability}
            comboboxProps={comboboxProps}
            allowDeselect={false}
            onChange={(value) =>
              onAvailabilityChange((value ?? "all") as NonNullable<LibraryQuery["availability"]>)
            }
          />
          <Select
            label={t("资料状态")}
            data={localizeOptions(metadataOptions)}
            value={filters.metadata}
            comboboxProps={comboboxProps}
            allowDeselect={false}
            onChange={(metadata) =>
              onChange({ ...filters, metadata: (metadata ?? "all") as LibraryFilters["metadata"] })
            }
          />
        </SimpleGrid>
        <Group justify="space-between" mt="lg">
          <Text size="sm" c="dimmed" aria-live="polite">
            {resultCount.toLocaleString(getLocale())}
            {t(" 部影片")}
          </Text>
          <Button size="xs" onClick={() => setOpened(false)}>
            {t("完成")}
          </Button>
        </Group>
      </Popover.Dropdown>
    </Popover>
  );
}

function FacetSelect({
  dimension,
  active,
  label,
  placeholder,
  value,
  onChange,
}: {
  dimension: FacetDimension;
  active: boolean;
  label: string;
  placeholder: string;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  useLocale();
  const { library, libraryState } = useWorkspace();
  const [search, setSearch] = useState("");
  const [query] = useDebouncedValue(search.trim(), 180);
  const [view] = useState(() => library.createFacetQuery());
  const state = usePagedQuery(library, view, { dimension, query }, active && libraryState.ready);
  const data = [...new Set([...value, ...Array.from(state.items.values(), (item) => item.name)])];
  return (
    <MultiSelect
      label={t(label)}
      placeholder={t(placeholder)}
      value={value}
      onChange={onChange}
      data={data}
      searchable
      clearable
      searchValue={search}
      onSearchChange={setSearch}
      comboboxProps={{ withinPortal: false }}
      limit={50}
      description={state.total > 50 ? t("输入关键词查找更多") : undefined}
      nothingFoundMessage={state.loading ? t("正在查找…") : t("没有匹配的条目")}
      error={
        state.error ? (
          <Button size="compact-xs" variant="subtle" color="red" onClick={view.retry}>
            {t("读取失败，点击重试")}
          </Button>
        ) : undefined
      }
    />
  );
}
