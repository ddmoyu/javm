import { t, useLocale } from "../../i18n/index";
import { useSyncExternalStore } from "react";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { useWorkspace } from "../../app/state";
import type { FeedbackService } from "../../services/feedback/FeedbackService";
import { SettingCard, SettingFields } from "../settings/SettingsPrimitives";
import { FeedbackToggle } from "./FeedbackToggle";
import { Icon } from "../../components/icons";

function Summary({ service }: { service: FeedbackService }) {
  useLocale();
  const { reports, error, enabled, settingsReady, savingSettings } = useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
  );
  return (
    <Stack gap="sm">
      <FeedbackToggle service={service} />
      {!enabled && settingsReady && (
        <Text size="sm" c="dimmed">
          {t("问题反馈已关闭；已保存的记录会保留，重新开启后可查看。")}
        </Text>
      )}
      {enabled && error && (
        <Alert color="yellow" role="alert">
          {t(error)}
        </Alert>
      )}
      <Group justify="space-between" gap="md" mt="xs">
        <div>
          <Text size="sm" fw={500}>
            {t("诊断记录")}
          </Text>
          {enabled && (
            <Text size="xs" c="dimmed" mt={4}>
              {t("已保存 {0} 条 · 最近 7 天", reports.length)}
            </Text>
          )}
        </div>
        <Button
          size="xs"
          variant="light"
          rightSection={<Icon name="chevronRight" size={15} />}
          aria-haspopup="dialog"
          disabled={!enabled || !settingsReady || savingSettings}
          onClick={service.openHistory}
        >
          {t("查看记录")}
        </Button>
      </Group>
    </Stack>
  );
}
export function FeedbackHistory() {
  useLocale();
  const { feedback } = useWorkspace();
  return (
    <SettingCard title={t("诊断与反馈")} icon="alert">
      <SettingFields>
        {feedback ? (
          <Summary service={feedback} />
        ) : (
          <Text size="sm" c="dimmed">
            {t("诊断反馈在桌面端可用。")}
          </Text>
        )}
      </SettingFields>
    </SettingCard>
  );
}
