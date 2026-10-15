import { t, useLocale } from "../../i18n/index";
import { useState, useSyncExternalStore } from "react";
import { Alert, Button, Group, Modal, Stack, Text, Textarea } from "@mantine/core";
import { Icon } from "../../components/icons";
import type { FeedbackService } from "../../services/feedback/FeedbackService";
import { formatReport } from "../../services/feedback/report";

export function FeedbackDialog({ service }: { service: FeedbackService }) {
  useLocale();
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const report = state.reports.find((item) => item.id === state.activeId);
  // 每份报告独立保存复制结果，连续出现的故障不会沿用上一份成功提示。
  const [result, setResult] = useState({ id: "", text: "", failed: false });
  const submit = async (open: boolean) => {
    if (!report) return;
    try {
      const text = await service.submit(report.id, open);
      if (text) setResult({ id: report.id, text, failed: false });
    } catch (error) {
      setResult({
        id: report.id,
        text: error instanceof Error ? error.message : "复制反馈失败，请重试。",
        failed: true,
      });
    }
  };
  return (
    <Modal
      opened={!!report}
      onClose={service.dismiss}
      title={report?.title ?? "问题反馈"}
      size="lg"
      centered
      closeOnClickOutside={false}
    >
      {report && (
        <Stack gap="md">
          <Alert color="red" icon={<Icon name="alert" />} title={t("检测到操作异常")} role="alert">
            <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {t(report.message)}
            </Text>
          </Alert>
          <Text size="sm">
            {t("是否反馈此问题？点击“反馈问题”将复制系统信息和前后日志，并打开 GitHub Issues。")}
          </Text>
          {report.url && (
            <Text size="sm" c="dimmed">
              {t(
                "报告包含完整下载链接（包括可能存在的临时授权参数）。提交到公开 Issue 前，请确认下方内容。",
              )}
            </Text>
          )}
          <Text component="output" size="xs" c="dimmed" aria-live="polite">
            {report.complete ? t("诊断记录已整理。") : t("正在收集故障后的收尾日志…")}
            {report.count > 1 ? t(" 同类异常已合并 {0} 次。", t(report.count)) : ""}
            {state.reports.length > 1
              ? t(" 其他异常可在“设置 → 关于 JAVM → 问题反馈记录”中查看。")
              : ""}
          </Text>
          {state.error && (
            <Alert color="yellow" role="alert">
              {t(state.error)}
            </Alert>
          )}
          {result.id === report.id && result.text && (
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
          <Group justify="space-between" wrap="wrap">
            <Button variant="default" onClick={service.dismiss}>
              {t("暂不反馈")}
            </Button>
            <Group gap="xs">
              <Button
                variant="light"
                leftSection={<Icon name="copy" />}
                disabled={state.busy || !report.complete}
                onClick={() => void submit(false)}
              >
                {t("仅复制")}
              </Button>
              <Button
                leftSection={<Icon name="external" />}
                loading={state.busy}
                disabled={!report.complete}
                onClick={() => void submit(true)}
              >
                {t("反馈问题")}
              </Button>
            </Group>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
