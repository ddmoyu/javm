import { useLayoutEffect, useRef, useState } from "react";
import { Button, Drawer, Menu, Modal, Progress, TextInput } from "@mantine/core";
import { taskLabels } from "./data";
import type { DownloadTask, TaskStatus } from "./data";
import { usePrototype } from "./state";
import { Icon, Poster } from "./visuals";
import { Empty, IconButton, Pill } from "./ui";
import { ObjectMenu, ObjectMenuButton, objectMenuKey } from "./ObjectMenu";

const isActive = (status: TaskStatus) =>
  ["downloading", "merging", "scraping", "queued"].includes(status);
const taskTone = (status: TaskStatus) =>
  status === "failed" || status === "scrapeFailed"
    ? "danger"
    : status === "completed"
      ? "success"
      : isActive(status)
        ? "accent"
        : "neutral";

export function Downloads() {
  const { tasks, setTasks, add, notice, films } = usePrototype();
  const [filter, setFilter] = useState("all");
  const [detailId, setDetailId] = useState<number | null>(null);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [editTask, setEditTask] = useState<DownloadTask | null>(null);
  const [editedName, setEditedName] = useState("");
  const [editedPath, setEditedPath] = useState("");
  const tableRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    tableRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [filter]);
  const detail = tasks.find((task) => task.id === detailId);
  const changeStatus = (id: number, status: TaskStatus) =>
    setTasks((previous) => previous.map((task) => (task.id === id ? { ...task, status } : task)));
  const activeCount = tasks.filter((task) => isActive(task.status)).length;
  const errorCount = tasks.filter(
    (task) => task.status === "failed" || task.status === "scrapeFailed",
  ).length;
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
              name={task.status.includes("Failed") || task.status === "failed" ? "refresh" : "play"}
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
    <div className="downloads-workspace">
      <div className="library-controls download-controls">
        <div className="text-tabs">
          {[
            ["all", "全部任务", tasks.length],
            ["active", "进行中", activeCount],
            ["paused", "已暂停", tasks.filter((task) => task.status === "paused").length],
            ["errors", "需处理", errorCount],
            ["completed", "已完成", tasks.filter((task) => task.status === "completed").length],
          ].map(([key, label, count]) => (
            <button
              type="button"
              key={key}
              className={filter === key ? "active" : ""}
              aria-pressed={filter === key}
              onClick={() => setFilter(String(key))}
            >
              {label}
              <span>{count}</span>
            </button>
          ))}
        </div>
        <div className="row control-actions">
          <Button
            size="xs"
            variant="default"
            leftSection={<Icon name="pause" />}
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
          <Button size="xs" leftSection={<Icon name="plus" />} onClick={() => add("download")}>
            新建下载
          </Button>
        </div>
      </div>
      <section
        className="table-shell download-table-shell"
        ref={tableRef}
        aria-label="下载任务列表"
      >
        <table className="data-table download-table">
          <thead>
            <tr>
              <th>影片 / 任务</th>
              <th>状态</th>
              <th>进度</th>
              <th>速度 / 剩余时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((task) => {
              const film = films.find((item) => item.id === task.filmId);
              return (
                <ObjectMenu key={task.id} items={taskMenu(task)}>
                  <tr
                    className={focusedId === task.id ? "focused" : ""}
                    tabIndex={0}
                    aria-selected={focusedId === task.id}
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
                    <td aria-label={task.name}>
                      <div className="table-film">
                        <div className="mini-poster">
                          {film ? <Poster film={film} compact /> : <Icon name="play" />}
                        </div>
                        <button
                          type="button"
                          className="plain-title"
                          onClick={() => setDetailId(task.id)}
                        >
                          {task.name}
                          <small>
                            {task.status === "scrapeFailed"
                              ? "视频已保存 · 仅资料补全失败"
                              : "MP4 · " + (task.quality ?? film?.quality ?? "自动画质")}
                          </small>
                        </button>
                      </div>
                    </td>
                    <td>
                      <Pill tone={taskTone(task.status)}>{taskLabels[task.status]}</Pill>
                      {task.status === "failed" && <small className="error-text">连接超时</small>}
                    </td>
                    <td>
                      <div className="progress-label">
                        <span>{task.progress}%</span>
                        <span>{task.progress === 100 ? "已下载" : "下载进度"}</span>
                      </div>
                      <Progress
                        value={task.progress}
                        color={
                          task.status === "failed"
                            ? "red"
                            : task.status === "paused"
                              ? "gray"
                              : "rose"
                        }
                        size={4}
                      />
                    </td>
                    <td className="numeric">
                      {task.status === "downloading" ? (task.speed ?? "正在连接") : "—"}
                      <small>
                        {task.status === "downloading"
                          ? (task.remaining ?? "正在估算剩余时间")
                          : task.status === "merging"
                            ? "正在合并分片"
                            : task.status === "scraping"
                              ? "正在补全资料"
                              : ""}
                      </small>
                    </td>
                    <td>
                      <div className="row">
                        {action(task)}
                        <ObjectMenuButton label={`${task.name} 更多操作`} />
                      </div>
                    </td>
                  </tr>
                </ObjectMenu>
              );
            })}
          </tbody>
        </table>
        {!shown.length && (
          <Empty title="这里还没有任务" description="新建下载，或切换到其他任务状态。" />
        )}
      </section>

      <Drawer
        opened={!!detail}
        onClose={() => setDetailId(null)}
        position="right"
        title="任务详情"
        size={460}
      >
        {detail && (
          <>
            <h2>{detail.name}</h2>
            <Pill tone={taskTone(detail.status)}>{taskLabels[detail.status]}</Pill>
            <dl className="detail-fields">
              <dt>保存到</dt>
              <dd className="path-text">{detail.path}</dd>
              <dt>创建时间</dt>
              <dd>今天 14:20</dd>
              <dt>已下载</dt>
              <dd>{detail.progress}%</dd>
              <dt>下载方式</dt>
              <dd>自动选择工具</dd>
            </dl>
            <h3>处理过程</h3>
            <div className="timeline">
              {["解析链接", "下载视频", "合并分片", "补全资料", "添加到片库"].map((label, i) => (
                <div key={label} className={i < 2 ? "done" : ""}>
                  <span>{i < 2 ? <Icon name="check" size={13} /> : i + 1}</span>
                  {label}
                </div>
              ))}
            </div>
            {detail.status === "scrapeFailed" && (
              <div className="notice-strip warning-note">
                视频下载成功。元数据来源未响应，可以单独重试刮削。
              </div>
            )}
            {detail.status === "failed" && (
              <div className="notice-strip warning-note">
                连接超时。重试将保留可恢复的下载进度。
              </div>
            )}
            <div className="modal-footer">{action(detail)}</div>
          </>
        )}
      </Drawer>
      <Modal opened={!!editTask} onClose={() => setEditTask(null)} title="调整下载任务" centered>
        <div className="form-stack">
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
        </div>
        <div className="modal-footer">
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
        </div>
      </Modal>
    </div>
  );
}
