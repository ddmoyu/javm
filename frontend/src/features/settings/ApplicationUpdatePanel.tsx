import { useSyncExternalStore } from "react";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { useWorkspace } from "../../app/state";
import { createApplicationUpdater } from "../../platform/neutralino/applicationUpdates";
import { openExternalLink } from "../../platform/neutralino/externalLinks";
export function ApplicationUpdatePanel() {
  const { runtime, network, notice } = useWorkspace(),
    service = createApplicationUpdater(runtime, network),
    state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">
        检查 JAVM 官方发布，找到兼容的离线包后可前往下载并手动升级。
      </Text>
      {state.error && <Alert color="red">{state.error}</Alert>}
      {state.checked && !state.error && !state.release && (
        <Text size="sm">暂无更高版本的正式发布。</Text>
      )}
      <Group>
        <Button
          size="xs"
          variant="default"
          disabled={!state.available}
          loading={state.busy}
          onClick={() => void service.check()}
        >
          检查更新
        </Button>
        {state.release && (
          <Button
            size="xs"
            onClick={() =>
              void openExternalLink(state.release!.url).catch((e) =>
                notice(e instanceof Error ? e.message : "无法打开发布页面"),
              )
            }
          >
            前往下载 {state.release.version}
          </Button>
        )}
      </Group>
    </Stack>
  );
}
