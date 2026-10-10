import { useState } from "react";
import {
  Button,
  Checkbox,
  Group,
  Modal,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import type { Film } from "./data";
import { allFrames, scenes, Still, timestamp } from "./Cover";
import { Icon } from "./icons";
import { usePrototype } from "./state";

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
  const { setFilms, notice } = usePrototype();
  const [selected, setSelected] = useState<number[]>(
    mode === "cover" ? [film.coverFrame ?? 0] : allFrames,
  );
  const [updateCover, setUpdateCover] = useState(true);
  const [updateScreenshots, setUpdateScreenshots] = useState(true);
  const title = {
    cover: "选取封面",
    capture: "截取视频截图",
    fetch: "获取封面与截图",
    long: "获取长截图",
  }[mode];
  const save = () => {
    setFilms((previous) =>
      previous.map((item) =>
        item.id === film.id
          ? {
              ...item,
              ...(mode === "cover" || (mode === "fetch" && updateCover)
                ? { coverFrame: selected[0] ?? 0 }
                : {}),
              ...(mode === "capture" || (mode === "fetch" && updateScreenshots)
                ? { previewFrames: selected }
                : {}),
              ...(mode === "long" ? { hasLongScreenshot: true } : {}),
            }
          : item,
      ),
    );
    notice(mode === "cover" ? "封面已更新" : mode === "long" ? "长截图已保存" : "图片已更新");
    onClose();
  };
  return (
    <Modal
      opened
      onClose={onClose}
      title={title}
      size={760}
      centered
      zIndex={400}
      returnFocus={false}
    >
      {mode === "fetch" && (
        <Group align="flex-end" mb="md" gap="lg">
          <Select
            label="资料来源"
            defaultValue="首选资料源"
            data={["首选资料源", "MetaTube"]}
            allowDeselect={false}
            w={220}
          />
          <Checkbox
            label="更新封面"
            checked={updateCover}
            onChange={(event) => setUpdateCover(event.currentTarget.checked)}
          />
          <Checkbox
            label="更新截图"
            checked={updateScreenshots}
            onChange={(event) => setUpdateScreenshots(event.currentTarget.checked)}
          />
        </Group>
      )}
      {mode === "long" ? (
        <Paper withBorder radius="md" p={6}>
          <SimpleGrid cols={3} spacing={4} aria-label={`${film.title} 长截图`}>
            {Array.from({ length: 12 }, (_, index) => (
              <span key={index} className="thumb">
                <Still index={index % 6} label={scenes[index % 6]!} />
              </span>
            ))}
          </SimpleGrid>
        </Paper>
      ) : (
        <SimpleGrid cols={3} spacing="sm">
          {allFrames.map((index) => {
            const chosen = selected.includes(index);
            return (
              <UnstyledButton
                key={index}
                className="thumb candidate"
                data-active={chosen || undefined}
                aria-label={`选择画面 ${index + 1}`}
                aria-pressed={chosen}
                onClick={() =>
                  setSelected((previous) =>
                    mode === "cover"
                      ? [index]
                      : previous.includes(index)
                        ? previous.filter((value) => value !== index)
                        : [...previous, index].sort((a, b) => a - b),
                  )
                }
              >
                <Still index={index} label={scenes[index]!} />
                <time>{timestamp(film, index)}</time>
                {chosen && (
                  <span className="candidate-check">
                    <Icon name="check" size={14} />
                  </span>
                )}
              </UnstyledButton>
            );
          })}
        </SimpleGrid>
      )}
      <Group justify="flex-end" mt="lg">
        {mode === "capture" && (
          <Button variant="subtle" onClick={() => setSelected(allFrames)} mr="auto">
            选取全部画面
          </Button>
        )}
        <Button variant="default" onClick={onClose}>
          取消
        </Button>
        <Button
          disabled={
            mode !== "long" &&
            (!selected.length || (mode === "fetch" && !updateCover && !updateScreenshots))
          }
          onClick={save}
        >
          {mode === "cover"
            ? "设为封面"
            : mode === "long"
              ? "保存长截图"
              : mode === "fetch"
                ? "应用图片"
                : `保存 ${selected.length} 张截图`}
        </Button>
      </Group>
      <Stack gap={0} mt="xs">
        <Text size="xs" c="dimmed">
          画面为抽象占位图，正式版本来自视频抽帧。
        </Text>
      </Stack>
    </Modal>
  );
}
