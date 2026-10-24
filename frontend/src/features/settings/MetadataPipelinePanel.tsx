import { t, useLocale } from "../../i18n/index";
import { useState, useSyncExternalStore } from "react";
import { Alert, Button, Checkbox, Group, NumberInput } from "@mantine/core";
import { useWorkspace } from "../../app/state";
import type {
  MetadataPipeline,
  MetadataPipelineSettings,
} from "../../services/scraping/MetadataPipeline";
import { SettingCard, SettingFields, SettingRow } from "./SettingsPrimitives";
import { publicMessage } from "../../services/publicMessage";
export function MetadataPipelinePanel({ service }: { service: MetadataPipeline }) {
  useLocale();
  const { notice } = useWorkspace();
  const state = useSyncExternalStore(service.settings.subscribe, service.settings.getSnapshot);
  const [edited, setEdited] = useState<MetadataPipelineSettings | null>(null),
    [error, setError] = useState("");
  const draft = edited ?? state.value,
    busy = !state.ready || state.saving || !state.available;
  const patch = (value: Partial<MetadataPipelineSettings>) => {
    setEdited({ ...draft, ...value });
  };
  return (
    <SettingCard title={t("资料补全与重试")} icon="layers">
      <SettingRow
        title={t("自动补全缺失资料")}
        hint={t("仅采用番号一致的查询结果补全空字段，保留已有资料和人工修改。")}
      >
        <Checkbox
          checked={draft.fusion}
          disabled={busy}
          aria-label={t("自动补全缺失资料")}
          onChange={(e) => patch({ fusion: e.currentTarget.checked })}
        />
      </SettingRow>
      <SettingRow title={t("网络失败重试次数")}>
        <NumberInput
          aria-label={t("网络失败重试次数")}
          min={0}
          max={3}
          value={draft.retries}
          disabled={busy}
          w={100}
          onChange={(v) => patch({ retries: Number(v) })}
        />
      </SettingRow>
      <SettingFields>
        {(error || state.error) && (
          <Alert color="red">{t(publicMessage(error || state.error))}</Alert>
        )}
        <Group justify="flex-end">
          <Button
            disabled={busy || !edited}
            loading={state.saving}
            onClick={() => {
              setError("");
              void service.settings.save(draft).then(
                () => {
                  setEdited(null);
                  notice("资料设置已保存。");
                },
                (e) => setError(e instanceof Error ? e.message : "保存失败"),
              );
            }}
          >
            {t("保存资料设置")}
          </Button>
        </Group>
      </SettingFields>
    </SettingCard>
  );
}
