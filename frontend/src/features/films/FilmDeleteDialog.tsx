import { useEffect, useState, useSyncExternalStore } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Loader,
  Modal,
  Pagination,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import type { Film } from "../../contracts/media";
import type { WorkRemovalPreview } from "../../contracts/maintenance";
import { useWorkspace } from "../../app/state";
import { libraryError } from "../../services/library/LibraryService";

const noSubscribe = () => () => {};
const noSnapshot = () => null;
const fileLabels = { video: "视频", nfo: "NFO", image: "图片", backup: "NFO 备份" };
const pageSize = 20;

export function FilmDeleteDialog({ film, onClose }: { film: Film; onClose: () => void }) {
  const { library, notice } = useWorkspace();
  const videos = film.files?.filter((file) => file.kind === "video" && file.id && file.path) ?? [];
  const [videoId, setVideoId] = useState<string | null>(videos[0]?.id ?? null);
  const [deleteAll, setDeleteAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<WorkRemovalPreview | null>(null);
  const [reading, setReading] = useState(false);
  const [reload, setReload] = useState(0);
  const [listPage, setListPage] = useState(1);
  const video = videos.find((file) => file.id === videoId);
  const service = library.maintenance;
  const progress = useSyncExternalStore(
    service?.subscribe ?? noSubscribe,
    service?.getSnapshot ?? noSnapshot,
  );

  useEffect(() => {
    if (!deleteAll || !service) return;
    let active = true;
    void service
      .previewWorkRemoval(String(film.id))
      .then(
        (value) => {
          if (active) setPreview(value);
        },
        (reason: unknown) => {
          if (active) setError(libraryError(reason));
        },
      )
      .finally(() => {
        if (active) setReading(false);
      });
    return () => {
      active = false;
    };
  }, [deleteAll, film.id, service, reload]);

  const remove = async () => {
    if (busy || !service || (deleteAll ? !preview : !video?.id)) return;
    setBusy(true);
    setError("");
    try {
      if (deleteAll) await service.removeWork(preview!);
      else await service.removeResource({ id: video!.id!, path: video!.path });
      onClose();
      notice(
        deleteAll
          ? `影片已从媒体库移除，关联视频和资料已删除。${preview!.preservedFiles.length ? `保留 ${preview!.preservedFiles.length} 个共享或不支持删除的文件。` : ""}`
          : "仅删除了选中的视频。影片资料、封面、截图和收藏仍保留在媒体库中。",
      );
    } catch (reason) {
      setError(
        `${libraryError(reason)}${deleteAll ? " 部分文件可能已经删除，请重新读取清单后核对。" : ""}`,
      );
      if (deleteAll) setPreview(null);
    } finally {
      setBusy(false);
    }
  };
  const entries = preview
    ? [
        ...preview.files.map((file) => ({
          path: file.path,
          label: `${fileLabels[file.kind]} · ${file.exists ? "将删除" : "文件已缺失"}`,
        })),
        ...preview.preservedFiles.map((file) => ({
          path: file.path,
          label: `保留 · ${file.reason}`,
        })),
      ]
    : [];

  return (
    <Modal
      opened
      onClose={() => !busy && onClose()}
      title="删除"
      centered
      withCloseButton={!busy}
      closeOnClickOutside={!busy}
      closeOnEscape={!busy}
      size="lg"
    >
      <Stack>
        <Text size="sm" fw={600}>
          {film.title}
        </Text>
        <Checkbox
          label="彻底删除影片"
          description="删除全部关联视频、NFO、封面、截图及 NFO 备份，同时移除媒体库记录和收藏。"
          checked={deleteAll}
          disabled={busy}
          onChange={(event) => {
            setDeleteAll(event.currentTarget.checked);
            setReading(event.currentTarget.checked);
            setListPage(1);
            setPreview(null);
            setError("");
          }}
        />
        {!deleteAll && (
          <>
            <Text size="sm" fw={600}>
              仅删除选中的视频，不删除影片资料。
            </Text>
            {videos.length > 1 && (
              <Select
                label="选择要删除的视频"
                description="每次只删除选中的一个文件"
                data={videos.map((file) => ({ value: file.id!, label: file.name }))}
                value={videoId}
                onChange={(value) => {
                  setVideoId(value);
                  setError("");
                }}
                allowDeselect={false}
                disabled={busy}
              />
            )}
            <Text size="sm" style={{ overflowWrap: "anywhere" }}>
              {video?.path ?? "没有本地视频。若要移除这张卡片及其资料，请勾选“彻底删除影片”。"}
            </Text>
            <Text size="sm" c="dimmed">
              NFO、封面、截图和收藏会保留，卡片仍显示在媒体库中。最后一个视频删除后显示“未下载”。
            </Text>
          </>
        )}
        {deleteAll && (
          <>
            {reading && (
              <Group gap="xs" component="output">
                <Loader size="xs" />
                <Text size="sm">正在读取关联文件…</Text>
              </Group>
            )}
            {preview && (
              <>
                <Text size="sm">
                  将删除 {preview.files.filter((file) => file.exists).length}{" "}
                  个文件，并移除影片卡片和收藏。
                </Text>
                {preview.preservedFiles.length > 0 && (
                  <Alert color="yellow" title="部分文件会保留">
                    {preview.preservedFiles.length}{" "}
                    个文件仍被其他影片使用或不支持安全删除，具体原因见清单。
                  </Alert>
                )}
                <Stack gap="xs" aria-label="删除文件清单">
                  {entries.slice((listPage - 1) * pageSize, listPage * pageSize).map((entry) => (
                    <div key={entry.path}>
                      <Text size="xs" c="dimmed">
                        {entry.label}
                      </Text>
                      <Text size="sm" style={{ overflowWrap: "anywhere" }}>
                        {entry.path}
                      </Text>
                    </div>
                  ))}
                </Stack>
                {entries.length > pageSize && (
                  <Pagination
                    total={Math.ceil(entries.length / pageSize)}
                    value={listPage}
                    onChange={setListPage}
                    size="sm"
                  />
                )}
              </>
            )}
          </>
        )}
        <Text size="sm" c="red">
          文件会被永久删除，无法撤销。
        </Text>
        {busy && (
          <Text size="sm" component="output">
            {progress?.cancelling
              ? "正在停止…"
              : `正在删除 ${progress?.processed ?? 0} / ${progress?.removalTotal ?? 0}…`}
          </Text>
        )}
        {error && (
          <Alert color="red" title="未完成删除" role="alert">
            {error}
          </Alert>
        )}
        <Group justify="flex-end">
          {deleteAll && !busy && (
            <Button
              variant="subtle"
              disabled={reading}
              onClick={() => {
                setPreview(null);
                setError("");
                setReading(true);
                setListPage(1);
                setReload((value) => value + 1);
              }}
            >
              重新读取清单
            </Button>
          )}
          <Button
            variant="default"
            data-autofocus
            disabled={busy && progress?.cancelling}
            onClick={() => (busy ? service?.cancel() : onClose())}
          >
            {busy ? "停止删除" : "取消"}
          </Button>
          <Button
            color="red"
            loading={busy}
            disabled={!service || (deleteAll ? !preview || reading : !video)}
            onClick={() => void remove()}
          >
            {deleteAll ? "彻底删除影片" : "仅删除视频"}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
