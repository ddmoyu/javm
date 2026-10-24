import { t, useLocale } from "../../i18n/index";
import { useState, useSyncExternalStore } from "react";
import { Alert, Button, Group, Modal, Progress, Stack, Text } from "@mantine/core";
import * as os from "../../platform/neutralino/privateDialogs";
import type { LibraryBackupService } from "../../services/library/LibraryBackupService";
import { SettingCard, SettingFields } from "./SettingsPrimitives";

const phases: Record<string, string> = {
  preparing: "正在准备",
  reading: "正在读取备份",
  validating: "正在校验",
  backingUp: "正在保存备份",
  restoring: "正在恢复片库",
};
export function LibraryBackupPanel({ service }: { service: LibraryBackupService }) {
  useLocale();
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
        const paths = await os.showOpenDialog(t("选择 JAVM 片库备份"), {
          filters: [{ name: t("片库备份"), extensions: ["sqlite3", "db", "bak"] }],
          multiSelections: false,
        });
        if (paths[0]) await service.inspect(paths[0]);
      } else {
        const directory = await os.showFolderDialog(t("选择备份保存位置"));
        if (directory) await service.create(directory);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法选择备份位置。");
    } finally {
      setChoosing(false);
    }
  };
  return (
    <SettingCard title={t("片库备份与恢复")} icon="folder">
      <SettingFields>
        <Text size="sm">
          {t(
            "备份作品资料、收藏、关联路径、别名和播放进度。视频、图片、NFO 文件、下载任务与应用设置不包含在数据库备份中，请保留原文件。",
          )}
        </Text>
        <Group>
          <Button
            variant="default"
            disabled={!state.available || busy || choosing}
            onClick={() => void choose(false)}
          >
            {t("创建备份")}
          </Button>
          <Button
            variant="default"
            disabled={!state.available || busy || choosing}
            onClick={() => void choose(true)}
          >
            {t("选择备份恢复")}
          </Button>
        </Group>
        {!state.available && (
          <Text size="xs" c="dimmed">
            {t("请在桌面应用中备份或恢复片库。")}
          </Text>
        )}
        {(error || state.error) && !busy && (
          <Alert color="red" role="alert">
            {t(error || state.error)}
          </Alert>
        )}
        {state.warning && (
          <Alert color="yellow" role="alert">
            {t(state.warning)}
          </Alert>
        )}
        {state.state === "cancelled" && <Text size="sm">{t("操作已取消，当前片库保留。")}</Text>}
        {state.state === "completed" && state.result && (
          <Alert color="green">
            <Stack component="output" gap={5} aria-live="polite">
              <Text size="sm">
                {state.operation === "inspect"
                  ? t("备份校验通过")
                  : state.operation === "restore"
                    ? t("片库恢复完成")
                    : t("备份已保存")}
                {t(
                  " · {0} 部作品 · {1} 个视频关联 · {2} 项收藏",
                  state.result.works,
                  state.result.resources,
                  state.result.favorites,
                )}
              </Text>
              <Text size="xs" style={{ overflowWrap: "anywhere" }}>
                {state.result.path}
              </Text>
              {state.result.rollbackPath && (
                <Text size="xs" style={{ overflowWrap: "anywhere" }}>
                  {t("恢复前副本：{0}", state.result.rollbackPath)}
                </Text>
              )}
            </Stack>
          </Alert>
        )}
        {state.candidate && !busy && (
          <Button color="orange" variant="light" onClick={() => setConfirming(true)}>
            {t("恢复已校验的备份")}
          </Button>
        )}
      </SettingFields>
      <Modal
        opened={confirming && !busy}
        onClose={() => setConfirming(false)}
        title={t("恢复片库")}
        centered
      >
        <Stack>
          <Text size="sm">
            {t(
              "当前片库将替换为备份中的 {0} 部作品及关联资料。恢复前会自动保存当前片库副本；视频与图片文件不会移动或删除。",
              state.candidate?.works,
            )}
          </Text>
          <Text size="sm">
            {t(
              "恢复前会关闭内置播放器。备份后的新增收藏、编辑和播放进度仅保留在恢复前副本中。已移动的文件可随后从目录管理重新关联。",
            )}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" data-autofocus onClick={() => setConfirming(false)}>
              {t("取消")}
            </Button>
            <Button
              color="orange"
              onClick={() => {
                setConfirming(false);
                void service.restore();
              }}
            >
              {t("备份当前片库并恢复")}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={busy}
        onClose={() => {}}
        title={
          state.operation === "restore"
            ? t("正在恢复片库")
            : state.operation === "inspect"
              ? t("正在检查备份")
              : t("正在备份片库")
        }
        centered
        closeOnEscape={false}
        closeOnClickOutside={false}
        withCloseButton={false}
      >
        <Stack>
          <Text component="output" size="sm" aria-live="polite">
            {state.cancelling
              ? t("正在取消，请等待数据库收尾…")
              : t(phases[state.phase ?? "preparing"])}
          </Text>
          <Progress
            aria-label={t("备份恢复进度")}
            animated={!state.total}
            value={state.total ? Math.min(100, ((state.processed ?? 0) / state.total) * 100) : 100}
          />
          <Text size="xs" c="dimmed">
            {t("操作在后台执行。完成前暂时停止片库写入，可以取消或最小化窗口。")}
          </Text>
          {state.error && (
            <Alert color="orange" role="alert">
              {t("{0} 正在继续查询任务状态，请勿重复发起。", t(state.error))}
            </Alert>
          )}
          <Button
            variant="default"
            disabled={state.cancelling}
            onClick={() => void service.cancel()}
          >
            {t("取消操作")}
          </Button>
        </Stack>
      </Modal>
    </SettingCard>
  );
}
