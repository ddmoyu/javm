import { t, useLocale } from "../../i18n/index";
import { useSyncExternalStore } from "react";
import { Button } from "@mantine/core";
import { Icon } from "../../components/icons";
import type { LegacyImportService } from "../../services/library/LegacyImportService";
import { SettingCard, SettingRow } from "./SettingsPrimitives";

export function LegacyImportSettingsPanel({ service }: { service: LegacyImportService }) {
  useLocale();
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const repair = state.operation === "repair";
  const hint = repair
    ? "核对旧库导入的发现页缓存，保留原有片库与恢复副本。"
    : state.state === "running"
      ? "旧数据正在合并，可打开引导查看进度。"
      : state.state === "completed"
        ? "旧数据已合并到当前片库，恢复副本已保留。"
        : state.state === "none"
          ? "未发现待导入的旧数据库，可以重新检查。"
          : "稍后导入或取消后，可以从这里重新开始；合并时保留新版已有资料。";
  return (
    <SettingCard title={t("旧版数据迁移")} icon="upload">
      <SettingRow title={t(repair ? "修复旧库导入" : "导入旧版片库")} hint={t(hint)}>
        <Button
          variant="default"
          size="xs"
          loading={state.checking}
          leftSection={<Icon name="upload" size={14} />}
          onClick={() => void service.open()}
        >
          {repair
            ? t("打开修复引导")
            : state.state === "running"
              ? t("查看导入进度")
              : t("打开导入引导")}
        </Button>
      </SettingRow>
    </SettingCard>
  );
}
