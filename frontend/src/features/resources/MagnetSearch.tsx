import { useState, useSyncExternalStore } from "react";
import {
  Alert,
  Badge,
  Button,
  Group,
  Pagination,
  Paper,
  Progress,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { Icon } from "../../components/icons";
import { Empty } from "../../components/ui";
import type { MagnetSearchService } from "../../services/magnets/MagnetSearchService";
import { magnetLimits } from "../../services/magnets/types";
import { copyText } from "../../platform/neutralino/clipboard";

function sizeLabel(bytes?: number) {
  if (bytes === undefined) return "大小未知";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = bytes > 0 ? Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024))) : 0;
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

/** 独立关键词搜索和影片详情共用应用级结果，不依赖资料服务是否返回。 */
export function MagnetSearchPanel({
  service,
  query,
  notice,
}: {
  service: MagnetSearchService;
  query?: string;
  notice: (message: string) => void;
}) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const current = query === undefined || service.matches(query);
  const [sort, setSort] = useState("default");
  const [page, setPage] = useState(1);
  const [copying, setCopying] = useState("");
  const rows = current
    ? [...state.rows].sort((a, b) =>
        sort === "size" ? (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) : 0,
      )
    : [];
  const pages = Math.max(1, Math.ceil(rows.length / 20));
  const shownPage = Math.min(page, pages);
  const busy = state.searching || state.stopping || state.cleanupPending;
  const failures = current ? state.sources.filter((source) => source.state === "failed") : [];
  const completed = current
    ? state.sources.filter((source) => ["succeeded", "failed"].includes(source.state)).length
    : 0;
  const run = () => {
    setPage(1);
    service.search(query ?? state.input, query !== undefined);
  };
  const act = async (id: string, action: "copy" | "open") => {
    try {
      if (action === "copy") {
        setCopying(id);
        await copyText(service.copyResult(id));
        notice("已复制磁力链接。");
      } else {
        await service.openResult(id);
        notice("已发送到系统关联的下载器，请在下载器中查看任务。");
      }
    } catch (error) {
      notice(error instanceof Error ? error.message : "操作失败，请重试。");
    } finally {
      setCopying("");
    }
  };
  return (
    <Stack gap="md" aria-label="磁力资源搜索">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          run();
        }}
      >
        <Group align="end">
          {query === undefined && (
            <TextInput
              aria-label="磁力搜索关键词"
              placeholder="输入番号或关键词搜索磁力"
              value={state.input}
              maxLength={120}
              onChange={(event) => service.setInput(event.currentTarget.value)}
              leftSection={<Icon name="magnet" size={16} />}
              style={{ flex: 1, minWidth: 180 }}
            />
          )}
          <Button
            type="submit"
            size="sm"
            variant="light"
            leftSection={<Icon name="search" size={16} />}
            disabled={!state.available || state.cleanupPending || !(query ?? state.input).trim()}
          >
            搜索磁力
          </Button>
          {state.searching && current && (
            <Button size="sm" variant="default" onClick={service.cancel}>
              取消搜索
            </Button>
          )}
        </Group>
      </form>
      {!state.available && <Alert>请在桌面应用中搜索磁力资源。</Alert>}
      {current && state.searching && (
        <Stack gap={6}>
          <Text size="sm" component="output" aria-live="polite">
            正在搜索磁力 · 已找到 {rows.length} 条 · {completed}/{state.sources.length}{" "}
            个搜索服务已完成
          </Text>
          <Progress
            value={state.sources.length ? (completed / state.sources.length) * 100 : 0}
            aria-label="磁力搜索进度"
          />
        </Stack>
      )}
      {state.stopping && (
        <Text size="sm" c="dimmed" component="output" aria-live="polite">
          正在停止上次请求…
        </Text>
      )}
      {current && state.cancelled && (
        <Text size="sm" component="output" aria-live="polite">
          已取消搜索，已找到的磁力仍可使用。
        </Text>
      )}
      {state.error && (current || state.cleanupPending || !state.query) && (
        <Alert color="red" role="alert">
          {state.error}
        </Alert>
      )}
      {state.cleanupPending && (
        <Button
          size="xs"
          variant="default"
          onClick={() => {
            void service.retryCleanup().catch(() => notice("清理仍未完成，请重试。"));
          }}
        >
          重试清理
        </Button>
      )}
      {!!failures.length && (
        <Alert color="yellow" role="alert">
          {failures.length} 个搜索服务未完成。
          {[...new Set(failures.map((source) => source.error))].join(" ")}
          <Button ml="sm" size="xs" variant="default" disabled={busy} onClick={service.retryFailed}>
            重试失败项
          </Button>
        </Alert>
      )}
      {!!rows.length && (
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            已找到 {rows.length} 条磁力
          </Text>
          <SegmentedControl
            size="xs"
            aria-label="磁力排序"
            value={sort}
            onChange={(value) => {
              setSort(value);
              setPage(1);
            }}
            data={[
              { value: "default", label: "默认" },
              { value: "size", label: "文件大小" },
            ]}
          />
        </Group>
      )}
      {!rows.length &&
        !(current && state.searching) &&
        !failures.length &&
        !state.cleanupPending && (
          <Empty
            icon="magnet"
            title={current && state.query ? "暂未找到磁力资源" : "搜索磁力资源"}
            description={
              current && state.query
                ? "可换用更短的关键词或稍后重试。"
                : "输入关键词或使用当前番号开始搜索。"
            }
          />
        )}
      <Stack gap="xs" aria-label="磁力结果">
        {rows.slice((shownPage - 1) * 20, shownPage * 20).map((row) => (
          <Paper key={row.id} withBorder p="sm" radius="md">
            <Stack gap="xs">
              <Text
                size="sm"
                fw={600}
                lineClamp={2}
                title={row.title}
                style={{ overflowWrap: "anywhere" }}
              >
                {row.title}
              </Text>
              <Group gap="xs">
                <Badge size="sm" variant="light">
                  磁力
                </Badge>
                <Text size="xs" c="dimmed">
                  {sizeLabel(row.sizeBytes)}
                </Text>
                {row.files !== undefined && (
                  <Text size="xs" c="dimmed">
                    {row.files} 个文件
                  </Text>
                )}
                <Text size="xs" c="dimmed">
                  做种：{row.seeders ?? "未知"}
                </Text>
                {row.date && (
                  <Text size="xs" c="dimmed">
                    {row.date}
                  </Text>
                )}
              </Group>
              <Group gap="xs">
                <Button
                  size="xs"
                  variant="default"
                  loading={copying === row.id}
                  disabled={!!copying}
                  leftSection={<Icon name="copy" size={14} />}
                  onClick={() => void act(row.id, "copy")}
                >
                  复制磁力
                </Button>
                <Button
                  size="xs"
                  variant="light"
                  loading={state.opening === row.id}
                  disabled={!!state.opening}
                  leftSection={<Icon name="download" size={14} />}
                  onClick={() => void act(row.id, "open")}
                >
                  {state.sent.includes(row.id) ? "再次打开下载器" : "打开外部下载器"}
                </Button>
              </Group>
            </Stack>
          </Paper>
        ))}
      </Stack>
      {pages > 1 && (
        <Pagination value={shownPage} onChange={setPage} total={pages} aria-label="磁力结果分页" />
      )}
      {current &&
        state.sources.some((source) => source.hasMore) &&
        rows.length < magnetLimits.rows && (
          <Button size="sm" variant="default" disabled={busy} onClick={service.loadMore}>
            加载更多磁力
          </Button>
        )}
      {current &&
        (rows.length >= magnetLimits.rows ||
          state.sources.some((source) => source.page >= magnetLimits.pages)) && (
          <Text size="xs" c="dimmed">
            已达到本次搜索上限，可缩小关键词范围后重新搜索。
          </Text>
        )}
    </Stack>
  );
}
