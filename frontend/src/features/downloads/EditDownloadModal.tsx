import { t, useLocale } from "../../i18n/index";
import { useState } from "react";
import { Alert, Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import type { DownloadTask } from "../../contracts/downloads";
import type { DownloadService } from "../../services/downloads/DownloadService";
export function EditDownloadModal({
  task,
  service,
  onClose,
}: {
  task: DownloadTask;
  service: DownloadService;
  onClose(): void;
}) {
  useLocale();
  const [name, setName] = useState(task.rename?.name ?? task.name);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      opened
      onClose={() => !busy && onClose()}
      title={t("修改下载任务")}
      centered
      closeOnEscape={!busy}
      closeOnClickOutside={!busy}
      withCloseButton={!busy}
    >
      <Stack>
        <TextInput
          label={t("名称（不含扩展名）")}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <Text size="sm">{t("修改保存名称；已有成品时同步修改文件名及片库路径。")}</Text>
        {task.rename && (
          <Alert color="yellow">{t("上次改名未确认完成。保存后将按操作记录继续恢复。")}</Alert>
        )}
        {error && <Alert color="red">{t(error)}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" disabled={busy} onClick={onClose}>
            {t("取消")}
          </Button>
          <Button
            loading={busy}
            onClick={() => {
              setBusy(true);
              setError("");
              void service
                .edit(task.id, name)
                .then(onClose)
                .catch((reason: unknown) =>
                  setError(reason instanceof Error ? reason.message : "修改失败"),
                )
                .finally(() => setBusy(false));
            }}
          >
            {t("保存修改")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
