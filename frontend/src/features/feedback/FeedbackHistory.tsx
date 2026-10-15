import { getLocale, t, useLocale } from "../../i18n/index";
import { useSyncExternalStore } from "react";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { useWorkspace } from "../../app/state";
import type { FeedbackService } from "../../services/feedback/FeedbackService";
import { SettingCard } from "../settings/SettingsPrimitives";

function Records({ service }: { service: FeedbackService }) {
  useLocale();
  const { reports, error } = useSyncExternalStore(service.subscribe, service.getSnapshot);
  return (
    <Stack gap="sm">
      {error && (
        <Alert color="yellow" role="alert">
          {t(error)}
        </Alert>
      )}
      {!reports.length && (
        <Text size="sm" c="dimmed">
          {t("暂无问题反馈记录。")}
        </Text>
      )}
      {reports.map((report) => (
        <Group key={report.id} justify="space-between" wrap="nowrap">
          <div style={{ minWidth: 0 }}>
            <Text size="sm" fw={500} truncate>
              {report.title}
            </Text>
            <Text size="xs" c="dimmed">
              {new Date(report.time).toLocaleString(getLocale())}
              {t(" · {0} 次", report.count)}
            </Text>
          </div>
          <Button size="xs" variant="light" onClick={() => service.open(report.id)}>
            {t("查看与反馈")}
          </Button>
        </Group>
      ))}
    </Stack>
  );
}
export function FeedbackHistory() {
  useLocale();
  const { feedback } = useWorkspace();
  return (
    <SettingCard title={t("问题反馈记录")} icon="alert">
      <Text size="xs" c="dimmed" mb="sm">
        {t("保留最近 7 天内的最多 8 份诊断。点击反馈后复制内容，由你在 GitHub 提交。")}
      </Text>
      {feedback ? (
        <Records service={feedback} />
      ) : (
        <Text size="sm" c="dimmed">
          {t("诊断反馈在桌面端可用。")}
        </Text>
      )}
    </SettingCard>
  );
}
