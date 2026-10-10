import { useSyncExternalStore } from "react";
import { Button, Group, Loader, Text } from "@mantine/core";
import type { DiscoveryCatalogService } from "../../services/catalog/DiscoveryCatalogService";
import type { CatalogDimension } from "../../services/catalog/discoveryData";
import { isAvwikiDimension } from "../../services/catalog/avwikiCsv";

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
  const directory = isAvwikiDimension(dimension);
  const source = directory ? "AVWikiDB" : "JavBus";
  const coverage = dimension === "genres" ? "中文分类" : directory ? `${label}目录` : "增量名单";
  const message = active
    ? state.saving
      ? "正在保存名单…"
      : `正在更新${label} ${state.completed}/${state.total}…`
    : error ||
      state.warning ||
      `${source} ${coverage} · 已收录 ${list.names.length.toLocaleString()} 项${
        list.updatedAt
          ? ` · 更新于 ${new Date(list.updatedAt).toLocaleString("zh-CN")}`
          : " · 内置快照"
      }`;
  return (
    <Group gap="xs" justify="space-between" pb="xs">
      <Group component="output" gap="xs" aria-live="polite">
        {active && <Loader size={12} />}
        <Text size="xs" c={error || state.warning ? "orange" : "dimmed"}>
          {message}
        </Text>
      </Group>
      {state.available &&
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
            {error ? "重试更新" : "更新名单"}
          </Button>
        ))}
    </Group>
  );
}
