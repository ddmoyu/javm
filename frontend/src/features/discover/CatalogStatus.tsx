import { useSyncExternalStore } from "react";
import { Button, Group, Loader, Text } from "@mantine/core";
import type { DiscoveryCatalogService } from "../../services/catalog/DiscoveryCatalogService";
import type { CatalogDimension } from "../../services/catalog/discoveryData";
import { publicMessage } from "../../services/publicMessage";

export function CatalogStatus({
  service,
  dimension,
}: {
  service: DiscoveryCatalogService;
  dimension: CatalogDimension;
}) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const { active, error, label } = service.status(dimension);
  const list = state.catalogs[dimension];
  const aggregated = ["directors", "studios", "labels", "series"].includes(dimension);
  const coverage = aggregated
    ? "已有影片资料与保留名单"
    : dimension === "genres"
      ? "分类目录"
      : `${label}目录`;
  const message = active
    ? state.saving
      ? "正在保存名单…"
      : `正在更新${label} ${state.completed}/${state.total}…`
    : error ||
      state.warning ||
      `${coverage} · 已收录 ${list.names.length.toLocaleString()} 项${
        list.updatedAt
          ? ` · 更新于 ${new Date(list.updatedAt).toLocaleString("zh-CN")}`
          : " · 内置快照"
      }`;
  return (
    <Group gap="xs" justify="space-between" pb="xs">
      <Group component="output" gap="xs" aria-live="polite">
        {active && <Loader size={12} />}
        <Text size="xs" c={error || state.warning ? "orange" : "dimmed"}>
          {publicMessage(message)}
        </Text>
        {!active && !error && list.coverage && (
          <Text size="xs" c="dimmed">
            数量已确认 {list.coverage.counts.toLocaleString()}/{list.names.length.toLocaleString()}{" "}
            · 显示别名 {list.coverage.labels.toLocaleString()} 项；未确认的数量保留为未知
          </Text>
        )}
      </Group>
      {state.available &&
        !["actors", "actresses", "maleActors"].includes(dimension) &&
        (active ? (
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={service.cancel}
            disabled={state.saving}
          >
            取消更新
          </Button>
        ) : (
          <Button
            size="compact-xs"
            variant="subtle"
            disabled={!!state.updating}
            onClick={() => {
              void service.refresh(dimension);
            }}
          >
            {error ? "重试更新" : aggregated ? "刷新汇总" : "更新名单"}
          </Button>
        ))}
    </Group>
  );
}
