import { t, useLocale } from "../../i18n/index";
import { useState, useSyncExternalStore } from "react";
import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { os } from "@neutralinojs/lib";
import type { LibraryDocumentsService } from "../../services/library/LibraryDocumentsService";
export function LibraryDocumentsPanel({
  service,
  workId,
}: {
  service: LibraryDocumentsService;
  workId: string;
}) {
  useLocale();
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const [opened, setOpened] = useState(false),
    [choosing, setChoosing] = useState(false),
    [error, setError] = useState("");
  const start = async () => {
    setChoosing(true);
    setError("");
    try {
      const root = await os.showFolderDialog(t("导出 NFO 的位置"));
      if (root) {
        setOpened(true);
        await service.exportNfo(root, workId);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "资料文件操作失败。");
      setOpened(true);
    } finally {
      setChoosing(false);
    }
  };
  return (
    <>
      <Group gap="xs">
        <Button
          size="xs"
          variant="default"
          disabled={state.running || choosing}
          onClick={() => void start()}
        >
          {t("导出 NFO")}
        </Button>
        {(state.running || state.processed > 0) && (
          <Button size="xs" variant="subtle" onClick={() => setOpened(true)}>
            {t("资料任务 {0}", state.processed)}
          </Button>
        )}
      </Group>
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title={state.mode || t("资料文件")}
        centered
      >
        <Stack>
          <Text size="sm" role="status">
            {state.running ? t("正在处理") : state.cancelled ? t("已停止") : t("已结束")}
            {t(" · 成功 {0} · 失败 {1}", state.succeeded, state.failed)}
          </Text>
          {state.directory && (
            <Text size="xs" style={{ overflowWrap: "anywhere" }}>
              {t("保存位置：{0}", state.directory)}
            </Text>
          )}
          <Text size="xs" c="dimmed">
            {t("导出保存在独立的新目录，停止后保留已导出的文件。")}
          </Text>
          {(error || state.error) && (
            <Alert color="red" role="alert">
              {t(error || state.error)}
            </Alert>
          )}
          {!!state.failures.length && (
            <Alert color="yellow">
              {state.failures.map((failure, i) => (
                <Text size="xs" key={i} style={{ overflowWrap: "anywhere" }}>
                  {failure}
                </Text>
              ))}
            </Alert>
          )}
          {state.running && (
            <Button variant="default" onClick={service.cancel} disabled={state.cancelled}>
              {t("停止任务")}
            </Button>
          )}
        </Stack>
      </Modal>
    </>
  );
}
