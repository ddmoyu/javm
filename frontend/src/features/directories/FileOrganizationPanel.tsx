import { useState, useSyncExternalStore } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  Paper,
  Progress,
  ScrollArea,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { os } from "@neutralinojs/lib";
import type { FileOrganizationService } from "../../services/library/FileOrganizationService";
export function FileOrganizationPanel({ service }: { service: FileOrganizationService }) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const [opened, setOpened] = useState(false),
    [oldRoot, setOldRoot] = useState(""),
    [newRoot, setNewRoot] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [localError, setLocalError] = useState("");
  const run = async (work: () => Promise<void>) => {
    setLocalError("");
    try {
      await work();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "文件操作失败");
    }
  };
  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Group justify="space-between">
          <Text fw={600}>文件整理与路径恢复</Text>
          <Button
            variant="light"
            disabled={state.busy || !!state.pending.length}
            onClick={() => setOpened(true)}
          >
            重新关联离线目录
          </Button>
        </Group>
        {state.pending.map((item) => (
          <Stack gap="xs" key={item.id}>
            <Text size="sm" style={{ overflowWrap: "anywhere" }}>
              {item.source} → {item.target}
            </Text>
            <Group>
              <Button
                size="xs"
                disabled={state.busy}
                onClick={() => void run(() => service.resume(item))}
              >
                继续恢复
              </Button>
              <Button
                size="xs"
                variant="default"
                disabled={state.busy || item.state !== "copying"}
                onClick={() => void run(() => service.discard(item))}
              >
                取消复制，保留原件
              </Button>
            </Group>
          </Stack>
        ))}
        {state.busy && (
          <>
            <Progress value={state.progress} />
            <Group>
              <Text size="sm" role="status">
                {state.action}
              </Text>
              <Button size="xs" variant="default" onClick={service.cancel}>
                暂停
              </Button>
            </Group>
          </>
        )}
        {(state.error || localError) && <Alert color="red">{localError || state.error}</Alert>}
        <Modal
          opened={opened}
          onClose={() => !state.busy && setOpened(false)}
          title="重新关联离线资源"
          size="lg"
          closeOnEscape={!state.busy}
          closeOnClickOutside={!state.busy}
        >
          <Stack>
            <TextInput
              label="原目录路径"
              value={oldRoot}
              disabled={state.busy}
              onChange={(event) => setOldRoot(event.currentTarget.value)}
            />
            <TextInput
              label="新目录路径"
              value={newRoot}
              readOnly
              rightSectionWidth={70}
              rightSection={
                <Button
                  size="compact-xs"
                  disabled={state.busy}
                  variant="subtle"
                  onClick={() =>
                    void run(async () => {
                      const path = await os.showFolderDialog("选择新目录");
                      if (path) setNewRoot(path);
                    })
                  }
                >
                  选择
                </Button>
              }
            />
            <Text size="sm">
              仅匹配原位置缺失、相对路径、大小和候选指纹一致的文件。请逐项核对；每批最多显示 500
              个资源，不搬动磁盘文件。
            </Text>
            <Group>
              <Button
                disabled={!oldRoot || !newRoot || state.busy}
                onClick={() =>
                  void run(async () => {
                    setSelected(new Set());
                    await service.preview(oldRoot, newRoot);
                  })
                }
              >
                检查新路径
              </Button>
              <Button
                variant="default"
                disabled={
                  state.busy ||
                  !state.nextCandidate ||
                  state.candidateRoots?.oldRoot !== oldRoot ||
                  state.candidateRoots?.newRoot !== newRoot
                }
                onClick={() =>
                  void run(async () => {
                    setSelected(new Set());
                    await service.preview(oldRoot, newRoot, state.nextCandidate);
                  })
                }
              >
                下一批
              </Button>
            </Group>
            <ScrollArea.Autosize mah={300}>
              <Stack gap="sm">
                {state.candidates.map((item) => (
                  <Checkbox
                    key={item.id}
                    disabled={!item.matched || state.busy}
                    checked={selected.has(item.id)}
                    onChange={(event) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.currentTarget.checked) next.add(item.id);
                        else next.delete(item.id);
                        return next;
                      })
                    }
                    label={`${item.matched ? "匹配" : "未匹配"}：${item.target}`}
                  />
                ))}
              </Stack>
            </ScrollArea.Autosize>
            {(state.error || localError) && <Alert color="red">{localError || state.error}</Alert>}
            <Button
              loading={state.busy}
              disabled={!selected.size}
              onClick={() =>
                void run(async () => {
                  await service.relink(state.candidates.filter((item) => selected.has(item.id)));
                  setSelected(new Set());
                })
              }
            >
              确认关联 {selected.size} 个资源
            </Button>
          </Stack>
        </Modal>
      </Stack>
    </Paper>
  );
}
