import { useSyncExternalStore } from "react";
import { Alert, Button, Group, Stack, Switch, Text } from "@mantine/core";
import type { DirectoryWatchService } from "../../services/library/DirectoryWatchService";

export function DirectoryWatchControl({ service }: { service: DirectoryWatchService }) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  return (
    <Stack gap="xs">
      <Group gap="md">
        <Switch
          label="目录变化后自动扫描"
          checked={state.enabled}
          disabled={!state.ready || state.changing}
          onChange={(event) => void service.setEnabled(event.currentTarget.checked)}
        />
        {state.enabled && (
          <Text size="xs" c="dimmed">
            正在监听 {state.watching} 个目录 · 待扫描 {state.queued} 个
          </Text>
        )}
      </Group>
      {state.error && (
        <Alert color="yellow" role="alert" style={{ whiteSpace: "pre-wrap" }}>
          {state.error}
          <Button
            ml="sm"
            size="xs"
            variant="default"
            disabled={state.changing}
            onClick={() => void service.setEnabled(state.enabled)}
          >
            重试
          </Button>
        </Alert>
      )}
    </Stack>
  );
}
