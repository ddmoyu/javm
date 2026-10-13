import { useState, useSyncExternalStore } from "react";
import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useWorkspace } from "../../app/state";
import { systemIntegration } from "../../platform/neutralino/systemIntegration";
import { SettingCard } from "./SettingsPrimitives";

export function SystemIntegrationPanel() {
  const { runtime } = useWorkspace();
  const service = systemIntegration(runtime);
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const [replace, setReplace] = useState<string>();
  return (
    <SettingCard title="系统链接" icon="link">
      <Stack gap="sm">
        <Text size="sm">
          让浏览器中的 javm:// 链接打开此份 JAVM。移动便携版目录后，请在新位置重新注册。
        </Text>
        <Text component="output" size="xs" c="dimmed" aria-live="polite">
          {!state.available
            ? "请在桌面版中设置。"
            : state.result?.state === "current"
              ? "已关联到当前程序"
              : state.result?.state === "other"
                ? "当前关联到其他程序或旧位置"
                : state.result?.state === "missing"
                  ? "尚未注册"
                  : "点击检查，读取当前用户的链接设置。"}
        </Text>
        {state.result?.command && (
          <Text size="xs" style={{ overflowWrap: "anywhere" }}>
            {state.result.command}
          </Text>
        )}
        <Group>
          <Button
            variant="default"
            size="xs"
            disabled={!state.available || state.busy}
            onClick={() => void service.run("status")}
          >
            检查状态
          </Button>
          <Button
            size="xs"
            loading={state.busy}
            disabled={!state.available || !state.result || state.result.state === "current"}
            onClick={() =>
              state.result?.state === "other"
                ? setReplace(state.result.command)
                : void service.run("register")
            }
          >
            注册到此版本
          </Button>
          {state.result?.canRemove !== false && (
            <Button
              variant="subtle"
              size="xs"
              disabled={state.busy || state.result?.state !== "current"}
              onClick={() => void service.run("remove")}
            >
              解除关联
            </Button>
          )}
        </Group>
        {state.result?.state === "current" && state.result.canRemove === false && (
          <Text size="xs" c="dimmed">
            此关联由系统管理，可在系统默认应用设置中更改，或卸载此程序。
          </Text>
        )}
        {state.error && <Alert color="red">{state.error}</Alert>}
        <Modal
          opened={replace !== undefined}
          onClose={() => setReplace(undefined)}
          title="替换现有链接关联"
          centered
        >
          <Stack>
            <Text size="sm">之后 javm:// 链接将打开当前这份 JAVM。原程序和片库文件均保留。</Text>
            <Text size="xs" style={{ overflowWrap: "anywhere" }}>
              {replace}
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setReplace(undefined)}>
                取消
              </Button>
              <Button
                onClick={() => {
                  void service.run("register", replace);
                  setReplace(undefined);
                }}
              >
                确认替换
              </Button>
            </Group>
          </Stack>
        </Modal>
      </Stack>
    </SettingCard>
  );
}
