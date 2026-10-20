import { getLocale, t, useLocale } from "../../i18n/index";
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
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { useWorkspace } from "../../app/state";
import { Icon } from "../../components/icons";
import { Empty } from "../../components/ui";
import { ObjectMenu, objectMenuKey } from "../../components/ObjectMenu";
import type { MediaDirectory } from "../../contracts/library";
import { libraryError } from "../../services/library/LibraryService";
import { openMediaDirectory } from "../../platform/neutralino/directoryPicker";
import { LibraryMaintenanceModal } from "./LibraryMaintenanceModal";
import type { MaintenanceMode } from "../../contracts/maintenance";
import { DirectoryWatchControl } from "./DirectoryWatchControl";
import { FileOrganizationPanel } from "./FileOrganizationPanel";
import { DirectoryScanStatus, scanLabels } from "./DirectoryScanStatus";

export function Directories() {
  useLocale();
  const { add, library, libraryState: state, notice, go } = useWorkspace();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [removing, setRemoving] = useState<MediaDirectory | null>(null);
  const [removeError, setRemoveError] = useState("");
  const [maintenanceOpened, setMaintenanceOpened] = useState(false);
  const scanning = state.scan?.state === "scanning";
  const scan = state.scan;
  const disabled = scanning || pending || !state.available || !state.ready;
  const openMaintenance = (mode: MaintenanceMode) => {
    if (disabled || !library.maintenance) return;
    setMaintenanceOpened(true);
    void library.maintenance.scan(mode);
  };
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
    <Stack gap="sm">
      <Group justify="space-between" gap="sm">
        <Group gap="xs">
          <Button
            size="xs"
            leftSection={<Icon name="plus" size={15} />}
            disabled={disabled}
            onClick={() => add("import")}
          >
            {t("添加目录")}
          </Button>
          <ActionIcon
            variant="default"
            size="input-xs"
            aria-label={t("刷新列表")}
            title={t("刷新列表")}
            loading={pending}
            onClick={() => void perform(() => library.refresh())}
          >
            <Icon name="refresh" size={15} />
          </ActionIcon>
          <Menu position="bottom-start">
            <Menu.Target>
              <Button
                variant="default"
                size="xs"
                rightSection={<Icon name="down" size={13} />}
                disabled={disabled || !library.maintenance}
              >
                {t("目录工具")}
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<Icon name="copy" size={16} />}
                disabled={disabled}
                onClick={() => openMaintenance("duplicates")}
              >
                {t("重复视频")}
              </Menu.Item>
              <Menu.Item
                leftSection={<Icon name="filter" size={16} />}
                disabled={disabled}
                onClick={() => openMaintenance("ads")}
              >
                {t("广告视频")}
              </Menu.Item>
              <Menu.Item
                leftSection={<Icon name="shield" size={16} />}
                disabled={disabled}
                onClick={() => openMaintenance("health")}
              >
                {t("健康检查")}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
          {library.organization && <FileOrganizationPanel service={library.organization} />}
        </Group>
        <Group gap="md">
          {library.watcher && <DirectoryWatchControl service={library.watcher} />}
          <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
            {t("{0} 个目录 · {1} 部影片", state.directories.length, state.total)}
          </Text>
        </Group>
      </Group>
      {state.error && (
        <Alert color="red" title={t("媒体库连接失败")} role="alert">
          {t(state.error)}
        </Alert>
      )}
      {!state.available && (
        <Text size="sm" c="dimmed">
          {t("请在桌面应用中添加和扫描本机目录。")}
        </Text>
      )}
      {scan && (
        <DirectoryScanStatus
          scan={scan}
          pending={pending}
          onCancel={() => void perform(() => library.cancel())}
          onOpenLibrary={() => go("library")}
        />
      )}
      {state.directories.length > 0 && (
        <Paper withBorder style={{ overflow: "hidden" }}>
          <Table highlightOnHover verticalSpacing="sm" layout="fixed">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t("路径")}</Table.Th>
                <Table.Th w={100} ta="center">
                  {t("视频数量")}
                </Table.Th>
                <Table.Th w={125} ta="center">
                  {t("操作")}
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
                        {t("打开目录")}
                      </Menu.Item>
                      <Menu.Item
                        leftSection={<Icon name="refresh" />}
                        disabled={disabled}
                        onClick={() => void perform(() => library.scan(directory.id))}
                      >
                        {t("重新扫描")}
                      </Menu.Item>
                      <Menu.Divider />
                      <Menu.Item
                        color="red"
                        leftSection={<Icon name="trash" />}
                        disabled={disabled}
                        onClick={() => requestRemove(directory)}
                      >
                        {t("删除目录")}
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
                          {scanLabels[directory.state]}
                        </Badge>
                        <Text
                          size="xs"
                          c="dimmed"
                          truncate
                          title={
                            directory.formats.length
                              ? t(directory.formats.join(" / "))
                              : t("全部内置视频格式")
                          }
                        >
                          {directory.recursive ? t("包含子目录") : t("仅当前目录")}
                          {directory.scanned_at &&
                            t(
                              " · 最近扫描 {0}",
                              t(
                                new Date(
                                  `${directory.scanned_at.replace(" ", "T")}Z`,
                                ).toLocaleString(getLocale()),
                              ),
                            )}
                        </Text>
                      </Group>
                      {directory.error && (
                        <Text size="xs" c="red" style={{ overflowWrap: "anywhere" }}>
                          {t(directory.error)}
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
                          aria-label={t("打开目录 {0}", directory.path)}
                          title={t("打开目录")}
                          disabled={!state.available || pending}
                          onClick={() => void perform(() => openMediaDirectory(directory.path))}
                        >
                          <Icon name="folder" size={17} />
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={t("重新扫描 {0}", directory.path)}
                          title={t("重新扫描")}
                          disabled={disabled}
                          onClick={() => void perform(() => library.scan(directory.id))}
                        >
                          <Icon name="refresh" size={17} />
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label={t("删除目录 {0}", directory.path)}
                          title={scanning ? t("请先停止扫描，再删除目录") : t("删除目录")}
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
          title={state.ready ? t("还没有媒体目录") : t("正在读取媒体目录")}
          description={t("添加文件夹，自动读取视频参数与本地 NFO 资料。")}
        >
          <Button
            disabled={disabled}
            leftSection={<Icon name="plus" size={16} />}
            onClick={() => add("import")}
          >
            {t("添加媒体目录")}
          </Button>
        </Empty>
      )}
      <Modal
        opened={!!removing}
        onClose={closeRemove}
        title={t("删除目录")}
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
            {t("停止管理和扫描此目录。已有作品、收藏、资源关联以及磁盘文件均会保留。")}
          </Text>
          {removeError && (
            <Alert color="red" role="alert">
              {t(removeError)}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" disabled={pending} data-autofocus onClick={closeRemove}>
              {t("取消")}
            </Button>
            <Button color="red" loading={pending} disabled={disabled} onClick={removeDirectory}>
              {t("删除目录")}
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
