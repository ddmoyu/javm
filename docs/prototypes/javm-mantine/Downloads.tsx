import { useLayoutEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  DataList,
  Drawer,
  Group,
  Menu,
  Modal,
  Progress,
  Stack,
  Table,
  Text,
  TextInput,
  Timeline,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { taskLabels } from "./data";
import type { DownloadTask, TaskStatus } from "./data";
import { usePrototype } from "./state";
import { Poster } from "./Cover";
import { Icon } from "./icons";
import { CountTabs, Empty, IconButton, Pill } from "./ui";
import type { Tone } from "./ui";
import { ObjectMenu, ObjectMenuButton, objectMenuKey } from "./ObjectMenu";

type Filter = "all" | "active" | "paused" | "errors" | "completed";
const isActive = (status: TaskStatus) =>
  ["downloading", "merging", "scraping", "queued"].includes(status);
const taskTone = (status: TaskStatus): Tone =>
  status === "failed" || status === "scrapeFailed"
    ? "danger"
    : status === "completed"
      ? "success"
      : isActive(status)
        ? "accent"
        : "neutral";

export function Downloads() {
  const { tasks, setTasks, add, notice, films } = usePrototype();
  const [filter, setFilter] = useState<Filter>("all");
  const [detailId, setDetailId] = useState<number | null>(null);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [editTask, setEditTask] = useState<DownloadTask | null>(null);
  const [editedName, setEditedName] = useState("");
  const [editedPath, setEditedPath] = useState("");
  const tableRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    tableRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [filter]);
  const detail = tasks.find((task) => task.id === detailId);
  const changeStatus = (id: number, status: TaskStatus) =>
    setTasks((previous) => previous.map((task) => (task.id === id ? { ...task, status } : task)));
  const count = (test: (task: DownloadTask) => boolean) => tasks.filter(test).length;
  const shown = tasks.filter(
    (task) =>
      filter === "all" ||
      (filter === "active" && isActive(task.status)) ||
      (filter === "paused" && task.status === "paused") ||
      (filter === "errors" && ["failed", "scrapeFailed"].includes(task.status)) ||
      (filter === "completed" && task.status === "completed"),
  );
  const action = (task: DownloadTask) => {
    if (task.status === "downloading" || task.status === "queued")
      return (
        <IconButton
          icon="pause"
          label={`暂停 ${task.name}`}
          onClick={() => changeStatus(task.id, "paused")}
        />
      );
    if (task.status === "paused" || task.status === "cancelled")
      return (
        <IconButton
          icon="play"
          label={`继续 ${task.name}`}
          onClick={() => changeStatus(task.id, "downloading")}
        />
      );
    if (task.status === "failed" || task.status === "scrapeFailed")
      return (
        <Button
          variant="light"
          size="compact-xs"
          onClick={() => {
            changeStatus(task.id, task.status === "scrapeFailed" ? "scraping" : "downloading");
            notice(task.status === "scrapeFailed" ? "正在重试资料刮削" : "下载已继续");
          }}
        >
          {task.status === "scrapeFailed" ? "重试刮削" : "重试"}
        </Button>
      );
    if (task.status === "completed")
      return (
        <IconButton
          icon="folder"
          label={`查看 ${task.name} 保存位置`}
          onClick={() => setDetailId(task.id)}
        />
      );
    return (
      <IconButton
        icon="stop"
        label={`停止 ${task.name}`}
        onClick={() => changeStatus(task.id, "cancelled")}
      />
    );
  };
  const taskMenu = (task: DownloadTask) => (
    <>
      <Menu.Label>{task.name}</Menu.Label>
      <Menu.Item leftSection={<Icon name="list" />} onClick={() => setDetailId(task.id)}>
        任务详情
      </Menu.Item>
      {["downloading", "queued"].includes(task.status) && (
        <Menu.Item
          leftSection={<Icon name="pause" />}
          onClick={() => changeStatus(task.id, "paused")}
        >
          暂停下载
        </Menu.Item>
      )}
      {["paused", "cancelled", "failed", "scrapeFailed"].includes(task.status) && (
        <Menu.Item
          leftSection={
            <Icon
              name={task.status === "failed" || task.status === "scrapeFailed" ? "refresh" : "play"}
            />
          }
          onClick={() =>
            changeStatus(task.id, task.status === "scrapeFailed" ? "scraping" : "downloading")
          }
        >
          {task.status === "scrapeFailed"
            ? "重试刮削"
            : task.status === "failed"
              ? "重试下载"
              : "继续下载"}
        </Menu.Item>
      )}
      <Menu.Item
        leftSection={<Icon name="edit" />}
        onClick={() => {
          setEditTask(task);
          setEditedName(task.name);
          setEditedPath(task.path);
        }}
      >
        改名与保存位置
      </Menu.Item>
      <Menu.Item
        leftSection={<Icon name="stop" />}
        disabled={["completed", "cancelled"].includes(task.status)}
        onClick={() => changeStatus(task.id, "cancelled")}
      >
        停止任务
      </Menu.Item>
      <Menu.Divider />
      <Menu.Item
        color="red"
        leftSection={<Icon name="trash" />}
        onClick={() => {
          setTasks((previous) => previous.filter((item) => item.id !== task.id));
          notice("任务记录已移除，文件已保留");
        }}
      >
        移除任务记录
      </Menu.Item>
    </>
  );
  return (
    <div className="fill-column">
      <div className="page-toolbar">
        <Group justify="space-between" wrap="nowrap" align="flex-end">
          <CountTabs
            label="下载任务筛选"
            value={filter}
            onChange={setFilter}
            items={[
              ["all", "全部任务", tasks.length],
              ["active", "进行中", count((task) => isActive(task.status))],
              ["paused", "已暂停", count((task) => task.status === "paused")],
              [
                "errors",
                "需处理",
                count((task) => ["failed", "scrapeFailed"].includes(task.status)),
              ],
              ["completed", "已完成", count((task) => task.status === "completed")],
            ]}
          />
          <Group gap={8} pb={8} wrap="nowrap">
            <Button
              size="xs"
              variant="default"
              leftSection={<Icon name="pause" size={15} />}
              disabled={
                !tasks.some((task) => task.status === "downloading" || task.status === "queued")
              }
              onClick={() =>
                setTasks((previous) =>
                  previous.map((task) =>
                    task.status === "downloading" || task.status === "queued"
                      ? { ...task, status: "paused" }
                      : task,
                  ),
                )
              }
            >
              暂停下载
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
      </div>
      <div className="table-panel" ref={tableRef} aria-label="下载任务列表">
        <Table
          stickyHeader
          highlightOnHover
          verticalSpacing={10}
          horizontalSpacing="md"
          layout="fixed"
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th w="34%">影片 / 任务</Table.Th>
              <Table.Th w="15%">状态</Table.Th>
              <Table.Th w="19%">进度</Table.Th>
              <Table.Th w="17%">速度 / 剩余时间</Table.Th>
              <Table.Th w="15%">操作</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {shown.map((task) => {
              const film = films.find((item) => item.id === task.filmId);
              return (
                <ObjectMenu key={task.id} items={taskMenu(task)}>
                  <Table.Tr
                    className="clickable-row"
                    tabIndex={0}
                    aria-selected={focusedId === task.id}
                    data-focused={focusedId === task.id || undefined}
                    onClick={() => setFocusedId(task.id)}
                    onContextMenu={(event) => {
                      setFocusedId(task.id);
                      event.currentTarget.focus();
                    }}
                    onDoubleClick={(event) => {
                      if (!(event.target as HTMLElement).closest("button")) setDetailId(task.id);
                    }}
                    onKeyDown={(event) => {
                      if (objectMenuKey(event)) return;
                      if (event.key === "Enter" && event.target === event.currentTarget)
                        setDetailId(task.id);
                    }}
                  >
                    <Table.Td>
                      <Group gap="sm" wrap="nowrap">
                        <span className="mini-poster">
                          {film ? <Poster film={film} compact /> : <Icon name="play" />}
                        </span>
                        <UnstyledButton
                          onClick={() => setDetailId(task.id)}
                          style={{ minWidth: 0 }}
                        >
                          <Text size="sm" fw={600} truncate>
                            {task.name}
                          </Text>
                          <Text size="xs" c="dimmed" truncate>
                            {task.status === "scrapeFailed"
                              ? "视频已保存 · 仅资料补全失败"
                              : "MP4 · " + (task.quality ?? film?.quality ?? "自动画质")}
                          </Text>
                        </UnstyledButton>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Pill tone={taskTone(task.status)}>{taskLabels[task.status]}</Pill>
                      {task.status === "failed" && (
                        <Text size="xs" c="red.4" mt={4}>
                          连接超时
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Group justify="space-between" mb={6}>
                        <Text size="xs">{task.progress}%</Text>
                        <Text size="xs" c="dimmed">
                          {task.progress === 100 ? "已下载" : "下载进度"}
                        </Text>
                      </Group>
                      <Progress
                        value={task.progress}
                        size={4}
                        color={
                          task.status === "failed"
                            ? "red"
                            : task.status === "paused"
                              ? "gray"
                              : "rouge"
                        }
                        animated={task.status === "downloading"}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" ff="monospace">
                        {task.status === "downloading" ? (task.speed ?? "正在连接") : "—"}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {task.status === "downloading"
                          ? (task.remaining ?? "正在估算剩余时间")
                          : task.status === "merging"
                            ? "正在合并分片"
                            : task.status === "scraping"
                              ? "正在补全资料"
                              : ""}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={2} wrap="nowrap">
                        {action(task)}
                        <ObjectMenuButton label={`${task.name} 更多操作`} />
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                </ObjectMenu>
              );
            })}
          </Table.Tbody>
        </Table>
        {!shown.length && (
          <Empty
            title="这里还没有任务"
            description="新建下载，或切换到其他任务状态。"
            icon="download"
          />
        )}
      </div>

      <Drawer
        opened={!!detail}
        onClose={() => setDetailId(null)}
        position="right"
        title="任务详情"
        size={460}
      >
        {detail && (
          <Stack gap="md">
            <div>
              <Title order={3} fz={18} mb={6}>
                {detail.name}
              </Title>
              <Pill tone={taskTone(detail.status)}>{taskLabels[detail.status]}</Pill>
            </div>
            <DataList orientation="horizontal" labelWidth={80} size="sm">
              {[
                ["保存到", detail.path],
                ["创建时间", "今天 14:20"],
                ["已下载", `${detail.progress}%`],
                ["下载方式", "自动选择工具"],
              ].map(([label, value]) => (
                <DataList.Item key={label}>
                  <DataList.ItemLabel>{label}</DataList.ItemLabel>
                  <DataList.ItemValue ff={label === "保存到" ? "monospace" : undefined}>
                    {value}
                  </DataList.ItemValue>
                </DataList.Item>
              ))}
            </DataList>
            <Text fw={600} size="sm">
              处理过程
            </Text>
            <Timeline active={1} bulletSize={20} lineWidth={2}>
              {["解析链接", "下载视频", "合并分片", "补全资料", "添加到片库"].map((label, i) => (
                <Timeline.Item
                  key={label}
                  title={label}
                  bullet={i < 2 ? <Icon name="check" size={11} /> : <Text fz={10}>{i + 1}</Text>}
                />
              ))}
            </Timeline>
            {detail.status === "scrapeFailed" && (
              <Alert color="champagne" variant="light">
                视频下载成功。元数据来源未响应，可以单独重试刮削。
              </Alert>
            )}
            {detail.status === "failed" && (
              <Alert color="red" variant="light">
                连接超时。重试将保留可恢复的下载进度。
              </Alert>
            )}
            <Group justify="flex-end">{action(detail)}</Group>
          </Stack>
        )}
      </Drawer>
      <Modal opened={!!editTask} onClose={() => setEditTask(null)} title="调整下载任务" centered>
        <Stack gap="sm">
          <TextInput
            label="任务名称"
            value={editedName}
            onChange={(event) => setEditedName(event.currentTarget.value)}
          />
          <TextInput
            label="保存目录"
            value={editedPath}
            onChange={(event) => setEditedPath(event.currentTarget.value)}
          />
        </Stack>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setEditTask(null)}>
            取消
          </Button>
          <Button
            disabled={!editedName.trim() || !editedPath.trim()}
            onClick={() => {
              setTasks((previous) =>
                previous.map((task) =>
                  task.id === editTask?.id
                    ? { ...task, name: editedName.trim(), path: editedPath.trim() }
                    : task,
                ),
              );
              setEditTask(null);
              notice("任务已更新");
            }}
          >
            保存
          </Button>
        </Group>
      </Modal>
    </div>
  );
}
