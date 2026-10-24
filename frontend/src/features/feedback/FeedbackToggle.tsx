import { useSyncExternalStore } from "react";
import { Alert, Stack, Switch, Text } from "@mantine/core";
import { t, useLocale } from "../../i18n";
import type { FeedbackService } from "../../services/feedback/FeedbackService";

export function FeedbackToggle({ service }: { service: FeedbackService }) {
  useLocale();
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  return (
    <Stack gap="xs">
      <Switch
        label={t("启用问题反馈")}
        description={t("关闭后不再弹出反馈弹框，也不记录崩溃或异常退出；可在设置中重新开启。")}
        checked={state.enabled}
        disabled={!state.settingsReady || state.savingSettings || state.busy}
        onChange={(event) => {
          void service.setEnabled(event.currentTarget.checked).catch(() => {});
        }}
      />
      {(!state.settingsReady || state.savingSettings) && (
        <Text component="output" size="xs" c="dimmed" aria-live="polite">
          {t(state.savingSettings ? "正在保存…" : "正在读取设置…")}
        </Text>
      )}
      {state.settingsError && (
        <Alert color="red" role="alert">
          {t(state.settingsError)}
        </Alert>
      )}
    </Stack>
  );
}
