import { useState } from "react";
import { Alert, Button, Group, Modal, Select, Stack, Text } from "@mantine/core";
import type { Film } from "../../contracts/media";
import { useWorkspace } from "../../app/state";
import { libraryError } from "../../services/library/LibraryService";

export function FilmDeleteDialog({ film, onClose }: { film: Film; onClose: () => void }) {
  const { library, notice } = useWorkspace();
  const videos = film.files?.filter((file) => file.kind === "video" && file.id && file.path) ?? [];
  const [videoId, setVideoId] = useState<string | null>(videos[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const video = videos.find((file) => file.id === videoId);
  const service = library.maintenance;
  const deleteVideo = async () => {
    if (busy || !service || !video?.id) return;
    setBusy(true);
    setError("");
    try {
      await service.removeResource({ id: video.id, path: video.path });
      onClose();
      notice("视频已删除，影片资料和收藏已保留。");
    } catch (reason) {
      setError(libraryError(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      opened
      onClose={() => !busy && onClose()}
      title="删除视频"
      centered
      withCloseButton={!busy}
      closeOnClickOutside={!busy}
      closeOnEscape={!busy}
    >
      <Stack>
        <Text size="sm" fw={600}>
          {film.title}
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
          {video?.path ?? "没有可删除的视频文件。"}
        </Text>
        <Text size="sm">将永久删除这个视频文件，无法撤销。</Text>
        <Text size="sm" c="dimmed">
          影片资料、收藏、NFO、封面和截图会保留。最后一个视频删除后，影片显示为“未下载”。
        </Text>
        {error && (
          <Alert color="red" title="删除失败" role="alert">
            {error}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            color="red"
            loading={busy}
            disabled={!video || !service}
            onClick={() => void deleteVideo()}
          >
            删除视频
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
