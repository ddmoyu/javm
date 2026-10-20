import { t, useLocale } from "../../i18n/index";
import { useState, useSyncExternalStore } from "react";
import {
  Alert,
  Button,
  Group,
  Paper,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { useWorkspace } from "../../app/state";
import { aiProviders } from "../../services/metadata/AiService";
import {
  applyAiPreset,
  minimaxPreset,
  MINIMAX_MODELS,
  MINIMAX_PRESETS,
} from "../../services/metadata/aiPresets";
import type { AiProvider, AiSettings } from "../../services/metadata/AiService";
import { serviceError } from "../../services/metadata/shared";
import { SettingCard, SettingNote, SettingRow } from "./SettingsPrimitives";
import classes from "./Settings.module.css";

export function AiSettingsPanel() {
  useLocale();
  const { ai, notice } = useWorkspace();
  const current = useSyncExternalStore(ai.settings.subscribe, ai.settings.getSnapshot);
  const task = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const [edited, setEdited] = useState<AiSettings | null>(null);
  const [error, setError] = useState("");
  const draft = edited ?? current.value;
  const providers = aiProviders(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(current.value);
  const busy = !current.ready || current.saving || task.busy;
  const patch = (value: Partial<AiSettings>) => {
    setEdited({ ...draft, ...value });
    setError("");
  };
  const changeProviders = (value: AiProvider[]) => {
    const first = value[0]!;
    patch({ providers: value, endpoint: first.endpoint, model: first.model, apiKey: first.apiKey });
  };
  const editProvider = (id: string, value: Partial<AiProvider>) =>
    changeProviders(
      providers.map((provider) => (provider.id === id ? { ...provider, ...value } : provider)),
    );
  const reorder = (index: number, offset: number) => {
    const value = [...providers];
    [value[index], value[index + offset]] = [value[index + offset]!, value[index]!];
    changeProviders(value);
  };
  const perform = async (test: boolean, providerId?: string) => {
    setError("");
    try {
      if (test) {
        await ai.test(draft, providerId);
        notice("连接成功，模型已正确响应测试。" + (dirty ? "当前修改尚未保存。" : ""));
      } else {
        await ai.settings.save(draft);
        setEdited(null);
        notice("AI 配置已保存。");
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
        {!current.available && <SettingNote>{t("请在桌面端保存配置和使用 AI 服务。")}</SettingNote>}
        <SettingCard title={t("辅助识别与翻译")} icon="sparkles">
          <SettingRow
            title={t("启用 AI 辅助")}
            hint={t("在影片编辑中识别番号、翻译标题与简介，结果由你确认。")}
          >
            <Switch
              aria-label={t("启用 AI 辅助")}
              checked={draft.enabled}
              disabled={busy}
              onChange={(event) => patch({ enabled: event.currentTarget.checked })}
            />
          </SettingRow>
          <SettingRow
            title={t("批量刮削自动识别")}
            hint={t(
              "规则无法识别时，将文件名和标题发送给下方启用的服务。只有查询结果返回相同番号时才保存资料。",
            )}
          >
            <Switch
              aria-label={t("批量刮削自动识别")}
              checked={draft.automaticRecognition ?? false}
              disabled={busy || !draft.enabled}
              onChange={(event) => patch({ automaticRecognition: event.currentTarget.checked })}
            />
          </SettingRow>
        </SettingCard>
        <SettingCard title={t("服务顺序")} icon="key">
          <Stack className={classes.fields} gap="md">
            <Text size="xs" c="dimmed">
              {t("按从上到下的顺序请求，失败后使用下一项。最多 5 项，每次请求总时限为 90 秒。")}
            </Text>
            {providers.map((provider, index) => (
              <Paper key={provider.id} withBorder p="md" radius="md">
                <Stack gap="sm">
                  <Group justify="space-between">
                    <Text fw={600} size="sm">
                      {index + 1}. {provider.name}
                    </Text>
                    <Switch
                      aria-label={t("启用 {0}", provider.name)}
                      checked={provider.enabled}
                      disabled={busy}
                      onChange={(event) =>
                        editProvider(provider.id, { enabled: event.currentTarget.checked })
                      }
                    />
                  </Group>
                  <Select
                    label="Apply provider preset"
                    placeholder="Custom / saved configuration"
                    value={null}
                    disabled={busy}
                    data={MINIMAX_PRESETS.map((preset) => ({
                      value: preset.id,
                      label: preset.name,
                    }))}
                    onChange={(value) => value && editProvider(provider.id, applyAiPreset(value))}
                  />
                  <Select
                    label="API protocol"
                    value={provider.protocol ?? "openai"}
                    disabled={busy}
                    data={[
                      { value: "openai", label: "Chat Completions" },
                      { value: "anthropic", label: "Messages" },
                    ]}
                    onChange={(value) => {
                      if (value === "openai" || value === "anthropic")
                        editProvider(provider.id, { protocol: value });
                    }}
                  />
                  <TextInput
                    label={t("服务名称")}
                    value={provider.name}
                    disabled={busy}
                    maxLength={80}
                    onChange={(event) =>
                      editProvider(provider.id, { name: event.currentTarget.value })
                    }
                  />
                  <TextInput
                    label={t("服务地址")}
                    description={
                      provider.protocol === "anthropic"
                        ? "Messages API base URL, including /v1."
                        : t("OpenAI 兼容的 API 基础地址，通常以 /v1 结尾。")
                    }
                    value={provider.endpoint}
                    disabled={busy}
                    onChange={(event) =>
                      editProvider(provider.id, { endpoint: event.currentTarget.value })
                    }
                  />
                  <TextInput
                    label={t("模型名称")}
                    placeholder={t("填写服务提供的模型标识")}
                    list={
                      minimaxPreset(provider.endpoint) ? `minimax-models-${provider.id}` : undefined
                    }
                    value={provider.model}
                    disabled={busy}
                    onChange={(event) =>
                      editProvider(provider.id, { model: event.currentTarget.value })
                    }
                  />
                  {minimaxPreset(provider.endpoint) && (
                    <datalist id={`minimax-models-${provider.id}`}>
                      {MINIMAX_MODELS.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </datalist>
                  )}
                  <PasswordInput
                    label="API Key"
                    description={t("本机加密保存；无鉴权的本地模型可留空。")}
                    value={provider.apiKey}
                    autoComplete="off"
                    disabled={busy}
                    onChange={(event) =>
                      editProvider(provider.id, { apiKey: event.currentTarget.value })
                    }
                  />
                  <Group justify="space-between">
                    <Group gap="xs">
                      <Button
                        size="xs"
                        variant="subtle"
                        disabled={busy || index === 0}
                        onClick={() => reorder(index, -1)}
                      >
                        {t("上移")}
                      </Button>
                      <Button
                        size="xs"
                        variant="subtle"
                        disabled={busy || index === providers.length - 1}
                        onClick={() => reorder(index, 1)}
                      >
                        {t("下移")}
                      </Button>
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        disabled={busy || providers.length === 1}
                        onClick={() =>
                          changeProviders(providers.filter((item) => item.id !== provider.id))
                        }
                      >
                        {t("移除")}
                      </Button>
                    </Group>
                    <Button
                      variant="default"
                      size="xs"
                      disabled={!current.available || busy || !provider.model.trim()}
                      loading={
                        task.busy && task.action === "测试连接" && task.provider === provider.name
                      }
                      onClick={() => void perform(true, provider.id)}
                    >
                      {t("测试连接")}
                    </Button>
                  </Group>
                </Stack>
              </Paper>
            ))}
            <Button
              variant="default"
              disabled={busy || providers.length >= 5}
              onClick={() =>
                changeProviders([
                  ...providers,
                  {
                    id: crypto.randomUUID(),
                    name: `备用服务 ${providers.length}`,
                    enabled: false,
                    endpoint: "https://api.openai.com/v1",
                    model: "",
                    apiKey: "",
                  },
                ])
              }
            >
              {t("添加供应商")}
            </Button>
          </Stack>
        </SettingCard>
        <SettingNote>
          {t("识别仅发送文件名和标题，翻译仅发送标题和简介；不会自动上传视频或图片。")}
        </SettingNote>
        {task.busy && (
          <Group>
            <Text size="sm">
              {task.action}
              {task.provider ? ` · ${task.provider}` : ""}…
            </Text>
            <Button variant="subtle" size="xs" onClick={ai.cancel}>
              {t("取消请求")}
            </Button>
          </Group>
        )}
        {(error || current.error) && (
          <Alert color="red" role="alert">
            {t(error || current.error)}
          </Alert>
        )}
        <div className={classes.saveBar}>
          <Text size="xs" c="dimmed">
            {dirty ? t("有未保存的修改") : t("修改后点击保存")}
          </Text>
          <Group gap="xs">
            <Button
              variant="default"
              disabled={!dirty || busy}
              onClick={() => {
                setEdited(null);
                setError("");
              }}
            >
              {t("撤销修改")}
            </Button>
            <Button
              type="submit"
              loading={current.saving}
              disabled={!current.available || busy || (!dirty && !current.error)}
            >
              {t("保存 AI 设置")}
            </Button>
          </Group>
        </div>
      </Stack>
    </form>
  );
}
