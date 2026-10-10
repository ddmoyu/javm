import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  Progress,
  SegmentedControl,
  Stack,
  Text,
} from "@mantine/core";
import { Icon } from "../../components/icons";
import { Empty } from "../../components/ui";
import type { ResourceSearchService } from "../../services/streamResolution/ResourceSearchService";
import type { SavedResource } from "../../services/streamResolution/archive";
import { normalizeCode } from "../../services/streamResolution/sources";
import {
  mergeResourceLinks,
  resourceLinkKey as linkKey,
  resourceVideoTrack as videoTrack,
} from "../../services/streamResolution/resourceLinks";
import type { ResourceLinkRow } from "../../services/streamResolution/resourceLinks";

interface LookupProps {
  service: ResourceSearchService;
  code: string;
  workId?: string;
}

export function ResourceLookupButton({
  service,
  code,
  workId,
  onStart,
  disabled = false,
}: LookupProps & { onStart?: () => void; disabled?: boolean }) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const searching = service.matches(code, workId) && state.searching;
  let valid = true;
  try {
    normalizeCode(code);
  } catch {
    valid = false;
  }
  return (
    <Button
      size="sm"
      variant="light"
      leftSection={<Icon name="link" size={16} />}
      loading={searching}
      disabled={
        disabled ||
        searching ||
        !valid ||
        !state.available ||
        state.restoring ||
        !!state.cleanupPending
      }
      onClick={() => {
        onStart?.();
        service.search(code, workId);
      }}
    >
      获取资源链接
    </Button>
  );
}

const durationLabel = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  return minutes + ":" + String(Math.floor(seconds % 60)).padStart(2, "0");
};

/** 只展示去重后的资源链接；来源和失败记录留在应用服务内部。 */
export function ResourceSearchPanel({
  service,
  code,
  workId,
}: LookupProps) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const current = service.matches(code, workId);
  const searching = current && state.searching;
  const [saved, setSaved] = useState<SavedResource[]>([]);
  const [loadedHistory, setLoadedHistory] = useState("");
  const [readError, setReadError] = useState("");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [revision, setRevision] = useState(0);
  const historyKey = JSON.stringify([code, workId, state.archiveRevision, revision]);
  const loading = loadedHistory !== historyKey;
  const [sort, setSort] = useState("recommended");
  const [busy, setBusy] = useState<string | null>(null);
  const acting = useRef(false);
  const [added, setAdded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let mounted = true;
    void service
      .readSaved(code, workId)
      .then(
        (rows) => {
          if (mounted) {
            setSaved(rows);
            setReadError("");
          }
        },
        () => {
          if (mounted) setReadError("资源历史读取失败，请重试。");
        },
      )
      .finally(() => {
        if (mounted) setLoadedHistory(historyKey);
      });
    return () => {
      mounted = false;
    };
  }, [service, code, workId, historyKey]);

  const rows = mergeResourceLinks(current ? state.rows : [], saved, code, workId).sort((a, b) =>
    sort === "quality"
      ? (videoTrack(b)?.height ?? 0) - (videoTrack(a)?.height ?? 0)
      : sort === "date"
        ? b.stream.checkedAt - a.stream.checkedAt
        : 0,
  );

  const use = async (row: ResourceLinkRow, action: "copy" | "download" | "remove") => {
    if (acting.current) return;
    acting.current = true;
    const key = linkKey(row.stream.manifestUrl);
    setBusy(key);
    setError("");
    setFeedback("");
    try {
      if (action === "remove") {
        for (const id of row.savedIds) await service.removeSaved(id);
        if (service.matches(code, workId)) service.dismissResult(row.stream.manifestUrl);
        setSaved((items) => items.filter((item) => !row.savedIds.includes(item.id)));
        setFeedback("已移除保存的链接。");
        return;
      }
      if (action === "download" && (row.added || added.has(key))) return;
      const live = row.liveSourceIds[0];
      let url = "";
      if (live && service.matches(code, workId) && action === "download") {
        await service.addDownload(live);
      } else if (live && service.matches(code, workId)) {
        url = await service.copyResult(live);
      } else {
        url = await service.useSaved(row, action, workId);
      }
      if (action === "copy") {
        await navigator.clipboard.writeText(url);
        setFeedback("已复制资源链接。");
      } else {
        setAdded((value) => new Set(value).add(key));
        setFeedback("已加入下载队列。");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败，请重试。");
    } finally {
      acting.current = false;
      setBusy(null);
    }
  };

  return (
    <section aria-label={code + " 资源链接"}>
      <Stack gap="md">
        <Group justify="space-between">
          <Group gap="xs">
            <ResourceLookupButton service={service} code={code} workId={workId} disabled={!!busy} />
            {searching && (
              <Button size="sm" variant="default" onClick={service.cancel}>
                取消查找
              </Button>
            )}
          </Group>
          {!!rows.length && (
            <SegmentedControl
              size="xs"
              aria-label="资源排序"
              value={sort}
              onChange={setSort}
              data={[
                { value: "recommended", label: "默认" },
                { value: "quality", label: "分辨率" },
                { value: "date", label: "最近校验" },
              ]}
            />
          )}
        </Group>
        {!state.available && <Alert>请在 Windows 桌面应用中获取资源链接。</Alert>}
        {!code && (
          <Text size="sm" c="dimmed">
            影片尚未提供番号，补全资料后即可获取资源链接。
          </Text>
        )}
        {searching && (
          <Stack gap={6}>
            <Text size="sm" component="output" aria-live="polite">
              正在获取资源链接 · 已找到 {rows.length} 个
            </Text>
            <Progress
              value={state.total ? (state.completed / state.total) * 100 : 0}
              aria-label="资源查找进度"
            />
          </Stack>
        )}
        {current && state.cancelled && !searching && (
          <Text size="sm" component="output" aria-live="polite">
            已停止查找，找到的链接仍可使用。
          </Text>
        )}
        {state.storageError && (
          <Alert color="yellow" role="alert">
            {state.storageError}
          </Alert>
        )}
        {current && state.error && (
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
                void service.retryCleanup().catch(() => setError("清理仍未完成，请重试。"));
              }}
            >
              重试清理
            </Button>
          </Alert>
        )}
        {!loading && readError && (
          <Alert color="yellow" role="alert">
            {readError}
            <Button
              ml="sm"
              size="xs"
              variant="default"
              onClick={() => setRevision((value) => value + 1)}
            >
              重新读取
            </Button>
          </Alert>
        )}
        {error && (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        {feedback && (
          <Text size="sm" component="output" aria-live="polite">
            {feedback}
          </Text>
        )}
        {loading && !rows.length && (
          <Text size="sm" component="output" aria-live="polite">
            正在读取已保存链接…
          </Text>
        )}
        {!loading && !searching && !rows.length && (
          <Empty
            icon="link"
            title={current && state.total ? "暂未找到可用链接" : "暂无资源链接"}
            description={
              current && state.total ? "可稍后重新获取。" : "点击“获取资源链接”开始查找。"
            }
          />
        )}
        <Stack gap="sm" aria-label="资源结果">
          {rows.map((row, index) => {
            const track = videoTrack(row);
            const key = linkKey(row.stream.manifestUrl);
            const downloaded = row.added || added.has(key);
            return (
              <Paper key={key} withBorder p="md" radius="md">
                <Stack gap="sm">
                  <Group gap="xs">
                    <Text size="sm" fw={600}>
                      资源 {index + 1}
                    </Text>
                    <Badge variant="light">HLS</Badge>
                    <Badge variant="light" color={track?.height ? undefined : "gray"}>
                      {track?.height ? track.height + "p" : "分辨率未知"}
                    </Badge>
                    {!!track?.width && !!track.height && (
                      <Text size="xs" c="dimmed">
                        {track.width} × {track.height}
                      </Text>
                    )}
                    {!!track?.duration && (
                      <Text size="xs" c="dimmed">
                        {durationLabel(track.duration)}
                      </Text>
                    )}
                  </Group>
                  <Text
                    size="xs"
                    ff="monospace"
                    style={{ overflowWrap: "anywhere", userSelect: "text" }}
                  >
                    {row.stream.manifestUrl}
                  </Text>
                  <Group gap="xs">
                    <Button
                      size="xs"
                      variant="default"
                      loading={busy === key}
                      disabled={!!busy}
                      leftSection={<Icon name="copy" size={14} />}
                      onClick={() => void use(row, "copy")}
                    >
                      复制链接
                    </Button>
                    <Button
                      size="xs"
                      disabled={!!busy || downloaded}
                      leftSection={<Icon name="download" size={14} />}
                      onClick={() => void use(row, "download")}
                    >
                      {downloaded ? "已加入下载" : "加入下载"}
                    </Button>
                    {!!row.savedIds.length && (
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        disabled={!!busy || searching || state.busy}
                        onClick={() => void use(row, "remove")}
                      >
                        移除链接
                      </Button>
                    )}
                  </Group>
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      </Stack>
    </section>
  );
}
