import { useState } from "react";
import { Anchor, Button, Group, Modal, Paper, Table, Text } from "@mantine/core";
import { usePrototype } from "./state";
import { Icon } from "./icons";
import { Pill } from "./ui";

export function BatchScraper() {
  const { films, notice, openFilm } = usePrototype();
  const [queue, setQueue] = useState(["等待验证", "待处理", "刮削失败"]);
  const [verification, setVerification] = useState(false);
  return (
    <>
      <Group justify="space-between" mb="md">
        <Text size="sm" c="dimmed">
          {queue.length} 个任务
        </Text>
        <Button
          size="xs"
          leftSection={<Icon name="play" size={15} />}
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
      </Group>
      <Paper withBorder radius="lg" style={{ overflow: "hidden" }}>
        <Table verticalSpacing={12} horizontalSpacing="md" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>影片 / 路径</Table.Th>
              <Table.Th>当前步骤</Table.Th>
              <Table.Th>状态</Table.Th>
              <Table.Th>操作</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {queue.map((status, index) => {
              const film = films.find((item) => item.id === [4, 10, 8][index]);
              return (
                <Table.Tr key={index}>
                  <Table.Td>
                    <Anchor
                      component="button"
                      type="button"
                      size="sm"
                      fw={600}
                      c="var(--mantine-color-text)"
                      disabled={!film}
                      onClick={() => film && openFilm(film)}
                    >
                      {film ? `${film.code} · ${film.title}` : "影片已移出片库"}
                    </Anchor>
                    <Text size="xs" c="dimmed" ff="monospace">
                      {film ? `D:\\Media\\${film.code}` : "—"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{status === "等待验证" ? "来源需要验证" : "获取元数据"}</Text>
                  </Table.Td>
                  <Table.Td>
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
                  </Table.Td>
                  <Table.Td>
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
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Paper>
      <Modal
        opened={verification}
        onClose={() => setVerification(false)}
        title="来源需要验证"
        centered
      >
        <Text size="sm">完成来源网页验证后，继续当前任务。</Text>
        <Group justify="flex-end" mt="lg">
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
        </Group>
      </Modal>
    </>
  );
}
