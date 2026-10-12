import { useState, useSyncExternalStore } from "react";
import { Alert, Button, Group, Modal, Progress, Stack, Text } from "@mantine/core";
import { os } from "@neutralinojs/lib";
import type { LibraryBackupService } from "../../services/library/LibraryBackupService";
import { SettingCard } from "./SettingsPrimitives";

const phases: Record<string, string> = {
  preparing: "正在准备",
  reading: "正在读取备份",
  validating: "正在校验",
  backingUp: "正在保存备份",
  restoring: "正在恢复片库",
};
export function LibraryBackupPanel({ service }: { service: LibraryBackupService }) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const busy = state.state === "running";
  const choose = async (restore: boolean) => {
    setChoosing(true);
    setError("");
    try {
      if (restore) {
        const paths = await os.showOpenDialog("选择 JAVM 片库备份", {
          filters: [{ name: "片库备份", extensions: ["sqlite3", "db", "bak"] }],
          multiSelections: false,
        });
        if (paths[0]) await service.inspect(paths[0]);
      } else {
        const directory = await os.showFolderDialog("选择备份保存位置");
        if (directory) await service.create(directory);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法选择备份位置。");
    } finally {
      setChoosing(false);
    }
  };
  return (
    <SettingCard title="片库备份与恢复" icon="folder">
      <Stack gap="sm">
        <Text size="sm">
          备份作品资料、收藏、关联路径、别名和播放进度。视频、图片、NFO
          文件、下载任务与应用设置不包含在数据库备份中，请保留原文件。
        </Text>
        <Group>
          <Button
            variant="default"
            disabled={!state.available || busy || choosing}
            onClick={() => void choose(false)}
          >
            创建备份
          </Button>
          <Button
            variant="default"
            disabled={!state.available || busy || choosing}
            onClick={() => void choose(true)}
          >
            选择备份恢复
          </Button>
        </Group>
        {!state.available && (
          <Text size="xs" c="dimmed">
            请在桌面应用中备份或恢复片库。
          </Text>
        )}
        {(error || state.error) && !busy && (
          <Alert color="red" role="alert">
            {error || state.error}
          </Alert>
        )}
        {state.warning && (
          <Alert color="yellow" role="alert">
            {state.warning}
          </Alert>
        )}
        {state.state === "cancelled" && <Text size="sm">操作已取消，当前片库保留。</Text>}
        {state.state === "completed" && state.result && (
          <Alert color="green">
            <Stack component="output" gap={5} aria-live="polite">
              <Text size="sm">
                {state.operation === "inspect"
                  ? "备份校验通过"
                  : state.operation === "restore"
                    ? "片库恢复完成"
                    : "备份已保存"}{" "}
                · {state.result.works} 部作品 · {state.result.resources} 个视频关联 ·{" "}
                {state.result.favorites} 项收藏
              </Text>
              <Text size="xs" style={{ overflowWrap: "anywhere" }}>
                {state.result.path}
              </Text>
              {state.result.rollbackPath && (
                <Text size="xs" style={{ overflowWrap: "anywhere" }}>
                  恢复前副本：{state.result.rollbackPath}
                </Text>
              )}
            </Stack>
          </Alert>
        )}
        {state.candidate && !busy && (
          <Button color="orange" variant="light" onClick={() => setConfirming(true)}>
            恢复已校验的备份
          </Button>
        )}
      </Stack>
      <Modal
        opened={confirming && !busy}
        onClose={() => setConfirming(false)}
        title="恢复片库"
        centered
      >
        <Stack>
          <Text size="sm">
            当前片库将替换为备份中的 {state.candidate?.works}{" "}
            部作品及关联资料。恢复前会自动保存当前片库副本；视频与图片文件不会移动或删除。
          </Text>
          <Text size="sm">
            恢复前会关闭内置播放器。备份后的新增收藏、编辑和播放进度仅保留在恢复前副本中。已移动的文件可随后从目录管理重新关联。
          </Text>
          <Group justify="flex-end">
            <Button variant="default" data-autofocus onClick={() => setConfirming(false)}>
              取消
            </Button>
            <Button
              color="orange"
              onClick={() => {
                setConfirming(false);
                void service.restore();
              }}
            >
              备份当前片库并恢复
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={busy}
        onClose={() => {}}
        title={
          state.operation === "restore"
            ? "正在恢复片库"
            : state.operation === "inspect"
              ? "正在检查备份"
              : "正在备份片库"
        }
        centered
        closeOnEscape={false}
        closeOnClickOutside={false}
        withCloseButton={false}
      >
        <Stack>
          <Text component="output" size="sm" aria-live="polite">
            {state.cancelling ? "正在取消，请等待数据库收尾…" : phases[state.phase ?? "preparing"]}
          </Text>
          <Progress
            aria-label="备份恢复进度"
            animated={!state.total}
            value={state.total ? Math.min(100, ((state.processed ?? 0) / state.total) * 100) : 100}
          />
          <Text size="xs" c="dimmed">
            操作在后台执行。完成前暂时停止片库写入，可以取消或最小化窗口。
          </Text>
          {state.error && (
            <Alert color="orange" role="alert">
              {state.error} 正在继续查询任务状态，请勿重复发起。
            </Alert>
          )}
          <Button
            variant="default"
            disabled={state.cancelling}
            onClick={() => void service.cancel()}
          >
            取消操作
          </Button>
        </Stack>
      </Modal>
    </SettingCard>
  );
}
