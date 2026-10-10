import { useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Button, Loader, Menu, Modal, SegmentedControl, Select, Table } from "@mantine/core";
import type { Film } from "./data";
import { usePrototype } from "./state";
import { Icon } from "./visuals";
import { Empty, Pill } from "./ui";
import { ObjectMenu, ObjectMenuButton, objectMenuKey } from "./ObjectMenu";
import {
  isResourceQueued,
  resourceDownloadTask,
  resourceSources,
  sortResourceResults,
} from "./resourceSearch";
import type { ResourcePacket, ResourceResult, ResourceSort, SourceId } from "./resourceSearch";
import { SearchSourceStatus } from "./SearchSourceStatus";

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
  const listRef = useRef<HTMLDivElement>(null);
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
    <section className="search-detail-resources" aria-label="下载资源">
      <SearchSourceStatus packet={packet} retry={retry} />
      <div className="resource-filterbar">
        <SegmentedControl
          aria-label="资源类型"
          size="xs"
          value={kind}
          onChange={(value) => {
            setKind(value);
            listRef.current?.scrollTo({ top: 0 });
          }}
          data={[
            { value: "all", label: "全部资源" },
            { value: "magnet", label: "磁力" },
            { value: "online", label: "在线视频" },
          ]}
        />
        <output className="resource-count">
          {shown.length} 条{searching ? " · 搜索中" : ""}
        </output>
        <div className="resource-filter-options">
          <Select
            aria-label="资源画质"
            data={[{ value: "all", label: "全部画质" }, "4K", "1080P", "720P"]}
            value={quality}
            onChange={setQuality}
            allowDeselect={false}
            size="xs"
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
          />
        </div>
      </div>
      <div
        ref={listRef}
        className="unified-resource-list"
        aria-label="资源搜索结果"
        aria-busy={searching}
      >
        <Table className="unified-resource-table">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>资源名称</Table.Th>
              <Table.Th>画质 / 大小</Table.Th>
              <Table.Th>可用性</Table.Th>
              <Table.Th>来源</Table.Th>
              <Table.Th>操作</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {shown.map((item) => (
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
                  <Table.Td aria-label={item.name}>
                    <button
                      type="button"
                      className="resource-name-button"
                      onClick={() => setResource(item)}
                      title={item.name}
                    >
                      <span className={`resource-kind-icon kind-${item.kind}`}>
                        <Icon name={item.kind === "magnet" ? "link" : "play"} size={18} />
                      </span>
                      <span className="resource-row-name">
                        <strong>{item.name}</strong>
                        <small>
                          {item.kind === "magnet" ? "磁力" : "在线视频"}
                          <span> · {item.date}</span>
                        </small>
                      </span>
                    </button>
                  </Table.Td>
                  <Table.Td>
                    <Pill>{item.quality}</Pill>
                    <small>{item.size.toFixed(1)} GB</small>
                  </Table.Td>
                  <Table.Td>
                    <span
                      className={`resource-availability ${!item.available || item.seeders === 0 ? "unavailable" : item.kind === "online" || (item.seeders ?? 0) > 0 ? "available" : ""}`}
                    >
                      {item.kind === "online"
                        ? item.available
                          ? "可访问"
                          : "已失效"
                        : item.seeders === null
                          ? "做种未知"
                          : `${item.seeders} 做种`}
                    </span>
                  </Table.Td>
                  <Table.Td>
                    <button
                      type="button"
                      className="resource-source-link"
                      onClick={() => setSourceResource(item)}
                    >
                      {resourceSources.find((source) => source.id === item.sources[0])?.name}
                      {item.sources.length > 1 && <span> +{item.sources.length - 1}</span>}
                    </button>
                  </Table.Td>
                  <Table.Td>
                    <div className="resource-row-actions">
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
                    </div>
                  </Table.Td>
                </Table.Tr>
              </ObjectMenu>
            ))}
          </Table.Tbody>
        </Table>
        {!shown.length &&
          (searching ? (
            <div className="resource-search-loading">
              <Loader size="sm" color="rose" />
              <span>正在查找资源</span>
            </div>
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
      </div>
      <Modal
        opened={!!resource}
        onClose={() => setResource(null)}
        title="资源详情"
        size={560}
        centered
      >
        {resource && (
          <>
            <h3 className="resource-modal-title">{resource.name}</h3>
            <dl className="detail-fields">
              <dt>类型</dt>
              <dd>{resource.kind === "magnet" ? "磁力链接" : "在线视频"}</dd>
              <dt>画质 / 大小</dt>
              <dd>
                {resource.quality} · {resource.size.toFixed(1)} GB
              </dd>
              <dt>可用性</dt>
              <dd>
                {resource.kind === "magnet"
                  ? resource.seeders === null
                    ? "做种数未知"
                    : `${resource.seeders} 个做种`
                  : resource.available
                    ? "可访问"
                    : "链接已失效"}
              </dd>
              <dt>发布时间</dt>
              <dd>{resource.date}</dd>
              <dt>来源</dt>
              <dd>
                {resource.sources
                  .map((id) => resourceSources.find((source) => source.id === id)?.name)
                  .join("、")}
              </dd>
              {resource.kind === "magnet" && (
                <>
                  <dt>下载方式</dt>
                  <dd>{sent.has(resource.id) ? "已发送 · 由外部下载器管理" : "外部下载器"}</dd>
                </>
              )}
            </dl>
            <div className="resource-modal-actions">
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
            </div>
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
          <>
            <h3 className="resource-modal-title">{sourceResource.name}</h3>
            <div className="resource-origin-list">
              {sourceResource.sources.map((id) => {
                const source = resourceSources.find((item) => item.id === id)!;
                const url = `https://${id}.example.invalid/resources/${sourceResource.code}`;
                return (
                  <div key={id}>
                    <div>
                      <strong>{source.name}</strong>
                      <span>{url}</span>
                    </div>
                    <Button
                      size="compact-xs"
                      variant="default"
                      onClick={() => void copy(url, "来源地址已复制")}
                    >
                      复制地址
                    </Button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Modal>
    </section>
  );
}
