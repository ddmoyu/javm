import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  Badge,
  Button,
  DataList,
  Group,
  Loader,
  Menu,
  Modal,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
  UnstyledButton,
} from "@mantine/core";
import type { Film } from "./data";
import { usePrototype } from "./state";
import { Icon } from "./icons";
import { Empty, Pill } from "./ui";
import { ObjectMenu, ObjectMenuButton, objectMenuKey } from "./ObjectMenu";
import {
  isResourceQueued,
  resourceDownloadTask,
  resourceSources,
  sortResourceResults,
} from "./resourceSearch";
import type {
  ResourcePacket,
  ResourceResult,
  ResourceSort,
  SourceId,
  SourceState,
} from "./resourceSearch";

const sourceLabels: Record<SourceState, string> = {
  searching: "搜索中",
  ready: "已完成",
  empty: "无结果",
  error: "连接超时",
  stopped: "已停止",
};
const sourceColor: Record<SourceState, string> = {
  searching: "orchid",
  ready: "teal",
  empty: "gray",
  error: "red",
  stopped: "gray",
};

function SourceStatus({
  packet,
  retry,
}: {
  packet: ResourcePacket;
  retry: (source: SourceId) => void;
}) {
  return (
    <Group gap={6} aria-label="搜索来源状态">
      {resourceSources.map((source) => {
        const status = packet.sources[source.id];
        const canRetry = ["error", "stopped", "empty"].includes(status);
        return (
          <Badge
            key={source.id}
            component="button"
            type="button"
            variant="light"
            color={sourceColor[status]}
            size="lg"
            radius="sm"
            tt="none"
            fw={500}
            disabled={!canRetry}
            style={{ cursor: canRetry ? "pointer" : "default" }}
            title={`${source.type} · ${sourceLabels[status]}${canRetry ? "，点击重试" : ""}`}
            aria-label={`${source.name}：${sourceLabels[status]}${canRetry ? "，重试" : ""}`}
            onClick={() => canRetry && retry(source.id)}
            leftSection={
              status === "searching" ? (
                <Loader size={10} color="orchid" />
              ) : (
                <Icon
                  name={
                    status === "error"
                      ? "warning"
                      : status === "ready"
                        ? "check"
                        : status === "stopped"
                          ? "stop"
                          : "search"
                  }
                  size={12}
                />
              )
            }
            rightSection={canRetry ? <Icon name="refresh" size={11} /> : null}
          >
            {source.name} {sourceLabels[status]}
          </Badge>
        );
      })}
    </Group>
  );
}

export function SearchResources({
  packet,
  target,
  retry,
  sent,
  setSent,
}: {
  packet: ResourcePacket;
  target?: Film;
  retry: (source: SourceId) => void;
  sent: Set<string>;
  setSent: Dispatch<SetStateAction<Set<string>>>;
}) {
  const { tasks, setTasks, notice, openFilm } = usePrototype();
  const [kind, setKind] = useState("all");
  const [quality, setQuality] = useState<string | null>("all");
  const [sort, setSort] = useState<ResourceSort>("recommended");
  const [resource, setResource] = useState<ResourceResult | null>(null);
  const [sourceResource, setSourceResource] = useState<ResourceResult | null>(null);
  const searching = Object.values(packet.sources).includes("searching");
  const shown = sortResourceResults(
    packet.resources.filter(
      (item) =>
        (kind === "all" || item.kind === kind) && (quality === "all" || item.quality === quality),
    ),
    sort,
  );
  const copy = async (value: string, message = "资源链接已复制") => {
    try {
      await navigator.clipboard.writeText(value);
      notice(message);
    } catch {
      notice("复制失败，请重试");
    }
  };
  const queued = (item: ResourceResult) => isResourceQueued(item, tasks, target);
  const download = (item: ResourceResult) => {
    if (item.kind === "magnet") {
      setSent((previous) => new Set(previous).add(item.id));
      notice("已发送到外部下载器");
    } else if (!queued(item) && item.available) {
      setTasks((previous) =>
        isResourceQueued(item, previous, target)
          ? previous
          : [...previous, resourceDownloadTask(item, previous, target)],
      );
      notice("已加入下载队列");
    }
  };
  const actionLabel = (item: ResourceResult) =>
    !item.available
      ? "已失效"
      : item.kind === "magnet"
        ? sent.has(item.id)
          ? "已发送"
          : "下载"
        : queued(item)
          ? "已在队列"
          : "下载";
  const actionDisabled = (item: ResourceResult) =>
    !item.available || (item.kind === "online" ? queued(item) : sent.has(item.id));
  const availability = (item: ResourceResult) =>
    item.kind === "online"
      ? { text: item.available ? "可访问" : "已失效", color: item.available ? "teal.4" : "red.4" }
      : item.seeders === null
        ? { text: "做种未知", color: "dimmed" }
        : { text: `${item.seeders} 做种`, color: item.seeders > 0 ? "teal.4" : "red.4" };
  const resourceMenu = (item: ResourceResult) => (
    <>
      <Menu.Item leftSection={<Icon name="list" size={15} />} onClick={() => setResource(item)}>
        资源详情
      </Menu.Item>
      {target && (
        <Menu.Item leftSection={<Icon name="image" size={15} />} onClick={() => openFilm(target)}>
          影片详情
        </Menu.Item>
      )}
      <Menu.Item leftSection={<Icon name="link" size={15} />} onClick={() => void copy(item.url)}>
        {item.kind === "magnet" ? "复制磁力" : "复制链接"}
      </Menu.Item>
      <Menu.Item
        leftSection={<Icon name="external" size={15} />}
        onClick={() => setSourceResource(item)}
      >
        查看来源
      </Menu.Item>
      <Menu.Divider />
      <Menu.Item
        leftSection={<Icon name="refresh" size={15} />}
        disabled={item.sources.some((id) => packet.sources[id] === "searching")}
        onClick={() => item.sources.forEach(retry)}
      >
        重新查询来源
      </Menu.Item>
      {item.kind === "magnet" && sent.has(item.id) && (
        <Menu.Item leftSection={<Icon name="download" size={15} />} onClick={() => download(item)}>
          再次发送到下载器
        </Menu.Item>
      )}
    </>
  );

  return (
    <Stack gap="sm" component="section" aria-label="下载资源">
      <SourceStatus packet={packet} retry={retry} />
      <Group justify="space-between">
        <Group gap="sm">
          <SegmentedControl
            aria-label="资源类型"
            size="xs"
            value={kind}
            onChange={setKind}
            data={[
              { value: "all", label: "全部资源" },
              { value: "magnet", label: "磁力" },
              { value: "online", label: "在线视频" },
            ]}
          />
          <Text size="xs" c="dimmed">
            {shown.length} 条{searching ? " · 搜索中" : ""}
          </Text>
        </Group>
        <Group gap="xs">
          <Select
            aria-label="资源画质"
            data={[{ value: "all", label: "全部画质" }, "4K", "1080P", "720P"]}
            value={quality}
            onChange={setQuality}
            allowDeselect={false}
            size="xs"
            w={110}
          />
          <Select
            aria-label="资源排序"
            data={[
              { value: "recommended", label: "推荐排序" },
              { value: "seeders", label: "做种数最多" },
              { value: "size", label: "文件最大" },
              { value: "date", label: "最近发布" },
            ]}
            value={sort}
            onChange={(value) => value && setSort(value as ResourceSort)}
            allowDeselect={false}
            size="xs"
            w={120}
          />
        </Group>
      </Group>
      <Paper withBorder radius="lg" style={{ overflow: "hidden" }} aria-busy={searching}>
        <Table highlightOnHover verticalSpacing={10} horizontalSpacing="md" layout="fixed">
          <Table.Thead>
            <Table.Tr>
              <Table.Th w="44%">资源名称</Table.Th>
              <Table.Th w="14%">画质 / 大小</Table.Th>
              <Table.Th w="12%">可用性</Table.Th>
              <Table.Th w="13%">来源</Table.Th>
              <Table.Th w="17%">操作</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {shown.map((item) => {
              const state = availability(item);
              return (
                <ObjectMenu key={item.id} items={resourceMenu(item)}>
                  <Table.Tr
                    tabIndex={0}
                    aria-label={`${item.name} 资源`}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (!objectMenuKey(event) && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault();
                        setResource(item);
                      }
                    }}
                  >
                    <Table.Td>
                      <UnstyledButton onClick={() => setResource(item)} title={item.name} w="100%">
                        <Group gap="sm" wrap="nowrap">
                          <ThemeIcon
                            size={34}
                            radius="md"
                            variant="light"
                            color={item.kind === "magnet" ? "rouge" : "orchid"}
                          >
                            <Icon name={item.kind === "magnet" ? "magnet" : "play"} size={17} />
                          </ThemeIcon>
                          <div style={{ minWidth: 0 }}>
                            <Text size="sm" fw={600} truncate>
                              {item.name}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {item.kind === "magnet" ? "磁力" : "在线视频"} · {item.date}
                            </Text>
                          </div>
                        </Group>
                      </UnstyledButton>
                    </Table.Td>
                    <Table.Td>
                      <Pill>{item.quality}</Pill>
                      <Text size="xs" c="dimmed" mt={4}>
                        {item.size.toFixed(1)} GB
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c={state.color}>
                        {state.text}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Button
                        variant="subtle"
                        color="gray"
                        size="compact-xs"
                        onClick={() => setSourceResource(item)}
                      >
                        {resourceSources.find((source) => source.id === item.sources[0])?.name}
                        {item.sources.length > 1 && ` +${item.sources.length - 1}`}
                      </Button>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <Button
                          size="compact-xs"
                          variant={item.kind === "magnet" ? "light" : "default"}
                          disabled={actionDisabled(item)}
                          title={
                            item.kind === "magnet"
                              ? sent.has(item.id)
                                ? "由外部下载器管理"
                                : "发送到外部下载器"
                              : "加入下载队列"
                          }
                          onClick={() => download(item)}
                        >
                          {actionLabel(item)}
                        </Button>
                        <ObjectMenuButton label={`${item.name} 更多操作`} />
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                </ObjectMenu>
              );
            })}
          </Table.Tbody>
        </Table>
        {!shown.length &&
          (searching ? (
            <Group justify="center" py="xl" gap="xs">
              <Loader size="sm" />
              <Text size="sm" c="dimmed">
                正在查找资源
              </Text>
            </Group>
          ) : (
            <Empty
              title={packet.resources.length ? "没有符合筛选条件的资源" : "未找到资源"}
              description={
                packet.resources.length
                  ? "调整画质或资源类型后重试。"
                  : "试试其他番号或片名，也可以重试未响应的来源。"
              }
            >
              {packet.resources.length > 0 && (
                <Button
                  variant="default"
                  size="xs"
                  onClick={() => {
                    setKind("all");
                    setQuality("all");
                  }}
                >
                  清除筛选
                </Button>
              )}
            </Empty>
          ))}
      </Paper>
      <Modal
        opened={!!resource}
        onClose={() => setResource(null)}
        title="资源详情"
        size={560}
        centered
      >
        {resource && (
          <>
            <Title order={4} fz={15} ff="monospace" mb="md" style={{ wordBreak: "break-all" }}>
              {resource.name}
            </Title>
            <DataList orientation="horizontal" labelWidth={90} size="sm">
              {[
                ["类型", resource.kind === "magnet" ? "磁力链接" : "在线视频"],
                ["画质 / 大小", `${resource.quality} · ${resource.size.toFixed(1)} GB`],
                [
                  "可用性",
                  resource.kind === "magnet"
                    ? resource.seeders === null
                      ? "做种数未知"
                      : `${resource.seeders} 个做种`
                    : resource.available
                      ? "可访问"
                      : "链接已失效",
                ],
                ["发布时间", resource.date],
                [
                  "来源",
                  resource.sources
                    .map((id) => resourceSources.find((source) => source.id === id)?.name)
                    .join("、"),
                ],
                ...(resource.kind === "magnet"
                  ? [
                      [
                        "下载方式",
                        sent.has(resource.id) ? "已发送 · 由外部下载器管理" : "外部下载器",
                      ],
                    ]
                  : []),
              ].map(([label, value]) => (
                <DataList.Item key={label}>
                  <DataList.ItemLabel>{label}</DataList.ItemLabel>
                  <DataList.ItemValue>{value}</DataList.ItemValue>
                </DataList.Item>
              ))}
            </DataList>
            <Group justify="flex-end" mt="lg" gap="xs">
              {target && (
                <Button
                  variant="subtle"
                  size="xs"
                  onClick={() => {
                    setResource(null);
                    openFilm(target);
                  }}
                >
                  影片详情
                </Button>
              )}
              <Button variant="default" size="xs" onClick={() => void copy(resource.url)}>
                {resource.kind === "magnet" ? "复制磁力" : "复制链接"}
              </Button>
              <Button
                size="xs"
                disabled={actionDisabled(resource)}
                onClick={() => download(resource)}
              >
                {resource.kind === "magnet" && !sent.has(resource.id)
                  ? "发送到下载器"
                  : actionLabel(resource)}
              </Button>
            </Group>
          </>
        )}
      </Modal>
      <Modal
        opened={!!sourceResource}
        onClose={() => setSourceResource(null)}
        title="资源来源"
        size={520}
        centered
      >
        {sourceResource && (
          <Stack gap="sm">
            <Text size="sm" ff="monospace" fw={600} style={{ wordBreak: "break-all" }}>
              {sourceResource.name}
            </Text>
            {sourceResource.sources.map((id) => {
              const source = resourceSources.find((item) => item.id === id)!;
              const url = `https://${id}.example.invalid/resources/${sourceResource.code}`;
              return (
                <Paper key={id} withBorder p="sm" radius="md">
                  <Group justify="space-between" wrap="nowrap">
                    <div style={{ minWidth: 0 }}>
                      <Text size="sm" fw={600}>
                        {source.name}
                      </Text>
                      <Text size="xs" c="dimmed" ff="monospace" truncate>
                        {url}
                      </Text>
                    </div>
                    <Button
                      size="compact-xs"
                      variant="default"
                      onClick={() => void copy(url, "来源地址已复制")}
                    >
                      复制地址
                    </Button>
                  </Group>
                </Paper>
              );
            })}
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
