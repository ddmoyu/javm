import { useSyncExternalStore } from "react";
import { Alert, Switch, Text } from "@mantine/core";
import { useWorkspace } from "../../app/state";
import { SettingCard, SettingRow } from "./SettingsPrimitives";

export function BackgroundSettingsPanel() {
  const { backgroundSettings } = useWorkspace();
  const current = useSyncExternalStore(
    backgroundSettings.subscribe,
    backgroundSettings.getSnapshot,
  );
  return (
    <SettingCard title="后台运行" icon="cpu">
      <SettingRow
        title="关闭窗口后留在托盘"
        hint="开启后，关闭主窗口时任务继续运行；关闭此项后，关闭主窗口会停止所有任务并退出软件。"
      >
        <Switch
          aria-label="关闭窗口后留在托盘"
          checked={current.runInBackground}
          disabled={!current.available || !current.ready || current.saving}
          onChange={(event) => {
            void backgroundSettings.setRunInBackground(event.currentTarget.checked).catch(() => {});
          }}
        />
      </SettingRow>
      <Text component="output" display="block" size="xs" c="dimmed" py="sm">
        {!current.available
          ? "请在桌面端设置后台运行。"
          : !current.ready
            ? "正在读取设置…"
            : current.saving
              ? "正在保存…"
              : "修改后自动保存，即时生效；通过托盘菜单可随时退出。"}
      </Text>
      {current.error && <Alert color="red">{current.error}</Alert>}
    </SettingCard>
  );
}
