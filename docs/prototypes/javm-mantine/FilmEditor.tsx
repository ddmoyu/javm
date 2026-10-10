import { useState } from "react";
import {
  Alert,
  Button,
  Group,
  Modal,
  NumberInput,
  SimpleGrid,
  TagsInput,
  TextInput,
} from "@mantine/core";
import type { Film } from "./data";
import { getFilmMetadata, titleError } from "./filmMetadata";
import { usePrototype } from "./state";
import { Icon } from "./icons";

export function FilmEditor({ film, onClose }: { film: Film; onClose: () => void }) {
  const { films, setFilms, notice } = usePrototype();
  const [initial] = useState(() => ({
    ...getFilmMetadata(film),
    title: film.title,
    code: film.code,
    duration: film.duration,
    rating: film.rating ?? ("" as number | string),
  }));
  const [draft, setDraft] = useState(initial);
  const [discard, setDiscard] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const duplicate =
    !!draft.code.trim() &&
    films.some(
      (item) => item.id !== film.id && item.code.toLowerCase() === draft.code.trim().toLowerCase(),
    );
  const invalidTitle = titleError(draft.title);
  const requestClose = () => (dirty ? setDiscard(true) : onClose());
  const patch = (value: Partial<typeof draft>) => {
    setDraft((previous) => ({ ...previous, ...value }));
    setDiscard(false);
  };
  const save = () => {
    setAttempted(true);
    if (invalidTitle || duplicate) return;
    const { title, code, duration, rating, ...metadata } = draft;
    setFilms((previous) =>
      previous.map((item) =>
        item.id === film.id
          ? {
              ...item,
              title: title.trim(),
              code: code.trim().toUpperCase(),
              duration,
              rating: rating === "" ? undefined : Number(rating),
              actor: metadata.actors[0],
              genre: metadata.genres[0] ?? "未分类",
              quality: /3840|2160/.test(metadata.resolution)
                ? "4K"
                : /1920|1080/.test(metadata.resolution)
                  ? "1080P"
                  : item.quality,
              year: metadata.premiered ? Number(metadata.premiered.slice(0, 4)) : item.year,
              metadata: { ...metadata, source: "手动编辑" },
            }
          : item,
      ),
    );
    notice("影片资料已保存");
    onClose();
  };
  return (
    <Modal
      opened
      onClose={requestClose}
      title="编辑影片资料"
      size={720}
      centered
      zIndex={400}
      returnFocus={false}
      closeOnClickOutside={false}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <SimpleGrid cols={2} spacing="md" verticalSpacing="sm">
          <TextInput
            style={{ gridColumn: "1 / -1" }}
            label="影片标题"
            data-autofocus
            value={draft.title}
            error={attempted && invalidTitle}
            onChange={(event) => patch({ title: event.currentTarget.value })}
          />
          <TextInput
            style={{ gridColumn: "1 / -1" }}
            label="原标题 / 文件名"
            value={draft.originalTitle}
            onChange={(event) => patch({ originalTitle: event.currentTarget.value })}
          />
          <TextInput
            label="番号"
            value={draft.code}
            error={duplicate ? "该番号已存在" : undefined}
            onChange={(event) => patch({ code: event.currentTarget.value })}
            inputContainer={(children) => (
              <Group gap={6} wrap="nowrap" className="assisted-field">
                {children}
                <Button
                  type="button"
                  variant="default"
                  size="xs"
                  onClick={() => {
                    const match = draft.originalTitle.match(/[a-z]+[-_]?\d+/i);
                    if (match) {
                      patch({ code: match[0].replace("_", "-").toUpperCase() });
                      notice("识别结果已填入，请核对");
                    } else notice("没有识别到番号，请手动填写");
                  }}
                >
                  AI 识别
                </Button>
              </Group>
            )}
          />
          <TextInput
            label="发行日期"
            type="date"
            value={draft.premiered}
            onChange={(event) => patch({ premiered: event.currentTarget.value })}
          />
          <NumberInput
            label="时长（分钟）"
            size="sm"
            min={0}
            max={1440}
            value={draft.duration}
            onChange={(value) => patch({ duration: Number(value) || 0 })}
            inputContainer={(children) => (
              <Group gap={6} wrap="nowrap" className="assisted-field">
                {children}
                <Button
                  type="button"
                  variant="default"
                  size="xs"
                  onClick={() => {
                    patch({ duration: film.duration || 108 });
                    notice("已读取视频时长");
                  }}
                >
                  读取时长
                </Button>
              </Group>
            )}
          />
          <NumberInput
            label="评分（0–10）"
            min={0}
            max={10}
            step={0.1}
            decimalScale={1}
            value={draft.rating}
            onChange={(value) => patch({ rating: value })}
          />
          <TextInput
            label="导演"
            value={draft.director}
            onChange={(event) => patch({ director: event.currentTarget.value })}
          />
          <TextInput
            label="厂商"
            value={draft.studio}
            onChange={(event) => patch({ studio: event.currentTarget.value })}
          />
          <TextInput
            label="系列"
            value={draft.series}
            onChange={(event) => patch({ series: event.currentTarget.value })}
          />
          <TextInput
            label="分辨率"
            value={draft.resolution}
            onChange={(event) => patch({ resolution: event.currentTarget.value })}
          />
          <TagsInput
            label="演员"
            value={draft.actors}
            onChange={(value) => patch({ actors: value })}
            placeholder="输入姓名后按回车"
          />
          <TagsInput
            label="分类 / 标签"
            value={draft.genres}
            onChange={(value) => patch({ genres: value })}
            placeholder="输入标签后按回车"
          />
        </SimpleGrid>
        {discard && (
          <Alert color="champagne" variant="light" mt="md" role="alert">
            <Group justify="space-between">
              <span style={{ flex: 1 }}>修改尚未保存</span>
              <Button type="button" size="xs" variant="default" onClick={() => setDiscard(false)}>
                继续编辑
              </Button>
              <Button type="button" size="xs" color="red" variant="light" onClick={onClose}>
                放弃修改
              </Button>
            </Group>
          </Alert>
        )}
        <Group justify="flex-end" mt="lg">
          <Button type="button" variant="default" onClick={requestClose}>
            取消
          </Button>
          <Button type="submit" leftSection={<Icon name="check" size={16} />} disabled={!dirty}>
            保存修改
          </Button>
        </Group>
      </form>
    </Modal>
  );
}
