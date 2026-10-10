import { useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Menu,
  Modal,
  Paper,
  Progress,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { useWorkspace } from "../../app/state";
import { Icon } from "../../components/icons";
import { Empty } from "../../components/ui";
import { ObjectMenu, objectMenuKey } from "../../components/ObjectMenu";
import type { MediaDirectory, ScanState } from "../../contracts/library";
import { libraryError } from "../../services/library/LibraryService";
import { openMediaDirectory } from "../../platform/neutralino/directoryPicker";
import { LibraryMaintenanceModal } from "./LibraryMaintenanceModal";
import type { MaintenanceMode } from "../../contracts/maintenance";
import { DirectoryWatchControl } from "./DirectoryWatchControl";
import { LibraryDocumentsPanel } from "./LibraryDocumentsPanel";
import { FileOrganizationPanel } from "./FileOrganizationPanel";

const labels: Record<ScanState, string> = {
  idle: "待扫描",
  scanning: "扫描中",
  completed: "已完成",
  partial: "部分完成",
  failed: "扫描失败",
  cancelled: "已停止",
  interrupted: "扫描中断",
};
export function Directories() {
  const { add, library, libraryState: state, notice, go } = useWorkspace();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [removing, setRemoving] = useState<MediaDirectory | null>(null);
  const [removeError, setRemoveError] = useState("");
  const [maintenanceOpened, setMaintenanceOpened] = useState(false);
  const openMaintenance = (mode: MaintenanceMode) => {
    if (!library.maintenance) return;
    setMaintenanceOpened(true);
    void library.maintenance.scan(mode);
  };
  const scanning = state.scan?.state === "scanning";
  const scan = state.scan;
  const disabled = scanning || pending || !state.available || !state.ready;
  const perform = async (action: () => Promise<void>) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await action();
    } catch (error) {
      notice(libraryError(error));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const requestRemove = (directory: MediaDirectory) => {
    setRemoveError("");
    setRemoving(directory);
  };
  const closeRemove = () => {
    if (!pendingRef.current) setRemoving(null);
  };
  const removeDirectory = () => {
    if (!removing || disabled) return;
    void perform(async () => {
      setRemoveError("");
      try {
        await library.removeDirectory(removing.id);
        setRemoving(null);
        notice("已停止管理此目录，作品、收藏、资源关联和磁盘文件均已保留。");
      } catch (error) {
        setRemoveError(libraryError(error));
      }
    });
  };
  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Group gap="sm" align="flex-end">
          <Button
            size="xs"
            leftSection={<Icon name="plus" size={15} />}
            disabled={disabled}
            onClick={() => add("import")}
          >
            添加目录
          </Button>
          <Button
            variant="default"
            size="xs"
            leftSection={<Icon name="refresh" size={15} />}
            loading={pending}
            onClick={() => void perform(() => library.refresh())}
          >
            刷新列表
          </Button>
          <Button
            variant="default"
            size="xs"
            leftSection={<Icon name="copy" size={15} />}
            disabled={disabled || !library.maintenance}
            onClick={() => openMaintenance("duplicates")}
          >
            重复视频
          </Button>
          <Button
            variant="default"
            size="xs"
            leftSection={<Icon name="filter" size={15} />}
            disabled={disabled || !library.maintenance}
            onClick={() => openMaintenance("ads")}
          >
            广告视频
          </Button>
          <Button
            variant="default"
            size="xs"
            disabled={disabled || !library.maintenance}
            onClick={() => openMaintenance("health")}
          >
            健康检查
          </Button>
          <Button
            variant="default"
            size="xs"
            disabled={disabled || !library.maintenance}
            onClick={() => openMaintenance("all")}
          >
            清理资源
          </Button>
        </Group>
        <Text size="sm" c="dimmed">
          {state.directories.length} 个目录 · {state.total} 部影片
        </Text>
      </Group>
      {library.watcher && <DirectoryWatchControl service={library.watcher} />}
      {library.documents && <LibraryDocumentsPanel service={library.documents} />}
      {library.organization && <FileOrganizationPanel service={library.organization} />}
      {state.error && (
        <Alert color="red" title="媒体库连接失败" role="alert">
          {state.error}
        </Alert>
      )}
      {!state.available && (
        <Text size="sm" c="dimmed">
          请在桌面应用中添加和扫描本机目录。
        </Text>
      )}
      {scan && (
        <Paper withBorder p="md">
          <Stack gap="sm">
            <Group justify="space-between">
              <Text component="output" fw={600} aria-live="polite">
                {labels[scan.state]}
              </Text>
              {scanning ? (
                <Button
                  size="compact-xs"
                  variant="default"
                  loading={pending}
                  onClick={() => void perform(() => library.cancel())}
                >
                  停止扫描
                </Button>
              ) : (
                <Button size="compact-xs" variant="subtle" onClick={() => go("library")}>
                  查看片库
                </Button>
              )}
            </Group>
            {scanning && (
              <Progress
                value={scan.discovered ? (scan.processed / scan.discovered) * 100 : 0}
                animated
                aria-label="当前已发现文件的处理进度"
              />
            )}
            <Text size="sm">
              已处理 {scan.processed} / 已发现 {scan.discovered} · 新增或更新 {scan.imported} ·
              视频未变化 {scan.unchanged} · 非视频 {scan.skipped}
            </Text>
            {scanning && (
              <Text size="xs" c="dimmed">
                发现数量会随扫描增加，停止后保留已导入的影片。
              </Text>
            )}
            {scan.current && (
              <Text size="xs" c="dimmed" truncate title={scan.current}>
                {scan.current}
              </Text>
            )}
            {scan.warnings > 0 && (
              <Alert color="yellow" title={`${scan.warnings} 项兼容提示`}>
                <Stack gap={5} mah={160} style={{ overflowY: "auto" }}>
                  {scan.notices.map((item, index) => (
                    <Text
                      key={`${item.path}-${index}`}
                      size="xs"
                      style={{ overflowWrap: "anywhere" }}
                    >
                      {item.path}：{item.message}
                    </Text>
                  ))}
                </Stack>
                <Text size="xs" mt="xs">
                  原始 NFO 保持原样，已读取的内容保存了快照。
                </Text>
              </Alert>
            )}
            {scan.errors > 0 && (
              <Alert color="yellow" title={`${scan.errors} 项需要处理，已有资料已保留`}>
                <Stack gap={5} mah={200} style={{ overflow: "auto" }}>
                  {scan.issues.map((issue, index) => (
                    <Text
                      key={`${index}:${issue.path}`}
                      size="xs"
                      style={{ overflowWrap: "anywhere" }}
                    >
                      {issue.path}：{issue.message}
                    </Text>
                  ))}
                </Stack>
                {scan.errors > scan.issues.length && (
                  <Text size="xs" mt="xs">
                    显示前 {scan.issues.length} 项。处理后可重新扫描。
                  </Text>
                )}
              </Alert>
            )}
          </Stack>
        </Paper>
      )}
      {state.directories.length > 0 && (
        <Paper withBorder style={{ overflow: "hidden" }}>
          <Table highlightOnHover verticalSpacing="sm" layout="fixed">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>路径</Table.Th>
                <Table.Th w={100} ta="center">
                  视频数量
                </Table.Th>
                <Table.Th w={125} ta="center">
                  操作
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {state.directories.map((directory) => (
                <ObjectMenu
                  key={directory.id}
                  items={
                    <>
                      <Menu.Item
                        leftSection={<Icon name="folder" />}
                        disabled={!state.available || pending}
                        onClick={() => void perform(() => openMediaDirectory(directory.path))}
                      >
                        打开目录
                      </Menu.Item>
                      <Menu.Item
                        leftSection={<Icon name="refresh" />}
                        disabled={disabled}
                        onClick={() => void perform(() => library.scan(directory.id))}
                      >
                        重新扫描
                      </Menu.Item>
                      <Menu.Divider />
                      <Menu.Item
                        color="red"
                        leftSection={<Icon name="trash" />}
                        disabled={disabled}
                        onClick={() => requestRemove(directory)}
                      >
                        删除目录
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
                      <Text size="sm" truncate title={directory.path}>
                        {directory.path}
                      </Text>
                      <Group gap="xs" mt={4} wrap="nowrap">
                        <Badge
                          size="xs"
                          variant="light"
                          color={
                            directory.state === "failed"
                              ? "red"
                              : directory.state === "partial"
                                ? "yellow"
                                : "gray"
                          }
                        >
                          {labels[directory.state]}
                        </Badge>
                        <Text
                          size="xs"
                          c="dimmed"
                          truncate
                          title={
                            directory.formats.length
                              ? directory.formats.join(" / ")
                              : "全部内置视频格式"
                          }
                        >
                          {directory.recursive ? "包含子目录" : "仅当前目录"}
                          {directory.scanned_at &&
                            ` · 最近扫描 ${new Date(`${directory.scanned_at.replace(" ", "T")}Z`).toLocaleString()}`}
                        </Text>
                      </Group>
                      {directory.error && (
                        <Text size="xs" c="red" style={{ overflowWrap: "anywhere" }}>
                          {directory.error}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td ta="center" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {directory.video_count}
                    </Table.Td>
                    <Table.Td>
                      <Group justify="center" gap={4} wrap="nowrap">
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={`打开目录 ${directory.path}`}
                          title="打开目录"
                          disabled={!state.available || pending}
                          onClick={() => void perform(() => openMediaDirectory(directory.path))}
                        >
                          <Icon name="folder" size={17} />
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={`重新扫描 ${directory.path}`}
                          title="重新扫描"
                          disabled={disabled}
                          onClick={() => void perform(() => library.scan(directory.id))}
                        >
                          <Icon name="refresh" size={17} />
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label={`删除目录 ${directory.path}`}
                          title={scanning ? "请先停止扫描，再删除目录" : "删除目录"}
                          disabled={disabled}
                          onClick={() => requestRemove(directory)}
                        >
                          <Icon name="trash" size={17} />
                        </ActionIcon>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                </ObjectMenu>
              ))}
            </Table.Tbody>
          </Table>
        </Paper>
      )}
      {!state.directories.length && (
        <Empty
          icon="folder"
          title={state.ready ? "还没有媒体目录" : "正在读取媒体目录"}
          description="添加文件夹，自动读取视频参数与本地 NFO 资料。"
        >
          <Button
            disabled={disabled}
            leftSection={<Icon name="plus" size={16} />}
            onClick={() => add("import")}
          >
            添加媒体目录
          </Button>
        </Empty>
      )}
      <Modal
        opened={!!removing}
        onClose={closeRemove}
        title="删除目录"
        centered
        closeOnClickOutside={!pending}
        closeOnEscape={!pending}
        withCloseButton={!pending}
      >
        <Stack gap="md">
          <Text size="sm" style={{ overflowWrap: "anywhere" }}>
            {removing?.path}
          </Text>
          <Text size="sm">
            停止管理和扫描此目录。已有作品、收藏、资源关联以及磁盘文件均会保留。
          </Text>
          {removeError && (
            <Alert color="red" role="alert">
              {removeError}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" disabled={pending} data-autofocus onClick={closeRemove}>
              取消
            </Button>
            <Button color="red" loading={pending} disabled={disabled} onClick={removeDirectory}>
              删除目录
            </Button>
          </Group>
        </Stack>
      </Modal>
      {library.maintenance && (
        <LibraryMaintenanceModal
          service={library.maintenance}
          opened={maintenanceOpened}
          onClose={() => setMaintenanceOpened(false)}
        />
      )}
    </Stack>
  );
}
