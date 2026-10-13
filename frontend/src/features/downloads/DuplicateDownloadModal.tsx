import { useSyncExternalStore } from "react";
import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useWorkspace } from "../../app/state";

export function DuplicateDownloadModal() {
  const { downloads } = useWorkspace();
  const confirmation = useSyncExternalStore(downloads.subscribe, downloads.getConfirmation);
  if (!confirmation) return null;
  const cancel = () => downloads.resolveDuplicateConfirmation(confirmation.id, false);
  return (
    <Modal opened onClose={cancel} title="重复番号下载" centered size="sm" zIndex={400}>
      <Stack gap="sm">
        <Text size="sm">以下番号已有下载任务，或在本次添加中重复：</Text>
        <Text
          size="sm"
          fw={600}
          style={{ maxHeight: 120, overflowY: "auto", overflowWrap: "anywhere" }}
        >
          {confirmation.codes.join("、")}
        </Text>
        <Text size="sm" c="dimmed">
          仍要添加{confirmation.count > 1 ? `这 ${confirmation.count} 个` : "这个"}下载任务吗？
        </Text>
        <Group justify="flex-end" mt="xs">
          <Button variant="default" data-autofocus onClick={cancel}>
            取消
          </Button>
          <Button onClick={() => downloads.resolveDuplicateConfirmation(confirmation.id, true)}>
            继续添加
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
