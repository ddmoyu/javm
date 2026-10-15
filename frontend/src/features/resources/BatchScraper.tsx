import { t, localizeOptions, useLocale } from "../../i18n/index";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Alert,
  Button,
  Group,
  Modal,
  Pagination,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useWorkspace } from "../../app/state";
import { Icon } from "../../components/icons";
import { Empty, Pill } from "../../components/ui";
import { activeScrape, scrapeLabels, scrapePhaseLabels } from "../../contracts/scraping";
import type { ScrapeTask } from "../../contracts/scraping";
import { enqueueLibraryScrapes } from "../../platform/neutralino/scraping";
import { serviceError } from "../../services/metadata/shared";
import { publicMessage } from "../../services/publicMessage";
const empty = {
  tasks: [] as ScrapeTask[],
  ready: true,
  available: false,
  paused: false,
  error: "",
};
const ignore = () => () => {};

export function BatchScraper({ onMatch }: { onMatch?: (task: ScrapeTask) => void }) {
  useLocale();
  const { scraping, libraryState, page, notice } = useWorkspace();
  const state = useSyncExternalStore(
    page === "scraper" && scraping ? scraping.subscribe : ignore,
    scraping?.getSnapshot ?? (() => empty),
  );
  const [opened, setOpened] = useState(false);
  const [scope, setScope] = useState("missing");
  const [directory, setDirectory] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ScrapeTask | null>(null);
  const [query, setQuery] = useState("");
  const creation = useRef<AbortController | null>(null);
  useEffect(() => () => creation.current?.abort(), []);
  const perform = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      const message = serviceError(reason);
      if (opened || editing) setError(message);
      else notice(message);
    } finally {
      setBusy(false);
    }
  };
  const count = state.tasks.length;
  const current = Math.min(pageNumber, Math.max(1, Math.ceil(count / 50)));
  const tasks = [...state.tasks].reverse().slice((current - 1) * 50, current * 50);
  return (
    <div className="fill-column">
      <Group justify="space-between" mb="md">
        <Text size="sm" c="dimmed" component="output" aria-live="polite">
          {t("{0} 个刮削任务 · {1} 个待完成", count, state.tasks.filter(activeScrape).length)}
        </Text>
        <Group gap="xs">
          <Button
            variant="default"
            size="xs"
            disabled={!state.available || !state.ready}
            onClick={() => {
              if (!scraping) return;
              const paused = !state.paused;
              scraping.pauseQueue(paused);
              notice(paused ? "队列已暂停，当前影片完成后停止调度。" : "队列已继续。");
            }}
            leftSection={<Icon name={state.paused ? "play" : "pause"} size={15} />}
          >
            {state.paused ? t("继续队列") : t("暂停队列")}
          </Button>
          <Button
            size="xs"
            disabled={!state.available || !state.ready}
            leftSection={<Icon name="plus" size={15} />}
            onClick={() => setOpened(true)}
          >
            {t("新建刮削")}
          </Button>
        </Group>
      </Group>
      {state.error && (
        <Alert color="red" role="alert" mb="sm">
          {t(publicMessage(state.error))}
        </Alert>
      )}
      <div className="table-panel">
        <Table stickyHeader verticalSpacing="sm" horizontalSpacing="md" layout="fixed" miw={660}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w="31%">{t("影片")}</Table.Th>
              <Table.Th w="15%">{t("番号")}</Table.Th>
              <Table.Th w="30%">{t("状态")}</Table.Th>
              <Table.Th w="24%">{t("操作")}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {tasks.map((task) => (
              <Table.Tr key={task.id}>
                <Table.Td>
                  <Text size="sm" fw={600} truncate>
                    {task.name}
                  </Text>
                  <Text size="xs" c="dimmed" truncate title={t(task.path)}>
                    {task.path || t("仅保存作品资料")}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {task.candidate?.code || task.query}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Pill
                    tone={
                      task.status === "completed"
                        ? "success"
                        : ["failed", "partial", "needsInput", "interrupted"].includes(task.status)
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {t(scrapeLabels[task.status])}
                  </Pill>
                  <Text size="xs" c="dimmed" mt={4} style={{ overflowWrap: "anywhere" }}>
                    {task.status === "running"
                      ? t(scrapePhaseLabels[task.phase])
                      : t(publicMessage(task.error))}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    {activeScrape(task) ? (
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        disabled={busy || (task.phase === "save" && task.status === "running")}
                        onClick={() => void perform(() => scraping!.cancel(task.id))}
                      >
                        {t("取消")}
                      </Button>
                    ) : (
                      <>
                        {task.status !== "completed" && (
                          <Button
                            size="compact-xs"
                            variant="subtle"
                            disabled={busy}
                            onClick={() => {
                              if (task.status === "needsInput") {
                                setEditing(task);
                                setQuery(task.query || "");
                              } else void perform(() => scraping!.retry(task.id));
                            }}
                          >
                            {task.status === "needsInput" ? t("确认番号") : t("重试刮削")}
                          </Button>
                        )}
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          disabled={busy}
                          onClick={() => onMatch?.(task)}
                        >
                          {t("手动匹配")}
                        </Button>
                        <Button
                          size="compact-xs"
                          color="gray"
                          variant="subtle"
                          disabled={busy}
                          onClick={() => void perform(() => scraping!.remove(task.id))}
                        >
                          {t("移除记录")}
                        </Button>
                      </>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {!count && (
          <Empty
            icon="scan"
            title={state.ready ? t("暂无刮削任务") : t("正在读取刮削任务")}
            description={
              state.available
                ? t("下载完成后自动入库并刮削，也可补全片库中的影片资料。")
                : t("请在 Windows 桌面应用中使用刮削。")
            }
          />
        )}
      </div>
      {count > 50 && (
        <Pagination
          size="sm"
          mt="sm"
          aria-label={t("刮削任务分页")}
          value={current}
          total={Math.ceil(count / 50)}
          onChange={setPageNumber}
        />
      )}
      <Modal
        opened={opened}
        onClose={() => {
          if (!busy) setOpened(false);
        }}
        title={t("新建批量刮削")}
        centered
        closeOnClickOutside={!busy}
        closeOnEscape={!busy}
      >
        <Stack>
          {error && (
            <Alert color="red" role="alert">
              {t(error)}
            </Alert>
          )}
          <Select
            label={t("刮削范围")}
            data={localizeOptions([
              { value: "missing", label: "缺失资料的影片" },
              { value: "all", label: "全部影片" },
            ])}
            value={scope}
            onChange={(value) => setScope(value || "missing")}
            disabled={busy}
            allowDeselect={false}
          />
          <Select
            label={t("媒体目录")}
            data={localizeOptions([
              { value: "", label: "全部目录" },
              ...libraryState.directories.map((item) => ({ value: item.path, label: item.path })),
            ])}
            value={directory}
            onChange={(value) => setDirectory(value || "")}
            disabled={busy}
            searchable
            allowDeselect={false}
          />
          <Text size="sm" c="dimmed">
            {t("补全缺失字段、封面并写入 NFO，保留已有资料和人工修改。")}
          </Text>
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => {
                creation.current?.abort();
                if (!busy) setOpened(false);
              }}
            >
              {busy ? t("停止添加") : t("取消")}
            </Button>
            <Button
              loading={busy}
              disabled={!libraryState.total}
              onClick={() =>
                void perform(async () => {
                  const abort = new AbortController();
                  creation.current = abort;
                  try {
                    await enqueueLibraryScrapes(
                      scraping!,
                      scope === "missing",
                      directory,
                      abort.signal,
                    );
                    setOpened(false);
                  } finally {
                    creation.current = null;
                  }
                })
              }
            >
              {t("开始刮削")}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={!!editing}
        onClose={() => !busy && setEditing(null)}
        title={t("确认影片番号")}
        centered
      >
        <Stack>
          {error && (
            <Alert color="red" role="alert">
              {t(error)}
            </Alert>
          )}
          <Text size="sm">{editing?.name}</Text>
          <TextInput
            label={t("番号")}
            value={query}
            maxLength={80}
            onChange={(event) => setQuery(event.currentTarget.value)}
            data-autofocus
            disabled={busy}
          />
          <Button
            loading={busy}
            disabled={!query.trim()}
            onClick={() =>
              void perform(async () => {
                await scraping!.retry(editing!.id, query);
                setEditing(null);
              })
            }
          >
            {t("按此番号刮削")}
          </Button>
        </Stack>
      </Modal>
    </div>
  );
}
