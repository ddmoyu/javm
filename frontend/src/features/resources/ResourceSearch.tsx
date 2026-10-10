import { useState, useSyncExternalStore } from "react";
import {
  Alert,
  Badge,
  Button,
  Group,
  MultiSelect,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useWorkspace } from "../../app/state";
import { Icon } from "../../components/icons";
import type { ResolutionState } from "../../contracts/streamResolution";
import type {
  ResourceSearchService,
  ResourceSearchSnapshot,
} from "../../services/streamResolution/ResourceSearchService";

const labels: Record<ResolutionState, string> = {
  queued: "等待查找",
  http: "检查链接",
  webview: "正在查找",
  validating: "检查链接",
  closing: "正在结束",
  succeeded: "已找到",
  failed: "未获取",
  cancelled: "已取消",
};

export function ResourceSearch() {
  const { resourceSearch } = useWorkspace();
  return resourceSearch ? (
    <ResourceSearchPanel service={resourceSearch} />
  ) : (
    <Alert>请在桌面应用中查找资源。</Alert>
  );
}

export function ResourceSearchPanel({ service }: { service: ResourceSearchService }) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const [feedback, setFeedback] = useState("");
  const rows = state.rows.filter(
    (row) =>
      state.filter === "all" ||
      (state.filter === "found"
        ? !!row.stream
        : row.state === "failed" || row.state === "cancelled"),
  );
  const found = state.rows.filter((row) => row.stream).length;
  const handoff = state.rows.some((row) => row.handingOff);
  return (
    <Stack gap="md">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setFeedback("");
          service.search();
        }}
      >
        <Stack gap="sm">
          <Group align="flex-end">
            <TextInput
              label="番号"
              placeholder="输入完整番号"
              value={state.query}
              maxLength={80}
              onChange={(event) => service.setQuery(event.currentTarget.value)}
              style={{ flex: 1, minWidth: 180 }}
            />
            <Button
              type="submit"
              disabled={
                !state.available || !state.query.trim() || !state.selected.length || handoff
              }
              leftSection={<Icon name="search" size={16} />}
            >
              {state.busy ? "重新查找" : "查找资源"}
            </Button>
            {state.busy && (
              <Button variant="default" onClick={service.cancel}>
                取消
              </Button>
            )}
          </Group>
          <MultiSelect
            label="视频来源"
            placeholder="选择来源"
            value={state.selected}
            onChange={service.setSources}
            data={service.sources.map((source) => ({ value: source.id, label: source.name }))}
            maxValues={5}
            searchable
            description="每次最多选择 5 个来源，按顺序查找。"
            disabled={handoff}
          />
        </Stack>
      </form>
      {!state.available && <Alert>资源查找需要 Windows 桌面环境。</Alert>}
      {state.error && (
        <Alert color="red" role="alert">
          {state.error}
        </Alert>
      )}
      {!!state.cleanupPending && (
        <Alert color="red" role="alert">
          取流实例尚未完成清理。
          <Button
            ml="sm"
            size="xs"
            variant="default"
            onClick={() => {
              void service.retryCleanup().catch(() => setFeedback("清理仍未完成，请重试。"));
            }}
          >
            重试清理
          </Button>
        </Alert>
      )}
      {feedback && (
        <Text size="sm" component="output">
          {feedback}
        </Text>
      )}
      <Group justify="space-between">
        <Text size="sm" component="output">
          {state.code ? `${state.code} · ${found} 个可下载资源` : "输入番号后查找视频资源"}
        </Text>
        <SegmentedControl
          size="xs"
          aria-label="资源筛选"
          value={state.filter}
          onChange={(value) => service.setFilter(value as ResourceSearchSnapshot["filter"])}
          data={[
            { value: "all", label: "全部" },
            { value: "found", label: "已找到" },
            { value: "failed", label: "未获取" },
          ]}
        />
      </Group>
      <Stack gap="sm" aria-label="资源结果">
        {rows.map((row) => {
          const track = row.stream?.tracks.find((item) => item.kind === "video");
          const active = ["queued", "webview", "http", "validating", "closing"].includes(row.state);
          return (
            <Paper key={row.sourceId} withBorder p="md" radius="md">
              <Group justify="space-between" align="flex-start">
                <Stack gap={5} style={{ flex: 1, minWidth: 180 }}>
                  <Group gap="sm">
                    <Text fw={600}>{row.sourceName}</Text>
                    <Badge color={row.stream ? "teal" : active ? "blue" : "gray"} variant="light">
                      {labels[row.state]}
                    </Badge>
                  </Group>
                  {row.stream && (
                    <Text size="sm">
                      HLS · {track?.height ? `${track.height}p · ` : ""}
                      {Math.round((track?.duration ?? 0) / 60)} 分钟
                    </Text>
                  )}
                  {row.stream && (
                    <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
                      {new URL(row.stream.manifestUrl).hostname}
                    </Text>
                  )}
                  {row.error && (
                    <Text size="sm" c="red" role="alert">
                      {row.error}
                    </Text>
                  )}
                </Stack>
                <Group gap="xs">
                  {row.stream && (
                    <>
                      <Button
                        size="xs"
                        variant="default"
                        onClick={() => {
                          if (Date.now() >= row.stream!.expiresAt) {
                            setFeedback("链接检查已过期，请重新查找后复制。");
                            return;
                          }
                          void navigator.clipboard.writeText(row.stream!.manifestUrl).then(
                            () => setFeedback("已复制 m3u8 链接。"),
                            () => setFeedback("复制失败，请重试。"),
                          );
                        }}
                        leftSection={<Icon name="copy" size={14} />}
                      >
                        复制链接
                      </Button>
                      <Button
                        size="xs"
                        loading={row.handingOff}
                        disabled={row.added || row.handingOff}
                        onClick={() => {
                          void service.addDownload(row.sourceId).then(
                            () => setFeedback("已加入下载队列。"),
                            () => {},
                          );
                        }}
                        leftSection={<Icon name="download" size={14} />}
                      >
                        {row.added ? "已加入" : "加入下载"}
                      </Button>
                    </>
                  )}
                  {!active && (
                    <Button
                      size="xs"
                      variant="subtle"
                      disabled={handoff}
                      onClick={() => service.retry(row.sourceId)}
                    >
                      {row.stream ? "重新查找" : "重试"}
                    </Button>
                  )}
                </Group>
              </Group>
            </Paper>
          );
        })}
        {state.code && !rows.length && (
          <Text c="dimmed" size="sm">
            当前筛选下没有资源。
          </Text>
        )}
      </Stack>
    </Stack>
  );
}
