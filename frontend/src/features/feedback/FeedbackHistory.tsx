import { useSyncExternalStore } from "react";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { useWorkspace } from "../../app/state";
import type { FeedbackService } from "../../services/feedback/FeedbackService";
import { SettingCard } from "../settings/SettingsPrimitives";

function Records({ service }: { service: FeedbackService }) {
  const { reports, error } = useSyncExternalStore(service.subscribe, service.getSnapshot);
  return (
    <Stack gap="sm">
      {error && (
        <Alert color="yellow" role="alert">
          {error}
        </Alert>
      )}
      {!reports.length && (
        <Text size="sm" c="dimmed">
          暂无问题反馈记录。
        </Text>
      )}
      {reports.map((report) => (
        <Group key={report.id} justify="space-between" wrap="nowrap">
          <div style={{ minWidth: 0 }}>
            <Text size="sm" fw={500} truncate>
              {report.title}
            </Text>
            <Text size="xs" c="dimmed">
              {new Date(report.time).toLocaleString()} · {report.count} 次
            </Text>
          </div>
          <Button size="xs" variant="light" onClick={() => service.open(report.id)}>
            查看与反馈
          </Button>
        </Group>
      ))}
    </Stack>
  );
}
export function FeedbackHistory() {
  const { feedback } = useWorkspace();
  return (
    <SettingCard title="问题反馈记录" icon="alert">
      <Text size="xs" c="dimmed" mb="sm">
        保留最近 7 天内的最多 8 份诊断。点击反馈后复制内容，由你在 GitHub 提交。
      </Text>
      {feedback ? (
        <Records service={feedback} />
      ) : (
        <Text size="sm" c="dimmed">
          诊断反馈在桌面端可用。
        </Text>
      )}
    </SettingCard>
  );
}
