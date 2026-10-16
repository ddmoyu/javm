import { getLocale, t, useLocale } from "../../i18n/index";
import { useSyncExternalStore } from "react";
import { Alert, Button, Group, Modal, Paper, Progress, Stack, Stepper, Text } from "@mantine/core";
import { Icon } from "../../components/icons";
import type { LegacyImportService } from "../../services/library/LegacyImportService";

const phases = {
  preparing: "正在准备旧数据",
  backingUp: "正在备份新旧数据库",
  importing: "正在合并影片与关联资料",
  checking: "正在校验导入结果",
  cleaningUp: "正在移除旧数据库",
};
const repairPhases = {
  preparing: "正在核对迁移记录与备份",
  backingUp: "正在备份当前片库",
  importing: "正在核对发现页缓存",
  checking: "正在校验修复结果",
  cleaningUp: "正在完成修复",
};

export function LegacyImportModal({ service }: { service: LegacyImportService }) {
  useLocale();
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const running = state.state === "running";
  const completed = state.state === "completed";
  const missing = state.state === "none";
  const checking = state.checking;
  const repair = state.operation === "repair";
  const phase = state.phase ?? "preparing";
  const phaseLabel = (repair ? repairPhases : phases)[phase];
  const active = completed
    ? 3
    : phase === "checking" || phase === "cleaningUp"
      ? 2
      : phase === "importing"
        ? 1
        : 0;
  const percent = state.total
    ? Math.min(100, Math.round(((state.processed ?? 0) / state.total) * 100))
    : undefined;
  return (
    <Modal
      opened={state.opened}
      onClose={() => service.dismiss()}
      title={
        repair
          ? t(completed ? "旧库导入已修复" : "修复旧库导入")
          : completed
            ? t("旧数据已导入")
            : t("导入旧版片库")
      }
      size="lg"
      centered
      withCloseButton={!running}
      closeOnEscape={!running}
      closeOnClickOutside={false}
      closeButtonProps={{ "aria-label": t(repair ? "关闭" : "关闭旧数据导入引导") }}
    >
      <Stack gap="lg">
        <Text size="sm" c="dimmed">
          {checking
            ? t("正在检查旧版数据库，请稍候。")
            : missing
              ? t("未发现待导入的旧数据库。已完成迁移的数据无需再次导入。")
              : completed
                ? t("片库已更新，可以继续使用原有影片和资料。")
                : repair
                  ? t(
                      "旧版发现页的作品缓存可能被误计入片库。修复将核对迁移记录和导入前备份，仅移除可以确认的缓存项；已有视频、离线视频及后续保存或修改的资料会保留。",
                    )
                  : state.sourcePath
                    ? t(
                        "发现旧版 JAVM 数据库。导入后会合并到当前片库，保留新版已有资料，并补齐旧版关联数据。",
                      )
                    : t("暂时无法检查旧版数据库，请稍后重试。")}
        </Text>
        {!checking && !missing && (
          <Stepper
            active={active}
            size="xs"
            allowNextStepsSelect={false}
            aria-label={t(repair ? "修复旧库导入" : "旧数据导入步骤")}
          >
            <Stepper.Step label={t("备份")} description={t("保留恢复副本")} />
            <Stepper.Step label={t(repair ? "修复" : "合并")} description={t("保留已有资料")} />
            <Stepper.Step label={t("完成")} description={t("校验并清理")} />
          </Stepper>
        )}
        {state.sourcePath && !completed && !checking && !missing && (
          <Paper withBorder p="md" radius="md">
            <Stack gap={6}>
              <Text size="xs" c="dimmed">
                {t(repair ? "当前片库" : "旧数据库")}
              </Text>
              <Text size="sm" style={{ overflowWrap: "anywhere" }}>
                {repair ? state.targetPath : state.sourcePath}
              </Text>
              {typeof state.currentVideos === "number" && state.currentVideos > 0 && (
                <Text size="xs" c="dimmed">
                  {t("当前片库已有 ")}
                  {state.currentVideos.toLocaleString(getLocale())}
                  {t(
                    repair
                      ? " 部影片，将核对误导入的发现页缓存。"
                      : " 部影片，将合并导入；同路径影片不会重复创建。",
                  )}
                </Text>
              )}
            </Stack>
          </Paper>
        )}
        {running && (
          <output aria-live="polite">
            <Stack gap="xs">
              <Group justify="space-between">
                <Text size="sm">
                  {state.cancelling ? t("正在取消并回滚，请稍候…") : t(phaseLabel)}
                </Text>
                {percent !== undefined && (
                  <Text size="xs" c="dimmed">
                    {percent}%
                  </Text>
                )}
              </Group>
              <Progress value={percent ?? 0} aria-label={t(phaseLabel)} />
              {phase === "importing" && !!state.total && (
                <Text size="xs" c="dimmed">
                  {t("已处理 ")}
                  {(state.processed ?? 0).toLocaleString(getLocale())} /{" "}
                  {state.total.toLocaleString(getLocale())}
                  {t(" 条记录")}
                </Text>
              )}
            </Stack>
          </output>
        )}
        {!running && !completed && !checking && !missing && (
          <Alert variant="light" icon={<Icon name="info" size={18} />}>
            {repair
              ? t(
                  "修复前会备份当前片库，发现页原始记录继续归档保存。不会删除本地视频文件；失败或取消时回滚。",
                )
              : t(
                  "请先退出旧版 JAVM。导入成功后会移除旧数据库，保留新旧数据库的恢复副本，以后启动不再提醒。失败或取消时保留原数据。",
                )}
          </Alert>
        )}
        {!running && !completed && !checking && !missing && (
          <Text size="xs" c="dimmed">
            {t(
              repair
                ? "可稍后从「系统设置 → 片库与迁移」再次打开修复引导。"
                : "选择稍后导入后，可从「系统设置 → 片库与迁移」再次打开引导。",
            )}
          </Text>
        )}
        {state.error && !checking && (
          <Alert
            color="red"
            title={t(repair ? "修复尚未完成" : "导入尚未完成")}
            role="alert"
            icon={<Icon name="alert" size={18} />}
          >
            {t(state.error)}
          </Alert>
        )}
        {completed && (
          <Alert
            color={state.warning ? "yellow" : "green"}
            icon={<Icon name={state.warning ? "alert" : "check"} size={18} />}
          >
            <Stack gap={6}>
              <Text size="sm">
                {state.warning ||
                  (repair
                    ? t("已移除 {0} 条误导入的发现页缓存，媒体库已更新。", state.removedWorks ?? 0)
                    : t("旧数据库已移除，下次启动不会重复提醒。"))}
              </Text>
              <Text size="xs" style={{ overflowWrap: "anywhere" }}>
                {t("备份位置：{0}", state.backupPath?.replace(/[\\/][^\\/]+$/, ""))}
              </Text>
              {!repair && (
                <Text size="xs">
                  {t(
                    "影片与媒体关系已转换为新版片库；旧版下载、任务、别名等其余数据保存在原始记录归档和备份中，不会自动恢复执行。",
                  )}
                </Text>
              )}
            </Stack>
          </Alert>
        )}
        <Group justify="flex-end">
          {checking ? (
            <Button loading>{t("正在检查")}</Button>
          ) : missing ? (
            <Button data-autofocus onClick={() => service.dismiss()}>
              {t("关闭")}
            </Button>
          ) : running ? (
            <Button
              variant="default"
              disabled={state.cancelling || phase === "cleaningUp"}
              onClick={() => void service.cancel()}
            >
              {state.cancelling ? t("正在取消") : t(repair ? "取消修复" : "取消导入")}
            </Button>
          ) : completed ? (
            <Button data-autofocus onClick={() => service.dismiss()}>
              {t("进入片库")}
            </Button>
          ) : (
            <>
              <Button variant="default" onClick={() => service.dismiss()}>
                {t(repair ? "稍后修复" : "稍后导入")}
              </Button>
              <Button
                data-autofocus
                leftSection={<Icon name="upload" size={16} />}
                onClick={() => void service.start()}
              >
                {state.state === "failed" || state.state === "cancelled"
                  ? t(repair ? "重试修复" : "重试导入")
                  : t(repair ? "开始修复" : "开始导入")}
              </Button>
            </>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
