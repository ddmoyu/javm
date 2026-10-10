import { useState } from "react";
import { Button, Checkbox, Group, Modal, Paper, Select, Stack, Text } from "@mantine/core";
import type { Film } from "./data";
import { getFilmMetadata } from "./filmMetadata";
import { usePrototype } from "./state";
import { Pill } from "./ui";

export function ScraperMetadata({ film, onClose }: { film: Film; onClose: () => void }) {
  const { setFilms, notice, openFilm } = usePrototype();
  const [source, setSource] = useState<string | null>("资料源 A");
  const [fields, setFields] = useState(["premiered", "studio"]);
  const current = getFilmMetadata(film);
  const incoming = getFilmMetadata({ ...film, metadata: undefined, missing: false });
  const updates = [
    { key: "premiered" as const, name: "发行日期", value: incoming.premiered },
    { key: "studio" as const, name: "厂商", value: incoming.studio },
  ];
  const pending = updates.filter((item) => !current[item.key] && fields.includes(item.key));
  return (
    <Modal opened onClose={onClose} title={`补全资料 · ${film.code}`} centered size={470}>
      <Select
        label="资料来源"
        value={source}
        onChange={setSource}
        allowDeselect={false}
        data={["资料源 A", "MetaTube", "本地 NFO"]}
      />
      <Stack gap="xs" mt="md">
        {updates.map((item) => (
          <Paper key={item.key} withBorder p="sm" radius="md">
            <Group justify="space-between" wrap="nowrap">
              <Checkbox
                label={item.name}
                description={current[item.key] || item.value}
                checked={!current[item.key] && fields.includes(item.key)}
                disabled={!!current[item.key]}
                onChange={(event) =>
                  setFields(
                    event.currentTarget.checked
                      ? [...fields, item.key]
                      : fields.filter((field) => field !== item.key),
                  )
                }
              />
              <Pill tone={current[item.key] ? "neutral" : "success"}>
                {current[item.key] ? "保留已有" : "补全空白"}
              </Pill>
            </Group>
          </Paper>
        ))}
      </Stack>
      <Group justify="space-between" mt="lg">
        <Button
          variant="subtle"
          size="xs"
          onClick={() => {
            onClose();
            openFilm(film, "edit");
          }}
        >
          编辑全部资料
        </Button>
        <Button
          disabled={!pending.length}
          onClick={() => {
            const metadata = { ...current, source: source ?? "资料源 A" };
            for (const item of pending) metadata[item.key] = item.value;
            setFilms((previous) =>
              previous.map((item) =>
                item.id === film.id
                  ? {
                      ...item,
                      metadata,
                      missing:
                        !metadata.premiered ||
                        !metadata.studio ||
                        !metadata.actors.length ||
                        item.coverFrame === null ||
                        item.previewFrames?.length === 0,
                    }
                  : item,
              ),
            );
            notice(`已补全 ${pending.length} 项资料`);
            onClose();
          }}
        >
          {pending.length ? `补全 ${pending.length} 项` : "无需补全"}
        </Button>
      </Group>
      <Text size="xs" c="dimmed" mt="sm">
        已有内容默认保留，只补全空白字段。
      </Text>
    </Modal>
  );
}
