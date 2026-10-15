import { useState, useSyncExternalStore } from "react";
import { Alert, Button, Group, Modal, Progress, Stack, Text, TextInput } from "@mantine/core";
import { os } from "@neutralinojs/lib";
import type { FileOrganizationService } from "../../services/library/FileOrganizationService";
export function FileOrganizationModal({
  service,
  file,
  onClose,
}: {
  service: FileOrganizationService;
  file: { id: string; path: string };
  onClose(): void;
}) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const normalized = file.path.replaceAll("\\", "/");
  const [directory, setDirectory] = useState(normalized.slice(0, normalized.lastIndexOf("/")));
  const [name, setName] = useState(normalized.slice(normalized.lastIndexOf("/") + 1));
  const target = `${directory.replace(/[\\/]$/, "")}/${name}`;
  const [error, setError] = useState("");
  const perform = async (work: () => Promise<void>) => {
    setError("");
    try {
      await work();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "文件操作失败");
    }
  };
  return (
    <Modal
      opened
      title="改名或移动文件"
      onClose={() => !state.busy && onClose()}
      closeOnEscape={!state.busy}
      closeOnClickOutside={!state.busy}
      withCloseButton={!state.busy}
      centered
    >
      <Stack>
        <Text size="sm" style={{ overflowWrap: "anywhere" }}>
          原路径：{file.path}
        </Text>
        <TextInput
          label="文件名（保留扩展名）"
          value={name}
          disabled={state.busy}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <TextInput
          label="目标目录"
          value={directory}
          readOnly
          rightSectionWidth={85}
          rightSection={
            <Button
              size="compact-xs"
              variant="subtle"
              disabled={state.busy}
              onClick={() =>
                void perform(async () => {
                  const path = await os.showFolderDialog("移动到目录");
                  if (path) setDirectory(path);
                })
              }
            >
              选择目录
            </Button>
          }
        />
        <Text size="sm" style={{ overflowWrap: "anywhere" }}>
          目标路径：{target}
        </Text>
        <Text size="xs" c="dimmed">
          核对副本后更新片库并移除原视频。NFO、封面及其他文件保留原路径和关联；需要足够空间保存副本。
        </Text>
        {state.busy && (
          <>
            <Progress value={state.progress} />
            <Text size="sm" role="status">
              {state.action} · {state.progress.toFixed(1)}%
            </Text>
          </>
        )}
        {(error || state.error) && <Alert color="red">{error || state.error}</Alert>}
        {!!state.pending.length && !state.busy && (
          <Alert color="yellow">有未完成的整理任务，请在目录管理中恢复或取消。</Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={state.busy ? service.cancel : onClose}>
            {state.busy ? "暂停" : "关闭"}
          </Button>
          <Button
            loading={state.busy}
            disabled={!name || /[\\/]/.test(name) || !!state.pending.length}
            onClick={() =>
              void perform(async () => {
                await service.move(file.id, target);
                onClose();
              })
            }
          >
            确认路径并执行
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
