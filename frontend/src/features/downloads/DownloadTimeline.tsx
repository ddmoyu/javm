import { Alert, Group, Progress, Stack, Text, Timeline } from "@mantine/core";
import { Icon } from "../../components/icons";
import type { IconName } from "../../components/icons";
import { Pill } from "../../components/ui";
import type { Tone } from "../../components/ui";
import { downloadLabels } from "../../contracts/downloads";
import type { DownloadTask, DownloadStatus } from "../../contracts/downloads";
import { scrapeLabels, scrapePhaseLabels } from "../../contracts/scraping";
import type { ScrapeTask } from "../../contracts/scraping";
import { formatDownloadSize } from "../../services/downloads/progress";
import { publicMessage } from "../../services/publicMessage";

type StageState =
  | "waiting"
  | "running"
  | "completed"
  | "paused"
  | "failed"
  | "cancelled"
  | "warning"
  | "skipped"
  | "unknown";
interface Stage {
  id: "created" | "download" | "merge" | "scrape";
  title: string;
  icon: IconName;
  state: StageState;
  label: string;
  description: string;
  error?: string;
  progress?: number | null;
}
interface ScrapeQueue {
  ready: boolean;
  available: boolean;
  paused: boolean;
  error: string;
}

const appearance: Record<StageState, { color: string; tone: Tone; icon?: IconName }> = {
  waiting: { color: "gray", tone: "neutral" },
  running: { color: "rouge", tone: "accent" },
  completed: { color: "teal", tone: "success", icon: "check" },
  paused: { color: "champagne", tone: "warning", icon: "pause" },
  failed: { color: "red", tone: "danger", icon: "alert" },
  cancelled: { color: "gray", tone: "neutral", icon: "stop" },
  warning: { color: "champagne", tone: "warning", icon: "alert" },
  skipped: { color: "gray", tone: "neutral", icon: "minimize" },
  unknown: { color: "gray", tone: "neutral", icon: "info" },
};
const downloadStates: Record<DownloadStatus, StageState> = {
  queued: "waiting",
  preparing: "running",
  downloading: "running",
  merging: "running",
  paused: "paused",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

function downloadStage(task: DownloadTask, phase: DownloadTask["phase"]): Stage {
  // 下载与合并复用 progress 字段，只在当前阶段展示，不能当作整条流程的百分比。
  const merging = task.phase === "merge" || task.status === "merging";
  const completed = task.status === "completed" || (phase === "download" && merging);
  const current = !completed && (phase === "merge" ? merging : !merging);
  return {
    id: phase,
    title: phase === "download" ? "下载视频" : "合并与校验",
    icon: phase === "download" ? "download" : "merge",
    state: completed ? "completed" : current ? downloadStates[task.status] : "waiting",
    label: completed ? "已完成" : current ? downloadLabels[task.status] : "待执行",
    description:
      phase === "download"
        ? completed
          ? "媒体文件已下载。"
          : formatDownloadSize(task)
        : completed
          ? "视频已保存并通过校验。"
          : !current
            ? "下载完成后合并并校验视频。"
            : task.status === "failed" || task.status === "paused" || task.status === "cancelled"
              ? "已下载的媒体文件仍保留，可继续合并。"
              : "合并媒体文件并检查输出完整性。",
    error: current ? task.error : undefined,
    progress:
      current && task.status !== "queued" && task.status !== "preparing"
        ? task.progress
        : undefined,
  };
}

function scrapeStage(
  task: DownloadTask,
  scrape: ScrapeTask | undefined,
  queue: ScrapeQueue,
): Stage {
  const base: Stage = {
    id: "scrape",
    title: "刮削与入库",
    icon: "scan",
    state: "waiting",
    label: "待执行",
    description: "合并完成后检查入库，获取并保存资料。",
  };
  if (scrape) {
    const states: Record<ScrapeTask["status"], StageState> = {
      queued: queue.paused ? "paused" : "waiting",
      running: "running",
      completed: "completed",
      partial: "warning",
      failed: "failed",
      needsInput: "warning",
      cancelled: "cancelled",
      interrupted: "paused",
    };
    return {
      ...base,
      state: scrape.status === "queued" && queue.error ? "warning" : states[scrape.status],
      label:
        scrape.status === "queued" && queue.error
          ? "队列异常"
          : scrape.status === "queued" && queue.paused
            ? "队列已暂停"
            : scrapeLabels[scrape.status],
      description:
        scrape.status === "completed"
          ? "刮削与资料保存完成。"
          : scrape.status === "partial"
            ? "处理已结束，部分资料未能完整保存。"
            : scrape.status === "queued"
              ? "等待检查入库、获取资料并保存。"
              : `${scrape.status === "running" ? "当前阶段" : "停留阶段"}：${scrapePhaseLabels[scrape.phase]}`,
      error: scrape.error || (scrape.status === "queued" ? queue.error : undefined),
    };
  }
  if (task.scrapeHandoffError)
    return {
      ...base,
      state: "failed",
      label: "未能入队",
      description: "视频已保存，刮削任务未能加入队列。",
      error: task.scrapeHandoffError,
    };
  if (!queue.ready && queue.available)
    return {
      ...base,
      state: "unknown",
      label: "正在读取",
      description: "正在读取关联的刮削状态。",
    };
  if (!task.scrapeAfterDownload && !task.scrapeTaskId)
    return { ...base, state: "skipped", label: "未启用", description: "此任务未启用自动刮削。" };
  if (queue.error || !queue.available)
    return {
      ...base,
      state: "unknown",
      label: "暂不可用",
      description: "暂时无法读取刮削状态。",
      error: queue.error,
    };
  if (task.scrapeTaskId)
    return {
      ...base,
      state: "unknown",
      label: "记录不可用",
      description: "未找到关联的刮削记录，无法确认处理结果。",
    };
  return task.status === "completed"
    ? { ...base, label: "等待入队", description: "视频已保存，等待加入刮削队列。" }
    : base;
}

const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function DownloadTimeline({
  task,
  scrape,
  queue,
}: {
  task: DownloadTask;
  scrape?: ScrapeTask;
  queue: ScrapeQueue;
}) {
  const createdAt = new Date(task.createdAt);
  const stages: Stage[] = [
    {
      id: "created",
      title: "创建任务",
      icon: "plus",
      state: "completed",
      label: "已创建",
      description: Number.isNaN(createdAt.getTime())
        ? "任务已创建。"
        : dateFormat.format(createdAt),
    },
    downloadStage(task, "download"),
    downloadStage(task, "merge"),
    scrapeStage(task, scrape, queue),
  ];
  const active = stages.findLastIndex(
    (stage) => !["waiting", "skipped", "unknown"].includes(stage.state),
  );
  return (
    <Stack gap="sm">
      <Text size="sm" fw={600}>
        任务进度
      </Text>
      <Timeline
        component="ol"
        active={active}
        bulletSize={28}
        lineWidth={2}
        m={0}
        style={{ listStyle: "none" }}
        aria-label="任务阶段进度"
      >
        {stages.map((stage) => {
          const look = appearance[stage.state];
          const progress =
            stage.progress != null && Number.isFinite(stage.progress)
              ? Math.max(0, Math.min(100, stage.progress))
              : undefined;
          return (
            <Timeline.Item
              key={stage.id}
              component="li"
              aria-current={stage.state === "running" ? "step" : undefined}
              color={look.color}
              lineVariant={stage.state === "completed" ? "solid" : "dashed"}
              bullet={<Icon name={look.icon ?? stage.icon} size={14} />}
              title={
                <Group justify="space-between" gap="xs">
                  <Text size="sm" fw={600}>
                    {stage.title}
                  </Text>
                  <Pill tone={look.tone}>{stage.label}</Pill>
                </Group>
              }
              pb={stage.id === "scrape" ? 0 : "xs"}
            >
              <Text size="xs" c="dimmed" mt={4}>
                {stage.description}
              </Text>
              {progress !== undefined && (
                <Group gap="xs" mt="xs" wrap="nowrap">
                  <Progress
                    value={progress}
                    color={look.color}
                    size={5}
                    style={{ flex: 1 }}
                    aria-label={`${stage.title}进度`}
                  />
                  <Text size="xs" c="dimmed" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {progress.toFixed(1)}%
                  </Text>
                </Group>
              )}
              {stage.error && (
                <Alert color={stage.state === "failed" ? "red" : "yellow"} mt="xs" p="xs">
                  <Text size="xs" style={{ overflowWrap: "anywhere" }}>
                    {publicMessage(stage.error)}
                  </Text>
                </Alert>
              )}
            </Timeline.Item>
          );
        })}
      </Timeline>
    </Stack>
  );
}
