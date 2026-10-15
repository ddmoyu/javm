import { useState, useSyncExternalStore } from "react";
import { Alert, Button, Checkbox, NumberInput, Stack, Text } from "@mantine/core";
import { useWorkspace } from "../../app/state";
import type {
  MetadataPipeline,
  MetadataPipelineSettings,
} from "../../services/scraping/MetadataPipeline";
import { SettingCard } from "./SettingsPrimitives";
import { publicMessage } from "../../services/publicMessage";
export function MetadataPipelinePanel({ service }: { service: MetadataPipeline }) {
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
    <SettingCard title="资料补全与重试" icon="layers">
      <Stack gap="sm">
        <Checkbox
          checked={draft.fusion}
          disabled={busy}
          label="自动补全缺失资料"
          onChange={(e) => patch({ fusion: e.currentTarget.checked })}
        />
        <Text size="xs" c="dimmed">
          仅采用番号一致的查询结果补全空字段，保留已有资料和人工修改。
        </Text>
        <NumberInput
          label="网络失败重试次数"
          min={0}
          max={3}
          value={draft.retries}
          disabled={busy}
          onChange={(v) => patch({ retries: Number(v) })}
        />
        {(error || state.error) && <Alert color="red">{publicMessage(error || state.error)}</Alert>}
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
          保存资料设置
        </Button>
      </Stack>
    </SettingCard>
  );
}
