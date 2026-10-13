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
              已处理 {scan.processed} / {scan.discovered} · 新增或更新 {scan.imported}
            </Text>
            {(scan.errors > 0 || scan.warnings > 0) && (
              <Text size="xs">
                {scan.errors > 0 && `${scan.errors} 项待处理`}
                {scan.errors > 0 && scan.warnings > 0 && " · "}
                {scan.warnings > 0 && `${scan.warnings} 项兼容提示`}
              </Text>
            )}
          </Group>
          <Group gap="xs">
            <Button size="compact-xs" variant="subtle" onClick={() => setOpened(true)}>
              查看详情
            </Button>
            {scanning && (
              <Button size="compact-xs" variant="default" loading={pending} onClick={onCancel}>
                停止扫描
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
            aria-label="当前已发现文件的处理进度"
          />
        )}
      </Paper>
      <Modal opened={opened} onClose={() => setOpened(false)} title="扫描详情" size="lg" centered>
        <Stack gap="sm">
          <Text component="output" fw={600} aria-live="polite">
            {scanLabels[scan.state]}
          </Text>
          {scanning && <Progress value={progress} animated aria-label="当前已发现文件的处理进度" />}
          <Text size="sm">
            已处理 {scan.processed} / 已发现 {scan.discovered} · 新增或更新 {scan.imported} ·
            视频未变化 {scan.unchanged} · 非视频 {scan.skipped}
          </Text>
          {scanning && (
            <Text size="xs" c="dimmed">
              发现数量会随扫描增加，停止后保留已导入的影片。
            </Text>
          )}
          {scan.current && (
            <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
              {scan.current}
            </Text>
          )}
          {scan.warnings > 0 && (
            <Alert color="yellow" title={`${scan.warnings} 项兼容提示`}>
              <Stack gap={5} mah={160} style={{ overflowY: "auto" }}>
                {scan.notices.map((item, index) => (
                  <Text
                    key={`${item.path}-${index}`}
                    size="xs"
                    style={{ overflowWrap: "anywhere" }}
                  >
                    {item.path}：{item.message}
                  </Text>
                ))}
              </Stack>
              <Text size="xs" mt="xs">
                原始 NFO 保持原样，已读取的内容保存了快照。
              </Text>
            </Alert>
          )}
          {scan.errors > 0 && (
            <Alert color="yellow" title={`${scan.errors} 项需要处理，已有资料已保留`}>
              <Stack gap={5} mah={200} style={{ overflowY: "auto" }}>
                {scan.issues.map((issue, index) => (
                  <Text
                    key={`${index}:${issue.path}`}
                    size="xs"
                    style={{ overflowWrap: "anywhere" }}
                  >
                    {issue.path}：{issue.message}
                  </Text>
                ))}
              </Stack>
              {scan.errors > scan.issues.length && (
                <Text size="xs" mt="xs">
                  显示前 {scan.issues.length} 项。处理后可重新扫描。
                </Text>
              )}
            </Alert>
          )}
          <Group justify="flex-end">
            {scanning ? (
              <Button size="xs" variant="default" loading={pending} onClick={onCancel}>
                停止扫描
              </Button>
            ) : (
              <Button
                size="xs"
                onClick={() => {
                  setOpened(false);
                  onOpenLibrary();
                }}
              >
                查看片库
              </Button>
            )}
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
