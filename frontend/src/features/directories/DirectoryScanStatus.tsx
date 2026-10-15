import { t, useLocale } from "../../i18n/index";
import { useState } from "react";
import { Alert, Badge, Button, Group, Modal, Paper, Progress, Stack, Text } from "@mantine/core";
import type { ScanProgress, ScanState } from "../../contracts/library";

export const scanLabels: Record<ScanState, string> = {
  idle: "待扫描",
  scanning: "扫描中",
  completed: "已完成",
  partial: "部分完成",
  failed: "扫描失败",
  cancelled: "已停止",
  interrupted: "扫描中断",
};

export function DirectoryScanStatus({
  scan,
  pending,
  onCancel,
  onOpenLibrary,
}: {
  scan: ScanProgress;
  pending: boolean;
  onCancel: () => void;
  onOpenLibrary: () => void;
}) {
  useLocale();
  const [opened, setOpened] = useState(false);
  const scanning = scan.state === "scanning";
  const progress = scan.discovered ? (scan.processed / scan.discovered) * 100 : 0;
  const color = scan.state === "failed" ? "red" : scan.errors || scan.warnings ? "yellow" : "gray";
  return (
    <>
      <Paper withBorder p="xs" radius="md">
        <Group justify="space-between" gap="xs">
          <Group gap="sm">
            <Badge
              color={color}
              variant={color === "gray" ? "light" : "filled"}
              autoContrast
              component="output"
              aria-live="polite"
            >
              {scanLabels[scan.state]}
            </Badge>
            <Text size="xs" c="dimmed">
              {t(
                "已处理 {0} / {1} · 新增或更新 {2}",
                scan.processed,
                scan.discovered,
                scan.imported,
              )}
            </Text>
            {(scan.errors > 0 || scan.warnings > 0) && (
              <Text size="xs">
                {scan.errors > 0 && t("{0} 项待处理", t(scan.errors))}
                {scan.errors > 0 && scan.warnings > 0 && " · "}
                {scan.warnings > 0 && t("{0} 项兼容提示", t(scan.warnings))}
              </Text>
            )}
          </Group>
          <Group gap="xs">
            <Button size="compact-xs" variant="subtle" onClick={() => setOpened(true)}>
              {t("查看详情")}
            </Button>
            {scanning && (
              <Button size="compact-xs" variant="default" loading={pending} onClick={onCancel}>
                {t("停止扫描")}
              </Button>
            )}
          </Group>
        </Group>
        {scanning && (
          <Progress
            value={progress}
            size={3}
            mt="xs"
            animated
            aria-label={t("当前已发现文件的处理进度")}
          />
        )}
      </Paper>
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title={t("扫描详情")}
        size="lg"
        centered
      >
        <Stack gap="sm">
          <Text component="output" fw={600} aria-live="polite">
            {scanLabels[scan.state]}
          </Text>
          {scanning && (
            <Progress value={progress} animated aria-label={t("当前已发现文件的处理进度")} />
          )}
          <Text size="sm">
            {t(
              "已处理 {0} / 已发现 {1} · 新增或更新 {2} · 视频未变化 {3} · 非视频 {4}",
              scan.processed,
              scan.discovered,
              scan.imported,
              scan.unchanged,
              scan.skipped,
            )}
          </Text>
          {scanning && (
            <Text size="xs" c="dimmed">
              {t("发现数量会随扫描增加，停止后保留已导入的影片。")}
            </Text>
          )}
          {scan.current && (
            <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
              {scan.current}
            </Text>
          )}
          {scan.warnings > 0 && (
            <Alert color="yellow" title={t("{0} 项兼容提示", t(scan.warnings))}>
              <Stack gap={5} mah={160} style={{ overflowY: "auto" }}>
                {scan.notices.map((item, index) => (
                  <Text
                    key={`${item.path}-${index}`}
                    size="xs"
                    style={{ overflowWrap: "anywhere" }}
                  >
                    {item.path}：{t(item.message)}
                  </Text>
                ))}
              </Stack>
              <Text size="xs" mt="xs">
                {t("原始 NFO 保持原样，已读取的内容保存了快照。")}
              </Text>
            </Alert>
          )}
          {scan.errors > 0 && (
            <Alert color="yellow" title={t("{0} 项需要处理，已有资料已保留", t(scan.errors))}>
              <Stack gap={5} mah={200} style={{ overflowY: "auto" }}>
                {scan.issues.map((issue, index) => (
                  <Text
                    key={`${index}:${issue.path}`}
                    size="xs"
                    style={{ overflowWrap: "anywhere" }}
                  >
                    {issue.path}：{t(issue.message)}
                  </Text>
                ))}
              </Stack>
              {scan.errors > scan.issues.length && (
                <Text size="xs" mt="xs">
                  {t("显示前 {0} 项。处理后可重新扫描。", scan.issues.length)}
                </Text>
              )}
            </Alert>
          )}
          <Group justify="flex-end">
            {scanning ? (
              <Button size="xs" variant="default" loading={pending} onClick={onCancel}>
                {t("停止扫描")}
              </Button>
            ) : (
              <Button
                size="xs"
                onClick={() => {
                  setOpened(false);
                  onOpenLibrary();
                }}
              >
                {t("查看片库")}
              </Button>
            )}
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
