import { useSyncExternalStore } from "react";
import { Badge, Button, Group, Popover, Stack, Switch, Text, Tooltip } from "@mantine/core";
import type { DirectoryWatchService } from "../../services/library/DirectoryWatchService";

export function DirectoryWatchControl({ service }: { service: DirectoryWatchService }) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  return (
    <Group gap="xs" wrap="nowrap">
      <Tooltip
        multiline
        w={240}
        label={
          state.enabled
            ? `目录变化后自动扫描。正在监听 ${state.watching} 个目录，待扫描 ${state.queued} 个。`
            : "目录内的文件变化后，自动进行增量扫描。"
        }
      >
        <Switch
          label="自动扫描"
          size="xs"
          checked={state.enabled}
          disabled={!state.ready || state.changing}
          onChange={(event) => void service.setEnabled(event.currentTarget.checked)}
        />
      </Tooltip>
      {state.enabled && state.queued > 0 && (
        <Badge size="sm" variant="light" color="gray">
          {state.queued} 待扫描
        </Badge>
      )}
      {state.error && (
        <Popover width={320} position="bottom-end" withArrow shadow="md">
          <Popover.Target>
            <Button size="compact-xs" color="yellow" autoContrast>
              监听异常
            </Button>
          </Popover.Target>
          <Popover.Dropdown>
            <Stack gap="xs">
              <Text
                size="xs"
                role="alert"
                style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
              >
                {state.error}
              </Text>
              <Button
                size="xs"
                variant="default"
                disabled={state.changing}
                onClick={() => void service.setEnabled(state.enabled)}
              >
                重试
              </Button>
            </Stack>
          </Popover.Dropdown>
        </Popover>
      )}
    </Group>
  );
}
