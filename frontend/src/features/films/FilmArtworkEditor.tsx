import { useState } from "react";
import { Button, Checkbox, Group, Modal, Select, Stack, Text } from "@mantine/core";
import type { Film } from "../../contracts/media";
import { useWorkspace } from "../../app/state";
import { useImagePreview } from "../../components/ImagePreview";

export type ArtworkMode = "cover" | "capture" | "fetch" | "long";
export function FilmArtworkEditor({
  film,
  mode,
  onClose,
}: {
  film: Film;
  mode: ArtworkMode;
  onClose: () => void;
}) {
  const { unavailable } = useWorkspace();
  const { opened } = useImagePreview();
  const [count, setCount] = useState<string | null>("6");
  const title = {
    cover: "选取封面",
    capture: "截取视频截图",
    fetch: "获取封面与截图",
    long: "获取长截图",
  }[mode];
  return (
    <Modal
      opened
      onClose={onClose}
      title={title}
      centered
      size="md"
      zIndex={400}
      trapFocus={!opened}
      closeOnEscape={!opened}
    >
      <Stack>
        <Text size="sm" fw={600}>
          {film.title}
        </Text>
        {mode === "fetch" ? (
          <>
            <Checkbox label="获取封面" defaultChecked />
            <Checkbox label="获取截图" defaultChecked />
          </>
        ) : (
          <Select
            label="截图数量"
            value={count}
            onChange={setCount}
            data={["1", "6", "12", "24"]}
            allowDeselect={false}
          />
        )}
        <Text size="sm" c="dimmed">
          {mode === "fetch" ? "图片获取服务暂未接入。" : "视频截图服务暂未接入。"}
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => unavailable(mode === "fetch" ? "图片获取" : "视频截图")}>
            开始处理
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
