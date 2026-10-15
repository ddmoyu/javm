import { t, useLocale } from "../../i18n/index";
import { useImperativeHandle, useRef, useState } from "react";
import type { Ref } from "react";
import {
  Accordion,
  Alert,
  Button,
  Checkbox,
  Divider,
  Group,
  Modal,
  Paper,
  Stack,
  TagsInput,
  Text,
  ThemeIcon,
} from "@mantine/core";
import { Icon } from "../../components/icons";
import type { Runtime } from "../../platform/neutralino/bootstrap";
import { selectMediaDirectory } from "../../platform/neutralino/directoryPicker";
import { useWorkspace } from "../../app/state";
import { libraryError } from "../../services/library/LibraryService";

const videoFormatOptions = [
  "mp4",
  "mkv",
  "avi",
  "ts",
  "mov",
  "wmv",
  "flv",
  "webm",
  "m4v",
  "m2ts",
  "mpg",
  "mpeg",
  "rmvb",
  "vob",
];
const defaultVideoFormats: string[] = [];

export interface AddMediaDirectoryHandle {
  open: () => void;
}

export function AddMediaDirectoryModal({
  ref,
  runtime,
}: {
  ref: Ref<AddMediaDirectoryHandle>;
  runtime: Runtime;
}) {
  useLocale();
  const { library, libraryState, go, notice } = useWorkspace();
  const [opened, setOpened] = useState(false);
  const [path, setPath] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [includeSubdirectories, setIncludeSubdirectories] = useState(true);
  const [optionsExpanded, setOptionsExpanded] = useState(false);
  const [videoFormats, setVideoFormats] = useState<string[]>(defaultVideoFormats);
  const [error, setError] = useState("");
  const pendingSelection = useRef(false);
  const pendingImport = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const locked = selecting || submitting;
  const desktop = runtime === "desktop";
  const folderName =
    path
      .split(/[\\/]+/)
      .filter(Boolean)
      .at(-1) || path;

  const chooseFolder = async (currentPath = path) => {
    if (!desktop || pendingSelection.current || pendingImport.current) return;
    pendingSelection.current = true;
    setSelecting(true);
    setError("");
    try {
      const selected = await selectMediaDirectory(currentPath);
      // 系统选择器取消时返回空字符串，保留之前选中的目录。
      if (selected) setPath(selected);
    } catch {
      setError("无法打开文件夹选择器，请重试。");
    } finally {
      pendingSelection.current = false;
      setSelecting(false);
    }
  };

  useImperativeHandle(ref, () => ({
    open: () => {
      if (pendingSelection.current || pendingImport.current) return;
      setPath("");
      setError("");
      setIncludeSubdirectories(true);
      setOptionsExpanded(false);
      setVideoFormats(defaultVideoFormats);
      setOpened(true);
    },
  }));

  const close = () => {
    if (!pendingSelection.current && !pendingImport.current) setOpened(false);
  };

  const submit = async () => {
    if (!path || pendingSelection.current || pendingImport.current) return;
    pendingImport.current = true;
    setSubmitting(true);
    setError("");
    try {
      await library.add({ path, recursive: includeSubdirectories, formats: videoFormats });
      setOpened(false);
      go("directories");
      notice("已开始扫描目录，可以切换页面继续使用。");
    } catch (error) {
      setError(libraryError(error));
    } finally {
      pendingImport.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={close}
      title={t("添加媒体目录")}
      centered
      size={520}
      trapFocus={!selecting}
      closeOnEscape={!locked}
      closeOnClickOutside={!locked}
      withCloseButton={!locked}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Stack gap="lg">
          <Text size="sm" c="dimmed">
            {t("选择存放影片的文件夹，集中管理本地媒体。")}
          </Text>
          <Paper withBorder p="md">
            <Stack gap="md">
              <Group align="flex-start" wrap="nowrap" gap="md">
                <ThemeIcon variant="light" size={44} radius="md">
                  <Icon name="folder" size={24} />
                </ThemeIcon>
                <Stack gap={4} style={{ minWidth: 0, flex: 1 }} aria-live="polite">
                  <Text size="xs" c="dimmed">
                    {t("媒体目录")}
                  </Text>
                  <Text fw={600} style={{ overflowWrap: "anywhere" }}>
                    {path ? folderName : t("尚未选择文件夹")}
                  </Text>
                  <Text size="sm" c="dimmed" style={{ overflowWrap: "anywhere" }}>
                    {path || t("通过系统文件夹选择器选择，无需手动输入路径。")}
                  </Text>
                </Stack>
              </Group>
              <Button
                type="button"
                variant={path ? "light" : "filled"}
                leftSection={<Icon name="folder" size={16} />}
                loading={selecting}
                disabled={!desktop || submitting}
                onClick={() => void chooseFolder()}
                data-autofocus
                fullWidth
              >
                {path ? t("更换目录") : t("选择文件夹")}
              </Button>
              {!desktop && (
                <Text size="xs" c="dimmed">
                  {t("请在桌面应用中选择本机文件夹。")}
                </Text>
              )}
            </Stack>
          </Paper>
          <Accordion
            variant="separated"
            value={optionsExpanded ? "options" : null}
            onChange={(value) => setOptionsExpanded(value === "options")}
            chevron={<Icon name="down" size={16} />}
          >
            <Accordion.Item value="options">
              <Accordion.Control disabled={locked}>{t("导入选项")}</Accordion.Control>
              <Accordion.Panel>
                <Stack gap="md">
                  <Checkbox
                    label={t("包含子目录")}
                    description={t("同时查找所选文件夹下的影片")}
                    checked={includeSubdirectories}
                    onChange={(event) => setIncludeSubdirectories(event.currentTarget.checked)}
                    disabled={locked}
                  />
                  <TagsInput
                    label={t("视频格式")}
                    description={t("留空使用全部内置视频格式，也可输入其他扩展名")}
                    placeholder={t("选择或输入格式")}
                    data={videoFormatOptions}
                    value={videoFormats}
                    onChange={(formats) =>
                      setVideoFormats([
                        ...new Set(
                          formats
                            .map((format) => format.trim().replace(/^\.+/, "").toLowerCase())
                            .filter(Boolean),
                        ),
                      ])
                    }
                    splitChars={[",", "，", " "]}
                    clearable
                    disabled={locked}
                    comboboxProps={{ withinPortal: false }}
                  />
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
          {error && (
            <Alert color="red" icon={<Icon name="info" size={16} />} role="alert">
              {t(error)}
            </Alert>
          )}
          <Divider />
          <Group justify="flex-end">
            <Button variant="default" onClick={close} disabled={locked}>
              {t("取消")}
            </Button>
            <Button
              type="submit"
              disabled={!path || selecting || libraryState.scan?.state === "scanning"}
              loading={submitting}
              leftSection={<Icon name="plus" size={16} />}
            >
              {t("开始导入")}
            </Button>
          </Group>
          {libraryState.scan?.state === "scanning" && (
            <Text size="xs" c="dimmed">
              {t("已有目录正在扫描，完成后即可添加。")}
            </Text>
          )}
        </Stack>
      </form>
    </Modal>
  );
}
