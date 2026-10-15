import { t, useLocale } from "../../i18n/index";
import { useSyncExternalStore } from "react";
import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useWorkspace } from "../../app/state";

export function DuplicateDownloadModal() {
  useLocale();
  const { downloads } = useWorkspace();
  const confirmation = useSyncExternalStore(downloads.subscribe, downloads.getConfirmation);
  if (!confirmation) return null;
  const cancel = () => downloads.resolveDuplicateConfirmation(confirmation.id, false);
  return (
    <Modal opened onClose={cancel} title={t("重复番号下载")} centered size="sm" zIndex={400}>
      <Stack gap="sm">
        <Text size="sm">{t("以下番号已有下载任务，或在本次添加中重复：")}</Text>
        <Text
          size="sm"
          fw={600}
          style={{ maxHeight: 120, overflowY: "auto", overflowWrap: "anywhere" }}
        >
          {confirmation.codes.join("、")}
        </Text>
        <Text size="sm" c="dimmed">
          {confirmation.count > 1
            ? t("仍要添加这 {0} 个下载任务吗？", confirmation.count)
            : t("仍要添加这个下载任务吗？")}
        </Text>
        <Group justify="flex-end" mt="xs">
          <Button variant="default" data-autofocus onClick={cancel}>
            {t("取消")}
          </Button>
          <Button onClick={() => downloads.resolveDuplicateConfirmation(confirmation.id, true)}>
            {t("继续添加")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
