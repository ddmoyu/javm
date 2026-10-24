import { t, useLocale } from "../../i18n/index";
import { useState, useSyncExternalStore } from "react";
import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useWorkspace } from "../../app/state";
import { systemIntegration } from "../../platform/neutralino/systemIntegration";
import { SettingCard, SettingFields } from "./SettingsPrimitives";

export function SystemIntegrationPanel() {
  useLocale();
  const { runtime } = useWorkspace();
  const service = systemIntegration(runtime);
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const [replace, setReplace] = useState<string>();
  return (
    <SettingCard title={t("系统链接")} icon="link">
      <SettingFields>
        <Text size="sm">
          {t("让浏览器中的 javm:// 链接打开此份 JAVM。移动便携版目录后，请在新位置重新注册。")}
        </Text>
        <Text component="output" size="xs" c="dimmed" aria-live="polite">
          {!state.available
            ? t("请在桌面版中设置。")
            : state.result?.state === "current"
              ? t("已关联到当前程序")
              : state.result?.state === "other"
                ? t("当前关联到其他程序或旧位置")
                : state.result?.state === "missing"
                  ? t("尚未注册")
                  : t("点击检查，读取当前用户的链接设置。")}
        </Text>
        {state.result?.command && (
          <Text size="xs" style={{ overflowWrap: "anywhere" }}>
            {state.result.command}
          </Text>
        )}
        <Group>
          <Button
            variant="default"
            size="xs"
            disabled={!state.available || state.busy}
            onClick={() => void service.run("status")}
          >
            {t("检查状态")}
          </Button>
          <Button
            size="xs"
            loading={state.busy}
            disabled={!state.available || !state.result || state.result.state === "current"}
            onClick={() =>
              state.result?.state === "other"
                ? setReplace(state.result.command)
                : void service.run("register")
            }
          >
            {t("注册到此版本")}
          </Button>
          {state.result?.canRemove !== false && (
            <Button
              variant="subtle"
              size="xs"
              disabled={state.busy || state.result?.state !== "current"}
              onClick={() => void service.run("remove")}
            >
              {t("解除关联")}
            </Button>
          )}
        </Group>
        {state.result?.state === "current" && state.result.canRemove === false && (
          <Text size="xs" c="dimmed">
            {t("此关联由系统管理，可在系统默认应用设置中更改，或卸载此程序。")}
          </Text>
        )}
        {state.error && <Alert color="red">{t(state.error)}</Alert>}
        <Modal
          opened={replace !== undefined}
          onClose={() => setReplace(undefined)}
          title={t("替换现有链接关联")}
          centered
        >
          <Stack>
            <Text size="sm">
              {t("之后 javm:// 链接将打开当前这份 JAVM。原程序和片库文件均保留。")}
            </Text>
            <Text size="xs" style={{ overflowWrap: "anywhere" }}>
              {replace}
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setReplace(undefined)}>
                {t("取消")}
              </Button>
              <Button
                onClick={() => {
                  void service.run("register", replace);
                  setReplace(undefined);
                }}
              >
                {t("确认替换")}
              </Button>
            </Group>
          </Stack>
        </Modal>
      </SettingFields>
    </SettingCard>
  );
}
