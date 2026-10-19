import { t, localizeOptions, useLocale } from "../../i18n/index";
import { useState, useSyncExternalStore } from "react";
import { Alert, Button, Group, Modal, Progress, Select, Stack, Switch, Text } from "@mantine/core";
import { useWorkspace } from "../../app/state";
import { createApplicationUpdater } from "../../platform/neutralino/applicationUpdates";
import { openExternalLink } from "../../platform/neutralino/externalLinks";
import { UpdateMirrorSettings } from "./UpdateMirrorSettings";
export function ApplicationUpdatePanel() {
  useLocale();
  const { runtime, network, notice } = useWorkspace(),
    service = createApplicationUpdater(runtime, network),
    state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const [confirming, setConfirming] = useState(false);
  const phase = state.status.phase;
  const busy =
    state.configuring ||
    state.restartRequired ||
    state.checking ||
    [
      "downloading",
      "verifying",
      "waiting",
      "backing-up",
      "installing",
      "trial",
      "rolling-back",
    ].includes(phase);
  const version = state.status.version || state.release?.version;
  const progress = state.status.total
    ? Math.min(100, ((state.status.bytes ?? 0) / state.status.total) * 100)
    : 0;
  const report = (error: unknown) =>
    notice(error instanceof Error ? error.message : "更新操作失败。");
  const labels: Record<string, string> = {
    downloading: "正在下载更新及回退包",
    verifying: "正在校验更新包",
    ready: "更新已就绪",
    waiting: "正在停止任务并准备安装",
    "backing-up": "正在备份程序和数据",
    installing: "正在安装",
    trial: "正在验证新版启动",
    committed: "更新已完成",
    "rolling-back": "正在恢复旧版",
    "rolled-back": "更新失败，已恢复旧版程序和数据",
    failed: "更新未完成",
    cancelled: "更新已取消，可继续下载",
  };
  return (
    <Stack gap="xs">
      <Text size="sm">{t("当前版本 {0}", service.current)}</Text>
      <Group align="end">
        <Select
          label={t("更新通道")}
          value={state.channel}
          data={localizeOptions([
            { value: "stable", label: "正式版" },
            { value: "beta", label: "测试版（Beta）" },
          ])}
          allowDeselect={false}
          disabled={busy || !state.available}
          onChange={(value) => {
            if (value === "stable" || value === "beta")
              void service.configure(value, state.automatic).catch(report);
          }}
        />
        <Switch
          label={t("自动检查更新")}
          checked={state.automatic}
          disabled={busy || !state.available}
          onChange={(event) =>
            void service.configure(state.channel, event.currentTarget.checked).catch(report)
          }
        />
      </Group>
      <Text size="xs" c="dimmed">
        {state.channel === "beta" ? t("接收 Beta 和更新的正式版。") : t("仅接收正式版。")}
        {t("切换通道不会降级。发现更新后由你下载并确认重启安装。")}
      </Text>
      <UpdateMirrorSettings
        mirror={state.mirror}
        customMirror={state.customMirror}
        disabled={busy || !state.available}
        save={(mirror, custom) => service.configure(state.channel, state.automatic, mirror, custom)}
      />
      <Text size="xs" c="dimmed">
        {t("检查结果缓存 15 分钟，连续点击不会重复请求。")}
      </Text>
      {!state.available && state.initialized && (
        <Text size="sm" c="dimmed">
          {state.reason || t("更新服务暂不可用。")}
        </Text>
      )}
      {(state.error || state.status.error) && (
        <Alert color={phase === "rolled-back" ? "yellow" : "red"}>
          {t(state.error || state.status.error)}
        </Alert>
      )}
      {state.retryAt > 0 && (
        <Text component="output" size="xs">
          {t("可重试时间：{0}", new Date(state.retryAt).toLocaleString())}
        </Text>
      )}
      {phase !== "idle" && (
        <Text size="sm" role="status">
          {t(labels[phase])}
          {version ? ` · ${version}` : ""}
        </Text>
      )}
      {phase === "downloading" && <Progress value={progress} aria-label={t("更新下载进度")} />}
      {phase === "downloading" && state.status.source && (
        <Text component="output" size="xs" c="dimmed">
          {t("下载来源：{0}", state.status.source)}
        </Text>
      )}
      {state.release && phase === "idle" && (
        <Text size="sm">{t("发现新版本 {0}", state.release.version)}</Text>
      )}
      {state.checked && !state.checking && !state.error && !state.release && phase === "idle" && (
        <Text size="sm">{t("当前通道暂无可安装的更高版本。")}</Text>
      )}
      <Group>
        <Button
          size="xs"
          variant="default"
          disabled={!state.available || busy || phase === "ready"}
          loading={state.checking}
          onClick={() => {
            void service.check().catch(report);
          }}
        >
          {t("检查更新")}
        </Button>
        {state.release && !busy && phase !== "ready" && (
          <Button size="xs" onClick={() => void service.download().catch(report)}>
            {t("下载 {0}", state.release.version)}
          </Button>
        )}
        {["downloading", "verifying"].includes(phase) && (
          <Button size="xs" variant="default" onClick={() => void service.cancel().catch(report)}>
            {t("取消更新")}
          </Button>
        )}
        {phase === "ready" && (
          <Button size="xs" disabled={state.restartRequired} onClick={() => setConfirming(true)}>
            {t("重启并安装 {0}", version)}
          </Button>
        )}
        {state.release && (
          <Button
            size="xs"
            variant="subtle"
            onClick={() =>
              void openExternalLink(state.release!.url).catch((e) =>
                notice(e instanceof Error ? e.message : "无法打开发布页面"),
              )
            }
          >
            {t("查看更新日志")}
          </Button>
        )}
      </Group>
      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title={t("重启并安装更新")}
        centered
      >
        <Stack>
          <Text size="sm">
            {t(
              "将安装 {0}。下载、扫描和刮削等后台任务会先停止并保存进度，应用退出后开始安装。",
              version,
            )}
          </Text>
          <Text size="sm">
            {t(
              "更新前会备份程序、片库、下载记录和设置。安装或首次启动失败时恢复旧版及对应数据。系统安装包可能需要确认管理员授权。",
            )}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirming(false)}>
              {t("稍后安装")}
            </Button>
            <Button
              onClick={() => {
                setConfirming(false);
                void service.install().catch(report);
              }}
            >
              {t("停止任务并重启安装")}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
