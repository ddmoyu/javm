import { getLocale, t, useLocale } from "../../i18n/index";
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
  useLocale();
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const { active, error, label } = service.status(dimension);
  const list = state.catalogs[dimension];
  const aggregated = ["directors", "studios", "labels", "series"].includes(dimension);
  const coverage = aggregated
    ? "已有影片资料与保留名单"
    : dimension === "genres"
      ? "分类目录"
      : t("{0}目录", t(label));
  const message = active
    ? state.saving
      ? "正在保存名单…"
      : t("正在更新{0} {1}/{2}…", t(label), state.completed, state.total)
    : error ||
      state.warning ||
      t(
        "{0} · 已收录 {1} 项{2}",
        t(coverage),
        list.names.length.toLocaleString(getLocale()),
        list.updatedAt
          ? t(" · 更新于 {0}", new Date(list.updatedAt).toLocaleString(getLocale()))
          : t(" · 内置快照"),
      );
  return (
    <Group gap="xs" justify="space-between" pb="xs">
      <Group component="output" gap="xs" aria-live="polite">
        {active && <Loader size={12} />}
        <Text size="xs" c={error || state.warning ? "orange" : "dimmed"}>
          {t(publicMessage(message))}
        </Text>
        {!active && !error && list.coverage && (
          <Text size="xs" c="dimmed">
            {t("数量已确认 ")}
            {list.coverage.counts.toLocaleString(getLocale())}/
            {list.names.length.toLocaleString(getLocale())}
            {t(" · 显示别名 ")}
            {list.coverage.labels.toLocaleString(getLocale())}
            {t(" 项；未确认的数量保留为未知")}
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
            {t("取消更新")}
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
            {error ? t("重试更新") : aggregated ? t("刷新汇总") : t("更新名单")}
          </Button>
        ))}
    </Group>
  );
}
