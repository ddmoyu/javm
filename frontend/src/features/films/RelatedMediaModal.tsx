import { useState } from "react";
import { Alert, Button, Group, Modal, NumberInput, Stack, Text } from "@mantine/core";
import { os } from "@neutralinojs/lib";
import type { MediaFile } from "../../contracts/media";
import type { LibraryService } from "../../services/library/LibraryService";
export function RelatedMediaModal({
  file,
  library,
  onClose,
}: {
  file: MediaFile;
  library: LibraryService;
  onClose(): void;
}) {
  const [part, setPart] = useState(file.part ?? 0),
    [parts, setParts] = useState(file.parts ?? 0);
  const [subtitles, setSubtitles] = useState(file.subtitles ?? []),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "关联失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      opened
      title="分卷与本地字幕"
      onClose={() => !busy && onClose()}
      closeOnEscape={!busy}
      closeOnClickOutside={!busy}
      centered
    >
      <Stack>
        <Text size="sm">{file.name}</Text>
        <Group grow>
          <NumberInput
            label="分卷序号（0 为未分卷）"
            min={0}
            max={99}
            value={part}
            onChange={(v) => setPart(Number(v))}
          />
          <NumberInput
            label="总卷数（0 为未知）"
            min={0}
            max={99}
            value={parts}
            onChange={(v) => setParts(Number(v))}
          />
        </Group>
        <Text size="xs" c="dimmed">
          从本地选择已有字幕，或查找视频同目录下的同名字幕，最多关联 16 个。内置播放支持
          SRT／VTT，以及 ASS／SSA 的纯文本字幕。外部播放器由其自身设置加载字幕。
        </Text>
        {subtitles.map((path) => (
          <Group key={path} justify="space-between">
            <Text size="xs" style={{ overflowWrap: "anywhere", flex: 1 }}>
              {path}
            </Text>
            <Button
              size="xs"
              variant="subtle"
              disabled={busy}
              onClick={() => setSubtitles(subtitles.filter((v) => v !== path))}
            >
              移除关联
            </Button>
          </Group>
        ))}
        <Group>
          <Button
            size="xs"
            disabled={busy}
            variant="default"
            onClick={() =>
              void run(async () => {
                const picked = await os.showOpenDialog("选择本地字幕", {
                  multiSelections: true,
                  filters: [{ name: "字幕", extensions: ["srt", "vtt", "ass", "ssa"] }],
                });
                const next = [...new Set([...subtitles, ...picked])];
                if (next.length > 16) throw new Error("最多关联 16 个字幕");
                setSubtitles(next);
              })
            }
          >
            选择本地字幕
          </Button>
          <Button
            size="xs"
            disabled={busy}
            variant="default"
            onClick={() =>
              void run(async () => {
                const found = await library.relatedMedia<string[]>("discover", { id: file.id });
                setSubtitles([...new Set([...subtitles, ...found])].slice(0, 16));
              })
            }
          >
            查找同名字幕
          </Button>
        </Group>
        {error && <Alert color="red">{error}</Alert>}
        <Button
          loading={busy}
          onClick={() =>
            void run(async () => {
              await library.relatedMedia("save", { id: file.id, part, parts, subtitles });
              onClose();
            })
          }
        >
          保存关联
        </Button>
      </Stack>
    </Modal>
  );
}
