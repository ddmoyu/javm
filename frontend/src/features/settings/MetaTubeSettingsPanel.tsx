import { useState, useSyncExternalStore } from "react";
import { Alert, Button, Group, Stack, TagsInput, Text } from "@mantine/core";
import { useWorkspace } from "../../app/state";
import type { MetaTubeSettings } from "../../services/metadata/MetaTubeService";
import { serviceError } from "../../services/metadata/shared";
import { Pill } from "../../components/ui";
import { SettingCard, SettingNote, SettingRow } from "./SettingsPrimitives";
import classes from "./Settings.module.css";

export function MetaTubeSettingsPanel() {
  const { metatube } = useWorkspace();
  const current = useSyncExternalStore(metatube.settings.subscribe, metatube.settings.getSnapshot);
  const state = useSyncExternalStore(metatube.subscribe, metatube.getSnapshot);
  const [edited, setEdited] = useState<MetaTubeSettings | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const draft = edited ?? current.value;
  const dirty = JSON.stringify(draft) !== JSON.stringify(current.value);
  const busy = working || state.busy || state.querying || current.saving || !current.ready;
  const disabled = busy;
  const patch = (value: Partial<MetaTubeSettings>) => {
    setEdited({ ...draft, ...value });
    setError("");
    setMessage("");
  };
  const perform = async (action: () => Promise<unknown>, message: string) => {
    setWorking(true);
    setError("");
    setMessage("");
    try {
      await action();
      setMessage(message);
    } catch (reason) {
      setError(serviceError(reason));
    } finally {
      setWorking(false);
    }
  };
  const status = { stopped: "待使用", starting: "启动中", ready: "运行中", failed: "需要处理" }[
    state.status
  ];
  return (
    <Stack gap="lg">
      {!current.available && <SettingNote>请在 Windows 桌面端配置和管理 MetaTube。</SettingNote>}
      <SettingCard title="MetaTube" icon="radar" extra={<Pill>{status}</Pill>}>
        <SettingRow title="内置版本" hint="随 JAVM 提供和更新，无需单独下载安装。">
          <Text size="sm">
            {state.version ||
              (!current.available ? "桌面端可用" : state.bundleChecked ? "组件缺失" : "检查中…")}
          </Text>
        </SettingRow>
        <Stack className={classes.fields} gap="md">
          <TagsInput
            label="影片资料来源"
            description="留空查询服务支持的全部来源；填入 MetaTube 的来源名称。"
            data={state.providers}
            value={draft.providers}
            disabled={disabled}
            onChange={(providers) => patch({ providers })}
          />
        </Stack>
        {state.status === "ready" && (
          <Text size="xs" c="dimmed" className={classes.fields}>
            可用影片来源：{state.providers.join("、") || "无"}
          </Text>
        )}
      </SettingCard>
      {state.busy && (
        <Text size="sm" component="output" aria-live="polite">
          {state.progress}…
        </Text>
      )}
      {(error || current.error || state.error) && (
        <Alert color="red" role="alert">
          {error || current.error || state.error}
        </Alert>
      )}
      {message && (
        <Alert color="green">
          <output>{message}</output>
        </Alert>
      )}
      <div className={classes.saveBar}>
        <Text size="xs" c="dimmed">
          {dirty ? "有未保存的修改" : "修改后点击保存"}
        </Text>
        <Group gap="xs">
          <Button
            variant="default"
            disabled={!dirty || disabled}
            onClick={() => {
              setEdited(null);
              setError("");
              setMessage("");
            }}
          >
            撤销修改
          </Button>
          <Button
            disabled={!current.available || disabled || (!dirty && !current.error)}
            loading={current.saving}
            onClick={() =>
              void perform(async () => {
                await metatube.save(draft);
                setEdited(null);
              }, "MetaTube 配置已保存。")
            }
          >
            保存 MetaTube 设置
          </Button>
        </Group>
      </div>
      <SettingNote>
        首次查询资料时自动启动内置服务，启动后持续运行，退出 JAVM
        时停止。关闭窗口到托盘不会停止服务。
      </SettingNote>
    </Stack>
  );
}
