import { t, localizeOptions, useLocale } from "../../i18n/index";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Image,
  Modal,
  NumberInput,
  Progress,
  Select,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";
import type { Film } from "../../contracts/media";
import { useWorkspace } from "../../app/state";
import { os } from "@neutralinojs/lib";
import type { ArtworkService, CropArea } from "../../services/library/ArtworkService";
import { FilmFramePicker } from "./FilmFramePicker";

export type ArtworkMode = "cover" | "capture" | "fetch" | "long" | "pick-cover" | "pick-previews";
export function FilmArtworkEditor({
  film,
  mode,
  onClose,
  source,
}: {
  film: Film;
  mode: ArtworkMode;
  onClose: () => void;
  source?: string;
}) {
  useLocale();
  const { library } = useWorkspace();
  if (library.artwork && (mode === "pick-cover" || mode === "pick-previews"))
    return (
      <FilmFramePicker
        service={library.artwork}
        film={film}
        multiple={mode === "pick-previews"}
        onClose={onClose}
      />
    );
  return library.artwork ? (
    <ArtworkEditor
      service={library.artwork}
      film={film}
      mode={mode}
      source={source}
      onClose={onClose}
    />
  ) : (
    <Modal opened onClose={onClose} title={t("图片管理")}>
      <Text>{t("请在桌面应用中处理图片。")}</Text>
    </Modal>
  );
}
function ArtworkEditor({
  service,
  film,
  mode,
  source,
  onClose,
}: {
  service: ArtworkService;
  film: Film;
  mode: ArtworkMode;
  source?: string;
  onClose(): void;
}) {
  useLocale();
  const task = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const [count, setCount] = useState<string | null>("6");
  const videos =
    film.files?.filter((file) => file.kind === "video" && !file.missing && !file.streamUrl) ?? [];
  const [videoId, setVideoId] = useState<string | null>(videos[0]?.id ?? null);
  const [path, setPath] = useState(source ?? film.artwork?.[0]?.path ?? "");
  const [preview, setPreview] = useState("");
  const [cropEnabled, setCropEnabled] = useState(false);
  const [crop, setCrop] = useState<CropArea>({ left: 0, top: 0, width: 100, height: 100 });
  const [cover, setCover] = useState(true),
    [screenshots, setScreenshots] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    if (mode !== "cover" || !path) return;
    const abort = new AbortController();
    let imageUrl = "";
    setPreview("");
    void service
      .preview(path, abort.signal)
      .then((bytes) => {
        if (abort.signal.aborted) return;
        imageUrl = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
        setPreview(imageUrl);
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted)
          setError(reason instanceof Error ? reason.message : "图片预览失败。");
      });
    return () => {
      abort.abort();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [service, mode, path]);
  const start = async () => {
    setError("");
    try {
      if (mode === "cover") {
        if (!path) throw new Error("请先选择图片。");
        await service.cover(String(film.id), path, cropEnabled ? crop : undefined);
      } else if (mode === "fetch") await service.fetch(String(film.id), cover, screenshots);
      else
        await service.capture(
          String(film.id),
          Number(count),
          mode === "long",
          videoId ?? undefined,
        );
      if (!service.getSnapshot().warning) onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "图片处理失败。");
    }
  };
  const title = {
    "pick-cover": "从视频选择封面",
    "pick-previews": "从视频选择预览图",
    cover: "选取封面",
    capture: "截取视频截图",
    fetch: "获取封面与截图",
    long: "获取长截图",
  }[mode];
  return (
    <Modal
      opened
      onClose={() => !task.busy && onClose()}
      title={t(title)}
      centered
      size="md"
      zIndex={400}
      closeOnClickOutside={!task.busy}
      closeOnEscape={!task.busy}
      withCloseButton={!task.busy}
    >
      <Stack>
        <Text size="sm" fw={600}>
          {film.title}
        </Text>
        {mode === "fetch" ? (
          <>
            <Checkbox
              label={t("获取封面")}
              checked={cover}
              disabled={task.busy}
              onChange={(event) => setCover(event.currentTarget.checked)}
            />
            <Checkbox
              label={t("获取截图")}
              checked={screenshots}
              disabled={task.busy}
              onChange={(event) => setScreenshots(event.currentTarget.checked)}
            />
          </>
        ) : mode === "cover" ? (
          <Stack gap="sm">
            <Button
              variant="default"
              disabled={task.busy}
              onClick={() => {
                void os
                  .showOpenDialog(t("选择封面图片"), {
                    multiSelections: false,
                    filters: [{ name: t("图片"), extensions: ["jpg", "jpeg", "png", "webp"] }],
                  })
                  .then((files) => {
                    if (files[0]) {
                      setError("");
                      setPath(files[0]);
                    }
                  })
                  .catch(() => setError("无法打开图片选择器。"));
              }}
            >
              {t("选择本地图片")}
            </Button>
            {path && (
              <Text size="xs" style={{ overflowWrap: "anywhere" }}>
                {path}
              </Text>
            )}
            {preview && (
              <div style={{ position: "relative" }}>
                <Image src={preview} alt={t("封面裁剪预览")} data-private-image />
                {cropEnabled && (
                  <div
                    aria-hidden
                    style={{
                      position: "absolute",
                      pointerEvents: "none",
                      border: "2px solid var(--mantine-color-blue-5)",
                      left: `${crop.left}%`,
                      top: `${crop.top}%`,
                      width: `${crop.width}%`,
                      height: `${crop.height}%`,
                    }}
                  />
                )}
              </div>
            )}
            <Checkbox
              label={t("裁剪封面")}
              checked={cropEnabled}
              disabled={task.busy}
              onChange={(event) => setCropEnabled(event.currentTarget.checked)}
            />
            {cropEnabled && (
              <SimpleGrid cols={2}>
                {(["left", "top", "width", "height"] as const).map((key, index) => (
                  <NumberInput
                    key={key}
                    label={t(`${["左侧", "顶部", "宽度", "高度"][index]}（%）`)}
                    value={crop[key]}
                    min={key === "width" || key === "height" ? 1 : 0}
                    max={100}
                    disabled={task.busy}
                    onChange={(value) => setCrop({ ...crop, [key]: Number(value) })}
                  />
                ))}
              </SimpleGrid>
            )}
          </Stack>
        ) : (
          <>
            <Select
              label={t("本地视频")}
              value={videoId}
              onChange={setVideoId}
              allowDeselect={false}
              disabled={task.busy}
              data={videos
                .filter((file) => !!file.id)
                .map((file) => ({ value: file.id!, label: file.name }))}
            />
            <Select
              label={t("截图数量")}
              value={count}
              onChange={setCount}
              data={localizeOptions(["1", "6", "12", "24"])}
              allowDeselect={false}
              disabled={task.busy}
            />
          </>
        )}
        {task.busy && (
          <>
            <Progress value={task.total ? (task.processed / task.total) * 100 : 0} animated />
            <Text size="sm" role="status">
              {task.action} · {task.processed} / {task.total}
            </Text>
          </>
        )}
        {error && (
          <Alert color="red" role="alert">
            {t(error)}
          </Alert>
        )}
        {task.warning && <Alert color="yellow">{t(task.warning)}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={task.busy ? service.cancel : onClose}>
            {task.busy ? t("停止处理") : t("关闭")}
          </Button>
          <Button loading={task.busy} onClick={() => void start()}>
            {mode === "cover" ? t("保存封面") : t("开始处理")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
