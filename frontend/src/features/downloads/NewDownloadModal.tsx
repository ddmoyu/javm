import { t, localizeOptions, useLocale } from "../../i18n/index";
import { useState, useSyncExternalStore } from "react";
import {
  Button,
  Collapse,
  Group,
  Modal,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import * as os from "../../platform/neutralino/privateDialogs";
import { useWorkspace } from "../../app/state";
import { Icon } from "../../components/icons";
import { parseHeaders } from "../../services/downloads/input";
import { describeError } from "../../services/downloads/DownloadService";
import { DownloadAdditionCancelledError } from "../../services/downloads/duplicates";
import type { NewDownload } from "../../contracts/downloads";
import type { Film } from "../../contracts/media";

export function NewDownloadModal({
  opened,
  film,
  initial,
  onClose,
}: {
  opened: boolean;
  film?: Film;
  initial?: { url: string; name: string };
  onClose: () => void;
}) {
  useLocale();
  const { downloads, go, notice } = useWorkspace();
  const state = useSyncExternalStore(downloads.subscribe, downloads.getControls);
  const confirmation = useSyncExternalStore(downloads.subscribe, downloads.getConfirmation);
  const [urls, setUrls] = useState(initial?.url ?? "");
  const [directory, setDirectory] = useState(downloads.getSnapshot().settings.directory);
  const [name, setName] = useState(initial?.name ?? film?.code ?? "");
  const [headers, setHeaders] = useState("");
  const [kind, setKind] = useState<NewDownload["kind"]>("auto");
  const [extra, setExtra] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const select = async () => {
    setBusy(true);
    try {
      const picked = await os.showFolderDialog(t("选择下载目录"), {
        defaultPath: directory || state.settings.directory,
      });
      if (picked) setDirectory(picked);
    } catch (error) {
      setError(describeError(error));
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const count = await downloads.add({
        urls: urls
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean),
        directory: directory || state.settings.directory,
        name,
        kind,
        headers: parseHeaders(headers),
        workId: film ? String(film.id) : undefined,
        code: film?.code,
      });
      onClose();
      go("downloads");
      notice(`已加入 ${count} 个下载任务`);
    } catch (error) {
      if (error instanceof DownloadAdditionCancelledError) onClose();
      else setError(describeError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t("新建下载")}
      centered
      size="md"
      closeOnClickOutside={!busy}
      closeOnEscape={!busy}
      withCloseButton={!busy}
      trapFocus={!confirmation}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Stack gap="md">
          {film && <Text size="sm">{t("下载完成后关联到：{0} {1}", film.code, film.title)}</Text>}
          <Textarea
            label={t("视频链接")}
            placeholder={t("MP4 或 m3u8 直链，每行一条")}
            description={t("下载完成后自动入库并刮削；无法识别番号时可手动确认。")}
            minRows={4}
            autosize
            value={urls}
            onChange={(event) => setUrls(event.currentTarget.value)}
            disabled={busy}
            data-autofocus
          />
          <Group align="flex-end" gap="xs" wrap="nowrap">
            <TextInput
              style={{ flex: 1 }}
              label={t("保存目录")}
              placeholder={state.settings.directory || t("选择保存位置")}
              value={directory}
              onChange={(event) => setDirectory(event.currentTarget.value)}
              disabled={busy}
            />
            <Button
              variant="default"
              onClick={() => void select()}
              disabled={!state.available || busy}
              aria-label={t("选择下载目录")}
            >
              <Icon name="folder" />
            </Button>
          </Group>
          <Button
            variant="subtle"
            color="gray"
            size="compact-sm"
            aria-expanded={extra}
            rightSection={<Icon name="down" size={14} />}
            onClick={() => setExtra(!extra)}
          >
            {t("调整本次选项")}
          </Button>
          <Collapse expanded={extra}>
            <Stack gap="sm">
              <TextInput
                label={t("文件名")}
                placeholder={t("留空时根据链接命名")}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                disabled={busy}
              />
              <Select
                label={t("资源类型")}
                value={kind}
                allowDeselect={false}
                data={localizeOptions([
                  { value: "auto", label: "自动识别" },
                  { value: "hls", label: "m3u8 / HLS" },
                  { value: "http", label: "MP4 直链" },
                ])}
                onChange={(value) => setKind(value as NewDownload["kind"])}
                disabled={busy}
                description={t("无后缀的 HLS 地址请选择 m3u8。")}
              />
              <Textarea
                label={t("请求头")}
                placeholder={"Referer: https://example.com/\nUser-Agent: ..."}
                description={t("按下载请求要求填写，每行一条；随任务保存在本机。")}
                minRows={2}
                autosize
                value={headers}
                onChange={(event) => setHeaders(event.currentTarget.value)}
                disabled={busy}
              />
            </Stack>
          </Collapse>
          {!state.available && (
            <Text size="sm" c="dimmed">
              {t("下载需在 Windows 桌面应用中进行。")}
            </Text>
          )}
          {(error || state.error) && (
            <Text role="alert" size="sm" c="red">
              {t(error || state.error)}
            </Text>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={busy}>
              {t("取消")}
            </Button>
            <Button
              type="submit"
              loading={busy}
              disabled={!state.available || !state.ready || !!state.error}
              leftSection={<Icon name="download" size={16} />}
            >
              {t("加入下载")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
