import { t, useLocale } from "../../i18n/index";
import { useState } from "react";
import { Button, Checkbox, Group, Modal, Stack, Text } from "@mantine/core";
import type { EditableMetadata } from "../../contracts/metadata";
import { metadataLabels } from "../../contracts/metadata";

export function MetadataPreview({
  current,
  candidate,
  title,
  onApply,
  onClose,
}: {
  current: EditableMetadata;
  candidate: Partial<EditableMetadata>;
  title: string;
  onApply: (patch: Partial<EditableMetadata>) => void;
  onClose: () => void;
}) {
  useLocale();
  const keys = (Object.keys(metadataLabels) as (keyof EditableMetadata)[]).filter((key) => {
    const value = candidate[key];
    return (
      value !== undefined &&
      value !== "" &&
      value !== 0 &&
      (!Array.isArray(value) || value.length > 0) &&
      JSON.stringify(value) !== JSON.stringify(current[key])
    );
  });
  const [selected, setSelected] = useState<Set<keyof EditableMetadata>>(
    () =>
      new Set(
        keys.filter(
          (key) => !current[key] || (Array.isArray(current[key]) && !current[key].length),
        ),
      ),
  );
  const show = (value: EditableMetadata[keyof EditableMetadata] | undefined) =>
    Array.isArray(value) ? value.join("、") : String(value ?? "");
  return (
    <Modal
      opened
      title={t(title)}
      onClose={onClose}
      size={760}
      zIndex={450}
      centered
      returnFocus={false}
      closeOnClickOutside={false}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t("勾选需要采用的字段，未勾选的资料保持原值。结果进入编辑草稿后，还需保存。")}
        </Text>
        {!keys.length && <Text size="sm">{t("没有可采用的新资料。")}</Text>}
        {keys.map((key) => (
          <div
            key={key}
            style={{ borderBottom: "1px solid var(--velvet-line)", paddingBottom: 12 }}
          >
            <Checkbox
              label={t(metadataLabels[key])}
              checked={selected.has(key)}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setSelected((old) => {
                  const next = new Set(old);
                  if (checked) next.add(key);
                  else next.delete(key);
                  return next;
                });
              }}
            />
            <Text size="xs" c="dimmed" mt={8}>
              {t("当前：")}
              {show(current[key]) || t("未填写")}
            </Text>
            <Text size="sm" mt={4} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {t("候选：")}
              {show(candidate[key])}
            </Text>
          </div>
        ))}
        <Group justify="space-between">
          <Button
            variant="subtle"
            onClick={() => setSelected(new Set(keys))}
            disabled={!keys.length}
          >
            {t("选择全部差异")}
          </Button>
          <Group>
            <Button variant="default" onClick={onClose}>
              {t("取消")}
            </Button>
            <Button
              disabled={!selected.size}
              onClick={() =>
                onApply(Object.fromEntries([...selected].map((key) => [key, candidate[key]])))
              }
            >
              {t("采用所选字段")}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
