import { useState, useSyncExternalStore } from "react";
import { Alert, Button, Checkbox, NumberInput, Stack, Text } from "@mantine/core";
import type {
  MetadataPipeline,
  MetadataPipelineSettings,
} from "../../services/scraping/MetadataPipeline";
import { SettingCard } from "./SettingsPrimitives";
export function MetadataPipelinePanel({ service }: { service: MetadataPipeline }) {
  const state = useSyncExternalStore(service.settings.subscribe, service.settings.getSnapshot);
  const [edited, setEdited] = useState<MetadataPipelineSettings | null>(null),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const draft = edited ?? state.value,
    busy = !state.ready || state.saving || !state.available;
  const patch = (value: Partial<MetadataPipelineSettings>) => {
    setEdited({ ...draft, ...value });
    setSaved(false);
  };
  return (
    <SettingCard title="资料补全与重试" icon="layers">
      <Stack gap="sm">
        <Checkbox
          checked={draft.fusion}
          disabled={busy}
          label="使用其他 MetaTube 来源补全缺失资料"
          onChange={(e) => patch({ fusion: e.currentTarget.checked })}
        />
        <Text size="xs" c="dimmed">
          以选中的来源为准。仅从最多两个番号一致的来源补空字段，已有资料和人工修改保留。
        </Text>
        <NumberInput
          label="网络失败重试次数"
          min={0}
          max={3}
          value={draft.retries}
          disabled={busy}
          onChange={(v) => patch({ retries: Number(v) })}
        />
        {(error || state.error) && <Alert color="red">{error || state.error}</Alert>}
        {saved && <Text size="sm">设置已保存</Text>}
        <Button
          disabled={busy || !edited}
          loading={state.saving}
          onClick={() => {
            setError("");
            void service.settings.save(draft).then(
              () => {
                setEdited(null);
                setSaved(true);
              },
              (e) => setError(e instanceof Error ? e.message : "保存失败"),
            );
          }}
        >
          保存资料设置
        </Button>
      </Stack>
    </SettingCard>
  );
}
