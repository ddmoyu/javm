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

export function LegacyImportModal({ service }: { service: LegacyImportService }) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const running = state.state === "running";
  const completed = state.state === "completed";
  const missing = state.state === "none";
  const checking = state.checking;
  const phase = state.phase ?? "preparing";
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
      title={completed ? "旧数据已导入" : "导入旧版片库"}
      size="lg"
      centered
      withCloseButton={!running}
      closeOnEscape={!running}
      closeOnClickOutside={false}
      closeButtonProps={{ "aria-label": "关闭旧数据导入引导" }}
    >
      <Stack gap="lg">
        <Text size="sm" c="dimmed">
          {checking
            ? "正在检查旧版数据库，请稍候。"
            : missing
              ? "未发现待导入的旧数据库。已完成迁移的数据无需再次导入。"
              : completed
                ? "片库已更新，可以继续使用原有影片和资料。"
                : state.sourcePath
                  ? "发现旧版 JAVM 数据库。导入后会合并到当前片库，保留新版已有资料，并补齐旧版关联数据。"
                  : "暂时无法检查旧版数据库，请稍后重试。"}
        </Text>
        {!checking && !missing && (
          <Stepper
            active={active}
            size="xs"
            allowNextStepsSelect={false}
            aria-label="旧数据导入步骤"
          >
            <Stepper.Step label="备份" description="保留恢复副本" />
            <Stepper.Step label="合并" description="保留已有资料" />
            <Stepper.Step label="完成" description="校验并清理" />
          </Stepper>
        )}
        {state.sourcePath && !completed && !checking && !missing && (
          <Paper withBorder p="md" radius="md">
            <Stack gap={6}>
              <Text size="xs" c="dimmed">
                旧数据库
              </Text>
              <Text size="sm" style={{ overflowWrap: "anywhere" }}>
                {state.sourcePath}
              </Text>
              {typeof state.currentVideos === "number" && state.currentVideos > 0 && (
                <Text size="xs" c="dimmed">
                  当前片库已有 {state.currentVideos.toLocaleString()}{" "}
                  部影片，将合并导入；同路径影片不会重复创建。
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
                  {state.cancelling ? "正在取消并回滚，请稍候…" : phases[phase]}
                </Text>
                {percent !== undefined && (
                  <Text size="xs" c="dimmed">
                    {percent}%
                  </Text>
                )}
              </Group>
              <Progress value={percent ?? 0} aria-label={phases[phase]} />
              {phase === "importing" && !!state.total && (
                <Text size="xs" c="dimmed">
                  已处理 {(state.processed ?? 0).toLocaleString()} / {state.total.toLocaleString()}{" "}
                  条记录
                </Text>
              )}
            </Stack>
          </output>
        )}
        {!running && !completed && !checking && !missing && (
          <Alert variant="light" icon={<Icon name="info" size={18} />}>
            请先退出旧版
            JAVM。导入成功后会移除旧数据库，保留新旧数据库的恢复副本，以后启动不再提醒。失败或取消时保留原数据。
          </Alert>
        )}
        {!running && !completed && !checking && !missing && (
          <Text size="xs" c="dimmed">
            选择稍后导入后，可从「系统设置 → 片库与迁移」再次打开引导。
          </Text>
        )}
        {state.error && !checking && (
          <Alert
            color="red"
            title="导入尚未完成"
            role="alert"
            icon={<Icon name="alert" size={18} />}
          >
            {state.error}
          </Alert>
        )}
        {completed && (
          <Alert
            color={state.warning ? "yellow" : "green"}
            icon={<Icon name={state.warning ? "alert" : "check"} size={18} />}
          >
            <Stack gap={6}>
              <Text size="sm">{state.warning || "旧数据库已移除，下次启动不会重复提醒。"}</Text>
              <Text size="xs" style={{ overflowWrap: "anywhere" }}>
                备份位置：{state.backupPath?.replace(/[\\/][^\\/]+$/, "")}
              </Text>
              <Text size="xs">
                影片与媒体关系已转换为新版片库；旧版下载、任务、别名等其余数据保存在原始记录归档和备份中，不会自动恢复执行。
              </Text>
            </Stack>
          </Alert>
        )}
        <Group justify="flex-end">
          {checking ? (
            <Button loading>正在检查</Button>
          ) : missing ? (
            <Button data-autofocus onClick={() => service.dismiss()}>
              关闭
            </Button>
          ) : running ? (
            <Button
              variant="default"
              disabled={state.cancelling || phase === "cleaningUp"}
              onClick={() => void service.cancel()}
            >
              {state.cancelling ? "正在取消" : "取消导入"}
            </Button>
          ) : completed ? (
            <Button data-autofocus onClick={() => service.dismiss()}>
              进入片库
            </Button>
          ) : (
            <>
              <Button variant="default" onClick={() => service.dismiss()}>
                稍后导入
              </Button>
              <Button
                data-autofocus
                leftSection={<Icon name="upload" size={16} />}
                onClick={() => void service.start()}
              >
                {state.state === "failed" || state.state === "cancelled" ? "重试导入" : "开始导入"}
              </Button>
            </>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
