import { useState } from "react";
import { Alert, Button, Group, Modal, NumberInput, Stack, Text } from "@mantine/core";
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
  const [busy, setBusy] = useState(false),
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
      title="分卷设置"
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
        {error && <Alert color="red">{error}</Alert>}
        <Button
          loading={busy}
          onClick={() =>
            void run(async () => {
              await library.relatedMedia("save", { id: file.id, part, parts });
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
