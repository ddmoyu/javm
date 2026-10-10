import { useState, useSyncExternalStore } from "react";
import {
  ActionIcon,
  Alert,
  Button,
  Drawer,
  Group,
  Menu,
  Modal,
  Pagination,
  Progress,
  Select,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { useWorkspace } from "../../app/state";
import { canResume, downloadLabels, isRunning } from "../../contracts/downloads";
import type { DownloadTask } from "../../contracts/downloads";
import { describeError } from "../../services/downloads/DownloadService";
import { formatBytes, formatDownloadSize } from "../../services/downloads/progress";
import { Icon } from "../../components/icons";
import { CountTabs, Empty, Pill } from "../../components/ui";
import { activeScrape, scrapeLabels, scrapePhaseLabels } from "../../contracts/scraping";
import type { ScrapeTask } from "../../contracts/scraping";

const ignoreDownloadUpdates = () => () => {};
const pageSize = 50;
const emptyScrapes = { tasks: [] as ScrapeTask[], ready: false, error: "" };

export function Downloads() {
  const { downloads, scraping, add, notice, page, playSource, go, showScrapeQueue } =
    useWorkspace();
  const scrapeState = useSyncExternalStore(
    page === "downloads" && scraping ? scraping.subscribe : ignoreDownloadUpdates,
    scraping?.getSnapshot ?? (() => emptyScrapes),
  );
  const byDownload = new Map(
    scrapeState.tasks.filter((task) => task.downloadId).map((task) => [task.downloadId, task]),
  );
  const needsScrape = (task: DownloadTask) =>
    byDownload.has(task.id)
      ? ["failed", "partial", "needsInput", "interrupted"].includes(byDownload.get(task.id)!.status)
      : !!task.scrapeHandoffError;
  const state = useSyncExternalStore(
    page === "downloads" ? downloads.subscribe : ignoreDownloadUpdates,
    downloads.getSnapshot,
  );
  const tasks = state.tasks;
  const [filter, setFilter] = useState("all");
  const [resultPage, setResultPage] = useState(1);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const active = (task: DownloadTask) => isRunning(task.status) || task.status === "queued";
  const shown = tasks.filter(
    (task) =>
      filter === "all" ||
      (filter === "active"
        ? active(task)
        : filter === "errors"
          ? task.status === "failed" || needsScrape(task)
          : task.status === filter),
  );
  const totalPages = Math.max(1, Math.ceil(shown.length / pageSize));
  const currentPage = Math.min(resultPage, totalPages);
  const visibleTasks = shown.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const detail = tasks.find((task) => task.id === detailId);
  const perform = async (id: string, action: () => Promise<void>) => {
    if (busy.has(id)) return;
    setBusy((previous) => new Set(previous).add(id));
    try {
      await action();
    } catch (error) {
      notice(describeError(error));
    } finally {
      setBusy((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  };
  const primaryAction = (task: DownloadTask) => {
    if (active(task))
      return (
        <Button
          size="compact-xs"
          variant="subtle"
          loading={busy.has(task.id)}
          onClick={() => void perform(task.id, () => downloads.pause(task.id))}
        >
          暂停
        </Button>
      );
    if (canResume(task.status))
      return (
        <Button
          size="compact-xs"
          variant="subtle"
          loading={busy.has(task.id)}
          onClick={() => void perform(task.id, () => downloads.resume(task.id))}
        >
          {task.status === "failed" ? (task.phase === "merge" ? "重试合并" : "重试") : "继续"}
        </Button>
      );
    if (task.status === "completed")
      return (
        <Button
          size="compact-xs"
          variant="subtle"
          onClick={() => playSource(task.output, { title: task.name })}
        >
          播放
        </Button>
      );
    return null;
  };
  return (
    <div className="fill-column">
      <div className="page-toolbar">
        <Group justify="space-between" wrap="wrap" align="flex-end">
          <CountTabs
            label="下载任务筛选"
            value={filter}
            onChange={(value) => {
              setFilter(value);
              setResultPage(1);
            }}
            items={[
              ["all", "全部任务", tasks.length],
              ["active", "进行中", tasks.filter(active).length],
              ["paused", "已暂停", tasks.filter((task) => task.status === "paused").length],
              [
                "errors",
                "需处理",
                tasks.filter((task) => task.status === "failed" || needsScrape(task)).length,
              ],
              ["completed", "已完成", tasks.filter((task) => task.status === "completed").length],
            ]}
          />
          <Group gap={8} pb={8}>
            <Select
              aria-label="同时下载数"
              size="xs"
              w={132}
              value={String(state.settings.concurrency)}
              data={[1, 2, 3, 4, 5].map((count) => ({
                value: String(count),
                label: `${count} 个同时下载`,
              }))}
              allowDeselect={false}
              disabled={
                busy.has("concurrency") || !state.available || !state.ready || !!state.error
              }
              onChange={(value) => {
                if (value)
                  void perform("concurrency", () =>
                    downloads.updateSettings({
                      ...downloads.getSnapshot().settings,
                      concurrency: Number(value),
                    }),
                  );
              }}
            />
            <Button
              size="xs"
              variant="default"
              disabled={!tasks.some(active)}
              loading={busy.has("all")}
              leftSection={<Icon name="pause" size={15} />}
              onClick={() => void perform("all", () => downloads.pauseAll())}
            >
              全部暂停
            </Button>
            <Button
              size="xs"
              leftSection={<Icon name="plus" size={15} />}
              onClick={() => add("download")}
            >
              新建下载
            </Button>
          </Group>
        </Group>
        {state.error && (
          <Alert color="red" title="下载服务不可用" role="alert">
            <Text size="sm">{state.error}</Text>
            <Button
              mt="xs"
              size="xs"
              variant="light"
              loading={busy.has("recover")}
              disabled={!state.available || !state.ready}
              onClick={() =>
                void perform("recover", async () => {
                  await downloads.recover();
                  notice("下载服务已恢复，未完成任务已暂停，可继续下载。");
                })
              }
            >
              恢复下载服务
            </Button>
          </Alert>
        )}
        {scrapeState.error && (
          <Alert color="red" title="刮削服务不可用" role="alert">
            {scrapeState.error}
          </Alert>
        )}
        {!state.available && (
          <Text size="xs" c="dimmed">
            下载需在 Windows 桌面应用中进行。
          </Text>
        )}
      </div>
      <div className="table-panel" aria-label="下载任务列表">
        <Table
          stickyHeader
          highlightOnHover
          verticalSpacing={10}
          horizontalSpacing="md"
          layout="fixed"
          miw={680}
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th w="30%">影片 / 任务</Table.Th>
              <Table.Th w="13%">状态</Table.Th>
              <Table.Th w="22%">进度 / 文件大小</Table.Th>
              <Table.Th w="17%">速度 / 剩余</Table.Th>
              <Table.Th w="18%">操作</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {visibleTasks.map((task) => (
              <Table.Tr key={task.id}>
                <Table.Td>
                  <Text size="sm" fw={600} truncate>
                    {task.name}
                  </Text>
                  <Text size="xs" c="dimmed" truncate title={task.directory}>
                    {task.directory}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Pill>
                    {task.status === "failed"
                      ? task.phase === "merge"
                        ? "合并失败"
                        : "下载失败"
                      : downloadLabels[task.status]}
                  </Pill>
                  {task.status === "completed" && (
                    <Text size="xs" c={needsScrape(task) ? "red" : "dimmed"} mt={4}>
                      {byDownload.get(task.id)
                        ? byDownload.get(task.id)!.status === "running"
                          ? scrapePhaseLabels[byDownload.get(task.id)!.phase]
                          : scrapeLabels[byDownload.get(task.id)!.status]
                        : task.scrapeHandoffError
                          ? "刮削未入队"
                          : task.scrapeAfterDownload && !task.scrapeTaskId
                            ? "等待刮削"
                            : ""}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Progress
                    aria-label={`${task.name}进度`}
                    value={task.progress ?? 0}
                    animated={isRunning(task.status) && task.progress === null}
                    size={4}
                  />
                  <Text size="xs" c="dimmed" mt={4}>
                    {task.progress === null ? "等待进度" : `${task.progress.toFixed(1)}%`}
                  </Text>
                  <Text size="xs" c="dimmed" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {formatDownloadSize(task)}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs">{task.speed ? `${formatBytes(task.speed)}/s` : "—"}</Text>
                  <Text size="xs" c="dimmed">
                    {task.speed > 0 && task.total > task.downloaded
                      ? `约 ${Math.ceil((task.total - task.downloaded) / task.speed)} 秒`
                      : "—"}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap={2} wrap="wrap">
                    {primaryAction(task)}
                    <Menu position="bottom-end" withinPortal>
                      <Menu.Target>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={`${task.name}更多操作`}
                        >
                          <Icon name="dots" />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          leftSection={<Icon name="info" />}
                          onClick={() => setDetailId(task.id)}
                        >
                          任务详情
                        </Menu.Item>
                        <Menu.Item
                          leftSection={<Icon name="folder" />}
                          onClick={() => void perform(task.id, () => downloads.open(task.id, true))}
                        >
                          打开目录
                        </Menu.Item>
                        {task.status === "completed" && scraping && (
                          <Menu.Item
                            leftSection={<Icon name="scan" />}
                            disabled={
                              !!byDownload.get(task.id) && activeScrape(byDownload.get(task.id)!)
                            }
                            onClick={() =>
                              void perform(task.id, async () => {
                                const job = byDownload.get(task.id);
                                if (job?.status === "needsInput") {
                                  if (showScrapeQueue) showScrapeQueue();
                                  else go("scraper");
                                  return;
                                }
                                if (job) await scraping.retry(job.id);
                                else await scraping.enqueueDownload(task);
                              })
                            }
                          >
                            {byDownload.get(task.id)?.status === "needsInput"
                              ? "确认刮削资料"
                              : "重试刮削"}
                          </Menu.Item>
                        )}
                        {task.status !== "completed" && task.status !== "cancelled" && (
                          <Menu.Item
                            disabled={busy.has(task.id)}
                            leftSection={<Icon name="stop" />}
                            onClick={() => void perform(task.id, () => downloads.cancel(task.id))}
                          >
                            停止任务
                          </Menu.Item>
                        )}
                        <Menu.Divider />
                        <Menu.Item
                          color="red"
                          leftSection={<Icon name="trash" />}
                          onClick={() => setRemoveId(task.id)}
                        >
                          移除记录
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {!shown.length && (
          <Empty
            icon="download"
            title={
              !state.ready
                ? "正在读取下载任务"
                : filter === "all"
                  ? "还没有下载任务"
                  : "暂无此类任务"
            }
            description={
              filter === "all"
                ? "添加 MP4 或 m3u8 链接，在这里管理下载与合并。"
                : "任务状态发生变化后会显示在这里。"
            }
          >
            {filter === "all" && (
              <Button variant="light" onClick={() => add("download")}>
                新建下载
              </Button>
            )}
          </Empty>
        )}
      </div>
      {totalPages > 1 && (
        <Group justify="space-between" py="xs" px="md">
          <Text size="xs" c="dimmed">
            共 {shown.length} 个任务，每页 {pageSize} 个
          </Text>
          <Pagination
            aria-label="下载任务分页"
            size="sm"
            total={totalPages}
            value={currentPage}
            onChange={setResultPage}
          />
        </Group>
      )}
      <Drawer
        opened={!!detail}
        onClose={() => setDetailId(null)}
        title="任务详情"
        position="right"
        size={500}
      >
        {detail && (
          <Stack>
            <Text fw={600}>{detail.name}</Text>
            <Group>
              <Pill>{downloadLabels[detail.status]}</Pill>
              <Text size="xs" c="dimmed">
                {detail.kind === "hls" ? "m3u8 / HLS" : "MP4 直链"}
              </Text>
            </Group>
            <Progress value={detail.progress ?? 0} />
            <Text size="sm">
              {detail.status === "completed" ? "文件大小" : "已下载 / 总大小"}：
              {formatDownloadSize(detail)}
            </Text>
            <Text size="sm" style={{ overflowWrap: "anywhere" }}>
              {detail.output}
            </Text>
            {detail.error && (
              <Alert color="red" title={detail.phase === "merge" ? "合并未完成" : "任务未完成"}>
                {detail.error}
              </Alert>
            )}
            {detail.status === "completed" && needsScrape(detail) && (
              <Alert color="yellow" title="视频已保存，刮削需要处理">
                {byDownload.has(detail.id)
                  ? byDownload.get(detail.id)!.error
                  : detail.scrapeHandoffError}
              </Alert>
            )}
            {detail.phase === "merge" && detail.status !== "completed" && (
              <Text size="xs" c="dimmed">
                已下载的媒体文件仍保留，继续时只重试合并。
              </Text>
            )}
            <Group>
              {primaryAction(detail)}
              <Button
                variant="default"
                onClick={() => void perform(detail.id, () => downloads.open(detail.id, true))}
              >
                打开目录
              </Button>
            </Group>
          </Stack>
        )}
      </Drawer>
      <Modal opened={!!removeId} onClose={() => setRemoveId(null)} title="移除下载记录" centered>
        <Stack>
          <Text size="sm">已下载的视频和临时文件会保留；正在运行的任务会先停止。</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRemoveId(null)}>
              取消
            </Button>
            <Button
              color="red"
              loading={!!removeId && busy.has(removeId)}
              onClick={() => {
                if (removeId)
                  void perform(removeId, async () => {
                    await downloads.remove(removeId);
                    setRemoveId(null);
                  });
              }}
            >
              移除记录
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}
