import { useState, useSyncExternalStore } from "react";
import { useDebouncedValue } from "@mantine/hooks";
import {
  Alert,
  Button,
  Group,
  Modal,
  NumberInput,
  SimpleGrid,
  TagsInput,
  TextInput,
  Textarea,
  Text,
} from "@mantine/core";
import type { Film } from "../../contracts/media";
import { getFilmMetadata, titleError } from "./filmMetadata";
import { editableMetadata, metadataChanges } from "../../contracts/metadata";
import type { EditableMetadata } from "../../contracts/metadata";
import { MetadataPreview } from "./MetadataPreview";
import { MetaTubeSearch } from "../resources/MetaTubeSearch";
import { serviceError } from "../../services/metadata/shared";
import { useWorkspace } from "../../app/state";
import { Icon } from "../../components/icons";
import { usePagedQuery } from "../../services/library/usePagedQuery";

export function FilmEditor({ film, onClose }: { film: Film; onClose: () => void }) {
  const { library, libraryState, ai, metatube, notice } = useWorkspace();
  const [initial] = useState(() => editableMetadata(film));
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [assisting, setAssisting] = useState(false);
  const [lookupOpened, setLookupOpened] = useState(false);
  const [candidate, setCandidate] = useState<{
    title: string;
    fields: Partial<EditableMetadata>;
  } | null>(null);
  const aiState = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const [discard, setDiscard] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const [code] = useDebouncedValue(draft.code.trim(), 180);
  const [lookup] = useState(() => library.createDuplicateQuery());
  const codeState = usePagedQuery(
    library,
    lookup,
    { code, except: String(film.id) },
    libraryState.ready && !!code,
  );
  const duplicate = !!draft.code.trim() && codeState.items.get(0) === true;
  const invalidTitle = titleError(draft.title);
  const requestClose = () => {
    if (saving) return;
    if (assisting) ai.cancel();
    if (lookupOpened) metatube.cancel();
    if (dirty) setDiscard(true);
    else onClose();
  };
  const patch = (value: Partial<typeof draft>) => {
    setDraft((previous) => ({ ...previous, ...value }));
    setDiscard(false);
  };
  const save = async () => {
    if (saving || assisting) return;
    setAttempted(true);
    if (
      invalidTitle ||
      duplicate ||
      (draft.code.trim() && (code !== draft.code.trim() || !codeState.ready || codeState.error))
    )
      return;
    setError("");
    setSaving(true);
    try {
      await library.updateMetadata(film.id, metadataChanges(initial, draft), initial);
      notice("影片资料已保存");
      onClose();
    } catch (reason) {
      setError(serviceError(reason));
    } finally {
      setSaving(false);
    }
  };
  const assist = async (recognize: boolean) => {
    if (aiState.busy || saving) return;
    setError("");
    setAssisting(true);
    try {
      const fields = recognize
        ? await ai.recognize(getFilmMetadata(film).fileName, draft.title)
        : await ai.translate(draft);
      setCandidate({ title: recognize ? "确认 AI 识别结果" : "确认 AI 翻译结果", fields });
    } catch (reason) {
      setError(serviceError(reason));
    } finally {
      setAssisting(false);
    }
  };
  return (
    <>
      <Modal
        opened
        onClose={requestClose}
        title="编辑影片资料"
        size={720}
        centered
        zIndex={400}
        returnFocus={false}
        closeOnClickOutside={false}
        closeOnEscape={!candidate && !lookupOpened}
        trapFocus={!candidate && !lookupOpened}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Group mb="md">
            <Button
              type="button"
              variant="default"
              disabled={saving || assisting}
              onClick={() => setLookupOpened(true)}
            >
              查找资料
            </Button>
            <Button
              type="button"
              variant="default"
              disabled={saving || aiState.busy}
              onClick={() => void assist(false)}
            >
              AI 翻译标题与简介
            </Button>
            {assisting && (
              <Button type="button" variant="subtle" onClick={ai.cancel}>
                取消 AI 请求
              </Button>
            )}
          </Group>
          {error && (
            <Alert color="red" role="alert" mb="md">
              {error}
            </Alert>
          )}
          {assisting && (
            <Text size="sm" component="output" mb="sm">
              {aiState.action}…
            </Text>
          )}
          <fieldset
            disabled={saving || assisting}
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
          >
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md" verticalSpacing="sm">
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
                error={
                  codeState.error ? (
                    <Button variant="subtle" color="red" size="compact-xs" onClick={lookup.retry}>
                      番号校验失败，点击重试
                    </Button>
                  ) : duplicate ? (
                    "该番号已存在"
                  ) : undefined
                }
                onChange={(event) => patch({ code: event.currentTarget.value })}
                inputContainer={(children) => (
                  <Group gap={6} wrap="nowrap" className="assisted-field">
                    {children}
                    <Button
                      type="button"
                      variant="default"
                      size="xs"
                      disabled={aiState.busy}
                      onClick={() => void assist(true)}
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
                      onClick={() => patch({ duration: film.duration })}
                    >
                      读取时长
                    </Button>
                  </Group>
                )}
              />
              <NumberInput
                label="评分（0–5）"
                description="0 表示未评分"
                min={0}
                max={5}
                clampBehavior="strict"
                step={0.1}
                decimalScale={1}
                value={draft.rating}
                onChange={(value) => patch({ rating: Number(value) || 0 })}
              />
              <TextInput
                label="导演"
                value={draft.director}
                onChange={(event) => patch({ director: event.currentTarget.value })}
              />
              <TextInput
                label="制作商"
                value={draft.studio}
                onChange={(event) => patch({ studio: event.currentTarget.value })}
              />
              <TextInput
                label="发行商"
                value={draft.label}
                onChange={(event) => patch({ label: event.currentTarget.value })}
              />
              <TextInput
                label="系列"
                value={draft.series}
                onChange={(event) => patch({ series: event.currentTarget.value })}
              />
              <TextInput
                label="分辨率"
                value={getFilmMetadata(film).resolution}
                readOnly
                description="由实际视频文件探测"
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
              <Textarea
                label="简介"
                autosize
                minRows={3}
                maxRows={8}
                style={{ gridColumn: "1 / -1" }}
                value={draft.plot}
                onChange={(event) => patch({ plot: event.currentTarget.value })}
              />
            </SimpleGrid>
          </fieldset>
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
            <Button
              type="submit"
              leftSection={<Icon name="check" size={16} />}
              loading={saving}
              disabled={!dirty || assisting}
            >
              保存修改
            </Button>
          </Group>
        </form>
      </Modal>
      {lookupOpened && (
        <Modal
          opened
          title="查找影片资料"
          size={760}
          zIndex={450}
          centered
          returnFocus={false}
          onClose={() => {
            metatube.cancel();
            setLookupOpened(false);
          }}
        >
          <MetaTubeSearch
            initialQuery={draft.code || draft.title}
            onSelect={(result) => {
              setLookupOpened(false);
              setCandidate({
                title: "确认影片资料",
                fields: result.fields,
              });
            }}
          />
        </Modal>
      )}
      {candidate && (
        <MetadataPreview
          current={draft}
          candidate={candidate.fields}
          title={candidate.title}
          onClose={() => setCandidate(null)}
          onApply={(fields) => {
            patch(fields);
            setCandidate(null);
          }}
        />
      )}
    </>
  );
}
