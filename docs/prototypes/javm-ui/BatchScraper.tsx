import { useState } from "react";
import { Button, Modal } from "@mantine/core";
import { usePrototype } from "./state";
import { Icon } from "./visuals";
import { Pill } from "./ui";

export function BatchScraper() {
  const { films, notice, openFilm } = usePrototype();
  const [queue, setQueue] = useState(["等待验证", "待处理", "刮削失败"]);
  const [verification, setVerification] = useState(false);
  return (
    <>
      <div className="batch-toolbar">
        <span className="muted">{queue.length} 个任务</span>
        <Button
          size="sm"
          leftSection={<Icon name="play" size={16} />}
          disabled={!queue.some((status) => ["待处理", "刮削失败", "已停止"].includes(status))}
          onClick={() => {
            setQueue((previous) =>
              previous.map((status) =>
                ["待处理", "刮削失败", "已停止"].includes(status) ? "处理中" : status,
              ),
            );
            notice("队列已开始处理");
          }}
        >
          开始处理
        </Button>
      </div>
      <div className="table-shell">
        <table className="data-table batch-scraper-table">
          <thead>
            <tr>
              <th>影片 / 路径</th>
              <th>当前步骤</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {queue.map((status, index) => {
              const film = films.find((item) => item.id === [4, 10, 8][index]);
              return (
                <tr key={index}>
                  <td>
                    <button
                      type="button"
                      className="resource-film-name"
                      disabled={!film}
                      onClick={() => film && openFilm(film)}
                    >
                      {film ? `${film.code} · ${film.title}` : "影片已移出片库"}
                    </button>
                    <small>{film ? `D:\\Media\\${film.code}` : "—"}</small>
                  </td>
                  <td>{status === "等待验证" ? "来源需要验证" : "获取元数据"}</td>
                  <td>
                    <Pill
                      tone={
                        status === "等待验证"
                          ? "warning"
                          : status === "刮削失败"
                            ? "danger"
                            : "accent"
                      }
                    >
                      {status}
                    </Pill>
                  </td>
                  <td>
                    {status === "等待验证" ? (
                      <Button
                        variant="light"
                        size="compact-xs"
                        onClick={() => setVerification(true)}
                      >
                        处理验证
                      </Button>
                    ) : (
                      <Button
                        variant="subtle"
                        size="compact-xs"
                        onClick={() =>
                          setQueue((previous) =>
                            previous.map((item, i) =>
                              i === index ? (item === "处理中" ? "已停止" : "处理中") : item,
                            ),
                          )
                        }
                      >
                        {status === "处理中" ? "停止" : status === "刮削失败" ? "重试" : "开始"}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Modal
        opened={verification}
        onClose={() => setVerification(false)}
        title="来源需要验证"
        centered
      >
        <p>完成来源网页验证后，继续当前任务。</p>
        <div className="modal-footer">
          <Button variant="default" onClick={() => setVerification(false)}>
            稍后处理
          </Button>
          <Button
            onClick={() => {
              setQueue((previous) =>
                previous.map((status) => (status === "等待验证" ? "处理中" : status)),
              );
              setVerification(false);
              notice("任务已继续处理");
            }}
          >
            已完成验证，继续
          </Button>
        </div>
      </Modal>
    </>
  );
}
