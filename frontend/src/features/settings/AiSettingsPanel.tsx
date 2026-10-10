import { useState, useSyncExternalStore } from "react";
import { Alert, Button, Group, PasswordInput, Stack, Switch, Text, TextInput } from "@mantine/core";
import { useWorkspace } from "../../app/state";
import type { AiSettings } from "../../services/metadata/AiService";
import { serviceError } from "../../services/metadata/shared";
import { SettingCard, SettingNote, SettingRow } from "./SettingsPrimitives";
import classes from "./Settings.module.css";

export function AiSettingsPanel() {
  const { ai } = useWorkspace();
  const current = useSyncExternalStore(ai.settings.subscribe, ai.settings.getSnapshot);
  const task = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const [edited, setEdited] = useState<AiSettings | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const draft = edited ?? current.value;
  const dirty = JSON.stringify(draft) !== JSON.stringify(current.value);
  const busy = !current.ready || current.saving || task.busy;
  const patch = (value: Partial<AiSettings>) => {
    setEdited({ ...draft, ...value });
    setError("");
    setMessage("");
  };
  const perform = async (test: boolean) => {
    setError("");
    setMessage("");
    try {
      if (test) {
        await ai.test(draft);
        setMessage("连接成功，模型已正确响应测试。" + (dirty ? "当前修改尚未保存。" : ""));
      } else {
        await ai.settings.save(draft);
        setEdited(null);
        setMessage("AI 配置已保存。");
      }
    } catch (reason) {
      setError(serviceError(reason));
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void perform(false);
      }}
    >
      <Stack gap="lg">
        {!current.available && (
          <SettingNote>请在 Windows 桌面端保存配置和使用 AI 服务。</SettingNote>
        )}
        <SettingCard title="辅助识别与翻译" icon="sparkles">
          <SettingRow
            title="启用 AI 辅助"
            hint="在影片编辑中识别番号、翻译标题与简介，结果由你确认。"
          >
            <Switch
              aria-label="启用 AI 辅助"
              checked={draft.enabled}
              disabled={busy}
              onChange={(event) => patch({ enabled: event.currentTarget.checked })}
            />
          </SettingRow>
        </SettingCard>
        <SettingCard title="服务配置" icon="key">
          <Stack className={classes.fields} gap="md">
            <TextInput
              label="服务地址"
              description="OpenAI 兼容的 API 基础地址，通常以 /v1 结尾。"
              value={draft.endpoint}
              disabled={busy}
              onChange={(event) => patch({ endpoint: event.currentTarget.value })}
            />
            <TextInput
              label="模型名称"
              placeholder="填写服务提供的模型标识"
              value={draft.model}
              disabled={busy}
              onChange={(event) => patch({ model: event.currentTarget.value })}
            />
            <PasswordInput
              label="API Key"
              description="本机加密保存；无鉴权的本地模型可留空。"
              value={draft.apiKey}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => patch({ apiKey: event.currentTarget.value })}
            />
            <Group justify="space-between">
              <Text size="xs" c="dimmed">
                连接测试会发送一条简短请求。
              </Text>
              <Button
                variant="default"
                disabled={!current.available || busy || !draft.model.trim()}
                loading={task.busy && task.action === "测试连接"}
                onClick={() => void perform(true)}
              >
                测试连接
              </Button>
            </Group>
          </Stack>
        </SettingCard>
        <SettingNote>
          识别仅发送文件名和标题，翻译仅发送标题和简介；不会自动上传视频或图片。
        </SettingNote>
        {task.busy && (
          <Group>
            <Text size="sm">{task.action}…</Text>
            <Button variant="subtle" size="xs" onClick={ai.cancel}>
              取消请求
            </Button>
          </Group>
        )}
        {(error || current.error) && (
          <Alert color="red" role="alert">
            {error || current.error}
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
              disabled={!dirty || busy}
              onClick={() => {
                setEdited(null);
                setError("");
                setMessage("");
              }}
            >
              撤销修改
            </Button>
            <Button
              type="submit"
              loading={current.saving}
              disabled={!current.available || busy || (!dirty && !current.error)}
            >
              保存 AI 设置
            </Button>
          </Group>
        </div>
      </Stack>
    </form>
  );
}
