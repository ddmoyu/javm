import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Badge, Drawer, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import { getLocale, t, useLocale } from "../../i18n";
import { Icon } from "../../components/icons";
import type { FeedbackService } from "../../services/feedback/FeedbackService";
import type { FailureReport } from "../../services/feedback/report";
import { FeedbackDetails } from "./FeedbackDetails";
import classes from "./Feedback.module.css";

function RecordList({
  reports,
  disabled,
  lastViewedId,
  onOpen,
}: {
  reports: FailureReport[];
  disabled: boolean;
  lastViewedId: string;
  onOpen: (id: string) => void;
}) {
  const previous = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    previous.current?.focus();
  }, [lastViewedId]);
  return (
    <Stack gap="xs">
      {reports.map((report) => (
        <UnstyledButton
          key={report.id}
          ref={report.id === lastViewedId ? previous : undefined}
          className={classes.record}
          disabled={disabled}
          onClick={() => onOpen(report.id)}
          aria-label={t("查看诊断：{0}", t(report.title))}
        >
          <Group wrap="nowrap" gap="md">
            <div className={classes.recordText}>
              <Text size="sm" fw={500} lineClamp={2}>
                {t(report.title)}
              </Text>
              <Text size="xs" c="dimmed" mt={6}>
                {new Date(report.time).toLocaleString(getLocale())}
                {t(" · {0} 次", report.count)}
              </Text>
            </div>
            <Icon name="chevronRight" size={18} />
          </Group>
        </UnstyledButton>
      ))}
    </Stack>
  );
}

export function FeedbackDrawer({ service }: { service: FeedbackService }) {
  useLocale();
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const [lastViewedId, setLastViewedId] = useState("");
  const report = state.reports.find((item) => item.id === state.activeId);
  return (
    <Drawer
      opened={state.enabled && state.historyOpened}
      onClose={service.closeHistory}
      title={
        <span className={classes.title}>
          {t("诊断记录")}
          <Badge variant="light" style={{ flexShrink: 0 }}>
            {t("{0} 条", state.reports.length)}
          </Badge>
        </span>
      }
      position="right"
      size="min(680px, 100vw)"
      padding="xl"
      classNames={{ content: classes.content, header: classes.header, body: classes.body }}
    >
      {state.historyOpened &&
        (report ? (
          <FeedbackDetails key={report.id} service={service} report={report} history />
        ) : (
          <Stack gap="xl">
            <Stack gap={4}>
              <Text size="sm" c="dimmed" lh={1.6}>
                {t("最近 7 天，最多保留 8 条诊断。")}
              </Text>
              <Text size="sm" c="dimmed" lh={1.6}>
                {t("仅保存在本机，由你主动提交反馈。")}
              </Text>
            </Stack>
            {state.error && (
              <Alert color="yellow" role="alert">
                {t(state.error)}
              </Alert>
            )}
            {state.reports.length ? (
              <RecordList
                reports={state.reports}
                disabled={state.savingSettings || state.busy}
                lastViewedId={lastViewedId}
                onOpen={(id) => {
                  setLastViewedId(id);
                  service.open(id);
                }}
              />
            ) : (
              <Stack className={classes.empty} align="center" gap="sm">
                <Icon name="list" size={32} />
                <Text size="sm" fw={500}>
                  {t("暂无诊断记录")}
                </Text>
                <Text size="sm" c="dimmed">
                  {t("发生异常后，可在这里查看诊断并选择是否反馈。")}
                </Text>
              </Stack>
            )}
          </Stack>
        ))}
    </Drawer>
  );
}
