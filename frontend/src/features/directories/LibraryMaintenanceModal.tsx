import { useState, useSyncExternalStore } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Menu,
  Modal,
  Pagination,
  Stack,
  Table,
  Text,
  Textarea,
} from "@mantine/core";
import { Icon } from "../../components/icons";
import { ObjectMenu, objectMenuKey } from "../../components/ObjectMenu";
import { Empty } from "../../components/ui";
import { maintenancePageSize } from "../../contracts/maintenance";
import type { LibraryMaintenanceService } from "../../services/library/LibraryMaintenanceService";
import { filename, parentDirectory } from "../../services/library/maintenanceRules";
import { openMediaDirectory } from "../../platform/neutralino/directoryPicker";

function fileSize(value: number | null) {
  if (value === null) return "大小未知";
  if (!value) return "0 B";
  const power = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : 1;
  return `${(value / 1024 ** power).toFixed(2)} ${["B", "KB", "MB", "GB"][power]}`;
}

export function LibraryMaintenanceModal({
  service,
  opened,
  onClose,
}: {
  service: LibraryMaintenanceService;
  opened: boolean;
  onClose: () => void;
}) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const [confirming, setConfirming] = useState(false);
  const [metadataOnly, setMetadataOnly] = useState(false);
  const [editing, setEditing] = useState(false);
  const [keywords, setKeywords] = useState("");
  const [excludes, setExcludes] = useState("");
  const [duplicateNames, setDuplicateNames] = useState(true);
  const [localError, setLocalError] = useState("");
  const [ruleError, setRuleError] = useState("");
  const duplicates = state.mode === "duplicates";
  const ads = state.mode === "ads";
  const health = state.mode === "health";
  const cleaning = state.phase === "cleaning",
    reading = state.phase === "reading";
  const busy = cleaning || reading || state.changing;
  const close = () => {
    if (cleaning || state.changing) return;
    if (reading) service.cancel();
    setLocalError("");
    setConfirming(false);
    setEditing(false);
    onClose();
  };
  const openDirectory = async (path: string) => {
    try {
      await openMediaDirectory(parentDirectory(path));
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "无法打开目录");
    }
  };
  const select = (choice: "all" | "none" | "suggested" | "toggle", ids?: string[]) =>
    service.change({ type: "select", choice, ids });
  const showRules = () => {
    setKeywords(state.rules.keywords.join("\n"));
    setExcludes(state.rules.excludeKeywords.join("\n"));
    setDuplicateNames(state.rules.duplicateNames);
    setRuleError("");
    setEditing(true);
  };
  const addKeyword = async (path: string) => {
    try {
      await service.saveRules({
        ...state.rules,
        keywords: [...state.rules.keywords, filename(path).replace(/\.[^.]+$/, "")],
      });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "规则保存失败");
    }
  };
  const confirm = () => {
    setMetadataOnly(false);
    setConfirming(true);
  };
  return (
    <>
      <Modal
        opened={opened}
        onClose={close}
        title={
          duplicates ? "重复视频" : ads ? "广告视频" : health ? "片库健康检查" : "片库资源清理"
        }
        size="min(1100px, 96vw)"
        centered
        closeOnClickOutside={!busy}
        closeOnEscape={!cleaning && !state.changing}
        withCloseButton={!cleaning && !state.changing}
      >
        <Stack gap="sm">
          <Group justify="space-between">
            <Group gap="xs">
              <Button
                size="xs"
                variant="default"
                leftSection={<Icon name="refresh" size={15} />}
                disabled={busy}
                onClick={() => void service.scan()}
              >
                重新检查
              </Button>
              {ads && (
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<Icon name="filter" size={15} />}
                  disabled={busy || !state.settingsReady}
                  onClick={showRules}
                >
                  筛选规则
                </Button>
              )}
              {duplicates && (
                <Button
                  size="xs"
                  variant="default"
                  disabled={busy || !state.total}
                  onClick={() => void select("suggested")}
                >
                  选择建议清理项
                </Button>
              )}
              {!duplicates && (
                <Button
                  size="xs"
                  variant="default"
                  disabled={busy || !state.total}
                  onClick={() => void select("all")}
                >
                  全选
                </Button>
              )}
              <Button
                size="xs"
                variant="subtle"
                disabled={busy || !state.selected}
                onClick={() => void select("none")}
              >
                取消选择
              </Button>
            </Group>
            <Button
              size="xs"
              color="red"
              leftSection={<Icon name="trash" size={15} />}
              disabled={busy || state.phase !== "ready" || !state.selected}
              onClick={confirm}
            >
              删除所选 {state.selected || ""}
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            {duplicates
              ? "按相同番号或头尾文件指纹分组，优先保留可用、时长完整、清晰度高的视频。相同番号可能是分段或不同版本，清理前请核对。"
              : ads
                ? "从已入库视频中筛选零字节、重复文件名和关键词命中项，排除词优先。不进行视频内容识别。"
                : health
                  ? "检查文件可访问性、文件变化、视频资料、NFO 和封面。检查只生成报告，修复后可重新扫描目录；离线文件不会自动删除。"
                  : "选择需要删除的本地视频资源。作品资料与收藏会保留，删除前请核对路径。"}
          </Text>
          {duplicates && state.unhashed > 0 && (
            <Text size="xs" c="yellow">
              {state.unhashed} 个视频尚无文件指纹，可在目录页重新扫描以补齐；目前仍参与番号对照。
            </Text>
          )}
          {(state.error || localError) && (
            <Alert color="red" role="alert">
              {localError || state.error}
            </Alert>
          )}
          {state.message && (
            <Alert color={state.failures.length || state.error ? "yellow" : "green"}>
              <output aria-live="polite">{state.message}</output>
            </Alert>
          )}
          {state.failures.length > 0 && (
            <Alert color="yellow" title="部分项目未完成，记录已保留，可核对后重试">
              <Stack gap={4} mah={120} style={{ overflowY: "auto" }}>
                {state.failures.map((failure, index) => (
                  <Text size="xs" key={index} style={{ overflowWrap: "anywhere" }}>
                    {failure}
                  </Text>
                ))}
              </Stack>
              <Text size="xs" mt="xs">
                失败前已完成的文件删除无法撤回；最多显示前 20 项错误。
              </Text>
            </Alert>
          )}
          {(reading || cleaning) && (
            <Group justify="space-between">
              <Text size="sm" component="output" aria-live="polite">
                {reading
                  ? `正在检查，已读取 ${state.processed} 个视频…`
                  : `正在清理，已处理 ${state.processed} 项…`}
              </Text>
              <Button
                size="xs"
                variant="default"
                disabled={state.cancelling}
                onClick={() => service.cancel()}
              >
                {state.cancelling ? "正在完成当前项…" : "停止"}
              </Button>
            </Group>
          )}
          {state.total > 0 && (
            <>
              <Text size="sm" c="dimmed">
                {duplicates ? `${state.groups} 组 · ` : ""}
                {state.total} 个视频 · 已选 {state.selected} 项
              </Text>
              <div style={{ overflow: "auto", maxHeight: "52vh" }}>
                <Table
                  highlightOnHover
                  verticalSpacing="sm"
                  layout="fixed"
                  style={{ minWidth: 720 }}
                >
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th w={56}>选择</Table.Th>
                      <Table.Th>视频与路径</Table.Th>
                      <Table.Th w={150}>视频信息</Table.Th>
                      <Table.Th w={180}>命中原因</Table.Th>
                      <Table.Th w={56}>操作</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {state.rows.map((video) => (
                      <ObjectMenu
                        key={video.id}
                        items={
                          <>
                            <Menu.Item
                              leftSection={<Icon name="folder" />}
                              onClick={() => void openDirectory(video.path)}
                            >
                              打开所在目录
                            </Menu.Item>
                            {ads && (
                              <Menu.Item
                                leftSection={<Icon name="plus" />}
                                disabled={busy}
                                onClick={() => void addKeyword(video.path)}
                              >
                                将文件名加入关键词
                              </Menu.Item>
                            )}
                            <Menu.Item
                              leftSection={<Icon name="check" />}
                              disabled={busy}
                              onClick={() => void select("toggle", [video.id])}
                            >
                              {video.selected ? "取消选择" : "选择此项"}
                            </Menu.Item>
                          </>
                        }
                      >
                        <Table.Tr
                          tabIndex={0}
                          onKeyDown={objectMenuKey}
                          style={{ cursor: "context-menu" }}
                        >
                          <Table.Td>
                            <Checkbox
                              aria-label={`选择 ${filename(video.path)}`}
                              checked={video.selected}
                              disabled={busy}
                              onChange={() => void select("toggle", [video.id])}
                            />
                          </Table.Td>
                          <Table.Td>
                            <Group gap={5} mb={3}>
                              {duplicates && (
                                <Text size="xs" fw={600}>
                                  {video.group}
                                </Text>
                              )}
                              {duplicates && video.suggestedKeep && (
                                <Badge size="xs" color="green" variant="light">
                                  建议保留
                                </Badge>
                              )}
                              {video.missing && (
                                <Badge size="xs" color="yellow" variant="light">
                                  文件不可用
                                </Badge>
                              )}
                              {video.crossDirectory && (
                                <Badge size="xs" variant="light">
                                  跨目录
                                </Badge>
                              )}
                            </Group>
                            <Text size="sm" truncate title={video.title}>
                              {video.title || filename(video.path)}
                            </Text>
                            <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
                              {video.path}
                            </Text>
                            {video.missing && (
                              <Text size="xs" c="dimmed">
                                文件当前不可用或上次扫描确认缺失；恢复后请重新扫描。
                              </Text>
                            )}
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm">{video.resolution || "清晰度未知"}</Text>
                            <Text size="xs" c="dimmed">
                              {video.duration ? `${Math.round(video.duration / 60)} 分钟 · ` : ""}
                              {fileSize(video.size)}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Text size="xs">{video.reason}</Text>
                          </Table.Td>
                          <Table.Td>
                            <ActionIcon
                              variant="subtle"
                              color="gray"
                              aria-label={`打开所在目录 ${video.path}`}
                              onClick={() => void openDirectory(video.path)}
                            >
                              <Icon name="folder" size={17} />
                            </ActionIcon>
                          </Table.Td>
                        </Table.Tr>
                      </ObjectMenu>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
              <Group justify="center">
                <Pagination
                  size="sm"
                  value={state.page}
                  total={Math.ceil(state.total / maintenancePageSize)}
                  disabled={busy}
                  onChange={(page) => void service.change({ type: "page", page })}
                />
              </Group>
            </>
          )}
          {state.phase === "ready" && !state.total && (
            <Empty
              icon={duplicates ? "copy" : "filter"}
              title={
                duplicates
                  ? "未发现重复候选"
                  : ads
                    ? "未发现广告候选"
                    : health
                      ? "未发现资源问题"
                      : "暂无本地视频"
              }
              description={
                duplicates
                  ? "当前片库没有匹配的番号或文件指纹。"
                  : ads
                    ? "可以调整关键词或排除规则后重新检查。"
                    : health
                      ? `已检查 ${state.processed} 个本地资源。`
                      : "导入视频后可在这里管理。"
              }
            />
          )}
        </Stack>
      </Modal>
      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title="确认清理所选视频"
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            已选择 {state.selected} 个视频。
            {metadataOnly
              ? "将删除这些视频的 NFO、独占封面和刮削资料，保留原视频及片库记录。"
              : "将永久删除所选视频及其独占字幕。作品资料、NFO、封面和收藏会保留；最后一个视频移除后，作品显示为未下载。"}
          </Text>
          <Text size="xs" c="dimmed">
            {metadataOnly
              ? "清除作品的 NFO 和封面；与其他资源共享资料时会停止并提示。"
              : "作品资料和封面会保留，整目录不会删除。"}
          </Text>
          <Checkbox
            label="不删除视频文件，仅删除刮削数据"
            checked={metadataOnly}
            onChange={(event) => setMetadataOnly(event.currentTarget.checked)}
          />
          {duplicates &&
            !metadataOnly &&
            (state.unprotected > 0 ? (
              <Alert color="yellow" role="alert">
                有 {state.unprotected}{" "}
                个所选视频没有可用的保留副本。每组至少取消勾选一个可用视频后再清理。
              </Alert>
            ) : (
              <Text size="xs" c="dimmed">
                删除前会再次检查未选中的保留视频。文件丢失、离线或发生变化时停止该项清理。
              </Text>
            ))}
          <Group justify="flex-end">
            <Button variant="default" data-autofocus onClick={() => setConfirming(false)}>
              取消
            </Button>
            <Button
              color="red"
              disabled={duplicates && !metadataOnly && state.unprotected > 0}
              onClick={() => {
                setConfirming(false);
                void service.remove(metadataOnly);
              }}
            >
              确认清理 {state.selected} 项
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={editing}
        onClose={() => {
          if (!state.changing) setEditing(false);
        }}
        title="广告视频筛选规则"
        centered
        closeOnClickOutside={!state.changing}
        closeOnEscape={!state.changing}
        withCloseButton={!state.changing}
      >
        <Stack gap="md">
          <Textarea
            label="关键词"
            description="每行一个，匹配文件名或标题，不区分大小写。"
            autosize
            minRows={4}
            maxRows={8}
            value={keywords}
            disabled={state.changing}
            onChange={(event) => setKeywords(event.currentTarget.value)}
          />
          <Textarea
            label="排除词"
            description="每行一个。命中排除词的视频不会进入候选列表。"
            autosize
            minRows={3}
            maxRows={6}
            value={excludes}
            disabled={state.changing}
            onChange={(event) => setExcludes(event.currentTarget.value)}
          />
          <Checkbox
            label="同时筛选重复文件名"
            checked={duplicateNames}
            disabled={state.changing}
            onChange={(event) => setDuplicateNames(event.currentTarget.checked)}
          />
          {ruleError && <Alert color="red">{ruleError}</Alert>}
          <Group justify="flex-end">
            <Button variant="default" disabled={state.changing} onClick={() => setEditing(false)}>
              取消
            </Button>
            <Button
              loading={state.changing}
              onClick={() => {
                setRuleError("");
                void service
                  .saveRules({
                    keywords: keywords.split("\n"),
                    excludeKeywords: excludes.split("\n"),
                    duplicateNames,
                  })
                  .then(() => setEditing(false))
                  .catch((error: unknown) =>
                    setRuleError(error instanceof Error ? error.message : "规则保存失败"),
                  );
              }}
            >
              保存并重新检查
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
