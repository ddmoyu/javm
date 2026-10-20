import { t, useLocale } from "../../i18n/index";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Alert,
  Button,
  Group,
  Image,
  Modal,
  Progress,
  Select,
  SimpleGrid,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import type { Film } from "../../contracts/media";
import type {
  ArtworkService,
  ArtworkTarget,
  CandidateFrame,
} from "../../services/library/ArtworkService";

/** 每次截取的候选画面数，与旧版一致。 */
const candidateCount = 10;

const clock = (seconds: number) => {
  const total = Math.floor(seconds);
  const parts = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  return (parts[0] ? parts : parts.slice(1))
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
};

/**
 * 从视频截取候选画面后挑选：封面模式单选，预览图模式多选（新画面默认选中）。
 * 画面只在本对话框内显示，关闭时释放；确认后才写入片库。
 */
export function FilmFramePicker({
  service,
  film,
  multiple,
  onClose,
}: {
  service: ArtworkService;
  film: Film;
  multiple: boolean;
  onClose: () => void;
}) {
  useLocale();
  const task = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const videos =
    film.files?.filter(
      (file) => file.kind === "video" && !file.missing && !file.streamUrl && file.id,
    ) ?? [];
  const [videoId, setVideoId] = useState<string | null>(videos[0]?.id ?? null);
  const [frames, setFrames] = useState<(CandidateFrame & { url: string })[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [video, setVideo] = useState<ArtworkTarget["videos"][number]>();
  // 打开即开始截取，初始即为截取中。
  const [capturing, setCapturing] = useState(true);
  const [error, setError] = useState("");
  const urls = useRef<string[]>([]);
  const release = () => {
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current = [];
  };
  useEffect(() => release, []);
  const run = async () => {
    try {
      const result = await service.captureCandidates(
        String(film.id),
        candidateCount,
        videoId ?? undefined,
        (frame) => {
          const url = URL.createObjectURL(new Blob([frame.bytes], { type: "image/jpeg" }));
          urls.current.push(url);
          setFrames((items) => [...items, { ...frame, url }]);
          if (multiple) setSelected((items) => new Set(items).add(frame.index));
        },
      );
      setVideo(result.video);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "截取画面失败。");
    } finally {
      setCapturing(false);
    }
  };
  const capture = () => {
    release();
    setFrames([]);
    setSelected(new Set());
    setVideo(undefined);
    setError("");
    setCapturing(true);
    void run();
  };
  // 打开即截取一次（StrictMode 重复挂载时不重复截取）；切换视频后需手动重新截取。
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  });
  const toggle = (index: number) =>
    setSelected((items) => {
      if (!multiple) return new Set([index]);
      const next = new Set(items);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  const save = async () => {
    setError("");
    try {
      if (!video) throw new Error("画面尚未截取完成。");
      const chosen = frames.filter((frame) => selected.has(frame.index));
      await service.applyFrames(String(film.id), chosen, multiple ? "screenshot" : "poster", video);
      if (!service.getSnapshot().warning) onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败。");
    }
  };
  const busy = task.busy;
  return (
    <Modal
      opened
      onClose={() => !busy && onClose()}
      title={multiple ? t("从视频选择预览图") : t("从视频选择封面")}
      centered
      size="xl"
      zIndex={400}
      closeOnClickOutside={!busy}
      closeOnEscape={!busy}
      withCloseButton={!busy}
    >
      <Stack>
        <Group align="flex-end">
          {videos.length > 1 && (
            <Select
              label={t("本地视频")}
              value={videoId}
              onChange={setVideoId}
              allowDeselect={false}
              disabled={busy}
              data={videos.map((file) => ({ value: file.id!, label: file.name }))}
              style={{ flex: 1 }}
            />
          )}
          <Button variant="default" disabled={busy} onClick={capture}>
            {t("重新截取")}
          </Button>
        </Group>
        {busy && (
          <>
            <Progress value={task.total ? (task.processed / task.total) * 100 : 0} animated />
            <Text size="sm" component="output">
              {task.action} · {task.processed} / {task.total}
            </Text>
          </>
        )}
        {!!frames.length && (
          <SimpleGrid cols={{ base: 2, sm: 3, md: 5 }} spacing={8}>
            {frames.map((frame) => {
              const active = selected.has(frame.index);
              return (
                <UnstyledButton
                  key={frame.index}
                  aria-pressed={active}
                  aria-label={t("画面 {0}", t(clock(frame.seconds)))}
                  disabled={capturing && !multiple}
                  onClick={() => toggle(frame.index)}
                  style={{
                    position: "relative",
                    borderRadius: 6,
                    overflow: "hidden",
                    outline: active
                      ? "3px solid var(--mantine-color-blue-5)"
                      : "1px solid var(--mantine-color-default-border)",
                    outlineOffset: active ? -3 : -1,
                  }}
                >
                  <Image src={frame.url} alt="" data-private-image />
                  <Text
                    size="xs"
                    style={{
                      position: "absolute",
                      right: 4,
                      bottom: 4,
                      padding: "0 4px",
                      borderRadius: 4,
                      background: "rgba(0,0,0,0.6)",
                      color: "white",
                    }}
                  >
                    {clock(frame.seconds)}
                  </Text>
                </UnstyledButton>
              );
            })}
          </SimpleGrid>
        )}
        {error && (
          <Alert color="red" role="alert">
            {t(error)}
          </Alert>
        )}
        {task.warning && <Alert color="yellow">{t(task.warning)}</Alert>}
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            {multiple
              ? t("已选择 {0} 张", t(selected.size))
              : selected.size
                ? t("已选择 1 张")
                : t("点击画面选择封面")}
          </Text>
          <Group>
            <Button variant="default" onClick={busy ? service.cancel : onClose}>
              {busy ? t("停止") : t("关闭")}
            </Button>
            <Button disabled={busy || !video || !selected.size} onClick={() => void save()}>
              {multiple ? t("保存预览图") : t("设为封面")}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
