import { t, useLocale } from "../../i18n/index";
import { useState, useSyncExternalStore } from "react";
import { Alert, Button, Stack, Text } from "@mantine/core";
import { useWorkspace } from "../../app/state";
import { publicMessage } from "../../services/publicMessage";
import { Pill } from "../../components/ui";
import { SettingCard, SettingNote, SettingRow } from "./SettingsPrimitives";
import { MetadataPipelinePanel } from "./MetadataPipelinePanel";

export function MetaTubeSettingsPanel() {
  useLocale();
  const { metatube, scraping } = useWorkspace();
  const current = useSyncExternalStore(metatube.settings.subscribe, metatube.settings.getSnapshot);
  const state = useSyncExternalStore(metatube.subscribe, metatube.getSnapshot);
  const [error, setError] = useState("");
  const status = { stopped: "待使用", starting: "启动中", ready: "运行中", failed: "需要处理" }[
    state.status
  ];
  return (
    <Stack gap="lg">
      {scraping?.pipeline && <MetadataPipelinePanel service={scraping.pipeline} />}
      {!current.available && <SettingNote>{t("请在桌面端管理影片资料服务。")}</SettingNote>}
      <SettingCard title={t("影片资料服务")} icon="radar" extra={<Pill>{t(status)}</Pill>}>
        <SettingRow title={t("内置版本")} hint={t("随 JAVM 提供和更新，无需单独下载安装。")}>
          <Text size="sm">
            {publicMessage(state.version) ||
              t(!current.available ? "桌面端可用" : state.bundleChecked ? "组件缺失" : "检查中…")}
          </Text>
        </SettingRow>
      </SettingCard>
      {state.busy && (
        <Text size="sm" component="output" aria-live="polite">
          {t(publicMessage(state.progress))}…
        </Text>
      )}
      {(error || current.error || state.error) && (
        <Alert color="red" role="alert">
          {t(publicMessage(error || current.error || state.error))}
        </Alert>
      )}
      {current.error && current.available && (
        <Button
          loading={current.saving}
          disabled={state.busy || state.querying}
          onClick={() => {
            setError("");
            void metatube.save(current.value).catch((reason: unknown) => {
              setError(reason instanceof Error ? reason.message : "恢复资料设置失败，请重试。");
            });
          }}
        >
          {t("恢复资料设置")}
        </Button>
      )}
      <SettingNote>
        {t(
          "首次查询资料时自动启动内置服务，启动后持续运行，退出 JAVM 时停止。关闭窗口到托盘不会停止服务。",
        )}
      </SettingNote>
    </Stack>
  );
}
