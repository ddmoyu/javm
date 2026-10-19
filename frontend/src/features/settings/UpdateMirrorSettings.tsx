import { useState } from "react";
import { Button, Group, Select, Stack, Text, TextInput } from "@mantine/core";
import { t, localizeOptions } from "../../i18n/index";
import {
  updateMirrorOptions,
  isUpdateMirror,
  type UpdateMirror,
} from "../../services/settings/updateSources";

export function UpdateMirrorSettings({
  mirror,
  customMirror,
  disabled,
  save,
}: {
  mirror: UpdateMirror;
  customMirror: string;
  disabled: boolean;
  save: (mirror: UpdateMirror, custom: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(customMirror);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const commit = async (choice: UpdateMirror, custom: string) => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await save(choice, custom);
      setEditing(false);
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更新设置保存失败。");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Stack gap="xs">
      <Select
        label={t("更新来源")}
        value={editing ? "custom" : mirror}
        data={localizeOptions([...updateMirrorOptions])}
        allowDeselect={false}
        disabled={disabled || saving}
        onChange={(value) => {
          if (!isUpdateMirror(value)) return;
          setError("");
          setSaved(false);
          if (value === "custom") {
            setDraft(customMirror);
            setEditing(true);
          } else void commit(value, customMirror);
        }}
      />
      {(editing || mirror === "custom") && (
        <Group align="start">
          <TextInput
            label={t("自定义镜像地址")}
            placeholder="https://mirror.example.com/"
            style={{ flex: 1 }}
            value={editing ? draft : customMirror}
            disabled={disabled || saving}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setEditing(true);
              setError("");
              setSaved(false);
            }}
            description={t("填写镜像服务的 HTTPS 前缀，例如 https://gh-proxy.com/。")}
            error={error ? t(error) : undefined}
          />
          <Button
            variant="default"
            mt="lg"
            loading={saving}
            disabled={disabled || !editing}
            onClick={() => void commit("custom", draft)}
          >
            {t("保存镜像")}
          </Button>
        </Group>
      )}
      <Text size="xs" c="dimmed">
        {t(
          "自动模式优先使用 GitHub，失败后尝试社区镜像。指定镜像失败后回退到 GitHub。所有更新均校验官方签名。",
        )}
      </Text>
      {error && !editing && mirror !== "custom" && (
        <Text size="sm" c="red" role="alert">
          {t(error)}
        </Text>
      )}
      {saved && (
        <Text component="output" size="xs" c="dimmed">
          {t("更新来源已保存。")}
        </Text>
      )}
    </Stack>
  );
}
