import { useRef, useState, useSyncExternalStore } from "react";
import { Alert, Button, Code, Group, Modal, ScrollArea, Select, Stack, Text } from "@mantine/core";
import { useWorkspace } from "../../app/state";
import type { LogEntry } from "../../services/logging/events";
import { SettingCard, SettingRow } from "./SettingsPrimitives";

const levels = { debug: "调试", info: "信息", warn: "警告", error: "错误" };
export function LogsPanel() {
  const { logs, notice } = useWorkspace();
  const current = useSyncExternalStore(logs.subscribe, logs.getSnapshot);
  const [opened, setOpened] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<string | null>("all");
  const busy = useRef(false);
  const refresh = async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setError("");
    try {
      const result = await logs.recent();
      setEntries(result);
    } catch {
      setError("无法读取日志，请检查日志目录的访问权限后重试。");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };
  const visible = entries.filter((entry) => level === "all" || entry.level === level);
  return (
    <>
      <SettingCard title="日志与诊断" icon="list">
        <SettingRow
          title="应用日志"
          hint="统一记录应用、下载、扫描与播放日志；单文件最多 5 MB，最多 10 个文件，保留 7 天。"
        >
          <Button
            variant="default"
            size="xs"
            aria-haspopup="dialog"
            aria-expanded={opened}
            disabled={!current.available}
            onClick={() => {
              setOpened(true);
              void refresh();
            }}
          >
            查看日志
          </Button>
        </SettingRow>
        {current.error && (
          <Alert color="red" mb="sm">
            {current.error}
          </Alert>
        )}
        {!current.available && (
          <Text size="xs" c="dimmed" pb="sm">
            请在桌面端查看日志。
          </Text>
        )}
      </SettingCard>
      <Modal opened={opened} onClose={() => setOpened(false)} title="应用日志" size="xl" centered>
        <Stack>
          <Group justify="space-between" wrap="wrap">
            <Select
              aria-label="日志级别"
              value={level}
              onChange={setLevel}
              allowDeselect={false}
              data={[
                { value: "all", label: "全部级别" },
                ...Object.entries(levels).map(([value, label]) => ({ value, label })),
              ]}
            />
            <Group gap="xs">
              <Button variant="default" onClick={() => void refresh()} loading={loading}>
                刷新
              </Button>
              <Button
                variant="default"
                onClick={() => {
                  void logs
                    .openDirectory()
                    .catch(() => notice("无法打开日志目录，请检查访问权限。"));
                }}
              >
                打开日志目录
              </Button>
            </Group>
          </Group>
          {(error || current.error) && <Alert color="red">{error || current.error}</Alert>}
          {current.dropped > 0 && (
            <Alert color="yellow">日志写入繁忙，累计丢弃 {current.dropped} 条记录。</Alert>
          )}
          <Text size="xs" c="dimmed">
            最多显示近期 200 条，当前 {visible.length} 条；完整记录请打开日志目录。
          </Text>
          <ScrollArea h={380}>
            <Code block style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {visible
                .map(
                  (entry) =>
                    `${new Date(entry.time).toLocaleString("zh-CN", { hour12: false })} [${levels[entry.level]}] [${entry.module}] ${entry.message}${entry.context ? " " + JSON.stringify(entry.context) : ""}`,
                )
                .join("\n") || (loading ? "正在读取日志…" : "暂无符合条件的日志")}
            </Code>
          </ScrollArea>
          <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
            {current.directory}
          </Text>
        </Stack>
      </Modal>
    </>
  );
}
