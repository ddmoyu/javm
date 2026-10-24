import { getLocale, t, useLocale } from "../../i18n/index";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Button, Group, Stack, Text, Textarea, Title } from "@mantine/core";
import { Icon } from "../../components/icons";
import type { FeedbackService } from "../../services/feedback/FeedbackService";
import { formatReport } from "../../services/feedback/report";
import type { FailureReport } from "../../services/feedback/report";
import { FeedbackToggle } from "./FeedbackToggle";

export function FeedbackDetails({
  service,
  report,
  history = false,
}: {
  service: FeedbackService;
  report: FailureReport;
  history?: boolean;
}) {
  useLocale();
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (history) back.current?.focus();
  }, [history]);
  // 父级以报告 ID 挂载，切换记录时复制结果和展开状态一并重置。
  const [result, setResult] = useState({ text: "", failed: false });
  const submit = async (open: boolean) => {
    try {
      const text = await service.submit(report.id, open);
      if (text) setResult({ text, failed: false });
    } catch (error) {
      setResult({
        text: error instanceof Error ? error.message : "复制反馈失败，请重试。",
        failed: true,
      });
    }
  };
  return (
    <Stack gap="md">
      {history && (
        <>
          <Group justify="space-between">
            <Button
              ref={back}
              variant="subtle"
              leftSection={<Icon name="arrow" />}
              onClick={service.dismiss}
            >
              {t("返回记录")}
            </Button>
            <Text size="xs" c="dimmed">
              {new Date(report.time).toLocaleString(getLocale())}
              {t(" · {0} 次", report.count)}
            </Text>
          </Group>
          <Title order={3} size="h4" style={{ overflowWrap: "anywhere" }}>
            {t(report.title)}
          </Title>
        </>
      )}
      <Alert color="red" icon={<Icon name="alert" />} title={t("检测到操作异常")} role="alert">
        <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {t(report.message)}
        </Text>
      </Alert>
      <Text size="sm">
        {history
          ? t("点击“前往 GitHub 反馈”会复制诊断内容并打开 GitHub Issues，由你粘贴提交。")
          : t("是否反馈此问题？点击“反馈问题”将复制系统信息和前后日志，并打开 GitHub Issues。")}
      </Text>
      <Text size="sm" c="dimmed">
        {t(
          "报告保留番号、查询内容、文件名及完整业务链接（可能含临时授权参数）。提交到公开 Issue 前，请检查下方预览。",
        )}
      </Text>
      <Text component="output" size="xs" c="dimmed" aria-live="polite">
        {report.complete ? t("诊断记录已整理。") : t("正在收集故障后的收尾日志…")}
        {report.count > 1 ? t(" 同类异常已合并 {0} 次。", report.count) : ""}
        {!history && state.reports.length > 1
          ? t(" 其他异常可在“设置 → 关于 JAVM → 诊断与反馈”中查看。")
          : ""}
      </Text>
      {state.error && (
        <Alert color="yellow" role="alert">
          {t(state.error)}
        </Alert>
      )}
      {result.text && (
        <output aria-live="polite">
          <Alert color={result.failed ? "red" : "green"}>{t(result.text)}</Alert>
        </output>
      )}
      <details>
        <summary style={{ cursor: "pointer" }}>{t("预览反馈内容 / 手动复制")}</summary>
        <Textarea
          mt="sm"
          label={t("将复制到剪贴板的反馈内容")}
          readOnly
          value={formatReport(report)}
          minRows={10}
          maxRows={16}
          autosize
          styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
        />
      </details>
      {!history && <FeedbackToggle service={service} />}
      <Group justify={history ? "flex-end" : "space-between"} wrap="wrap">
        {!history && (
          <Button variant="default" onClick={service.dismiss}>
            {t("暂不反馈")}
          </Button>
        )}
        <Group gap="xs">
          <Button
            variant="light"
            leftSection={<Icon name="copy" />}
            disabled={state.busy || state.savingSettings || !report.complete}
            onClick={() => void submit(false)}
          >
            {history ? t("复制诊断") : t("仅复制")}
          </Button>
          <Button
            leftSection={<Icon name="external" />}
            loading={state.busy}
            disabled={state.savingSettings || !report.complete}
            onClick={() => void submit(true)}
          >
            {history ? t("前往 GitHub 反馈") : t("反馈问题")}
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}
