import { Button, Group, Menu, Modal, SimpleGrid, Text, UnstyledButton } from "@mantine/core";
import type { Film } from "./data";
import { allFrames, scenes, Still, timestamp } from "./Cover";
import { Icon } from "./icons";
import { Empty } from "./ui";
import { ObjectMenu, objectMenuKey } from "./ObjectMenu";

export type ScreenshotAction = "capture" | "fetch" | "long" | "clear" | "remove" | "cover";

export function FilmScreenshots({
  film,
  frame,
  setFrame,
  onAction,
}: {
  film: Film;
  frame: number | null;
  setFrame: (frame: number | null) => void;
  onAction: (action: ScreenshotAction, index?: number) => void;
}) {
  const frames = film.previewFrames ?? allFrames;
  const navigate = (step: number) =>
    setFrame(
      frames[(frames.indexOf(frame ?? frames[0]!) + step + frames.length) % frames.length] ?? null,
    );
  return (
    <>
      <section aria-label="视频截图">
        <Group justify="space-between" mb="sm">
          <Text fw={600} size="sm">
            视频截图{" "}
            <Text span size="xs" c="dimmed">
              {frames.length}
            </Text>
          </Text>
          <Menu position="bottom-end" zIndex={350}>
            <Menu.Target>
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                rightSection={<Icon name="down" size={13} />}
              >
                管理截图
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<Icon name="image" />} onClick={() => onAction("capture")}>
                从视频截取
              </Menu.Item>
              <Menu.Item leftSection={<Icon name="download" />} onClick={() => onAction("fetch")}>
                获取封面与截图
              </Menu.Item>
              <Menu.Item leftSection={<Icon name="layers" />} onClick={() => onAction("long")}>
                获取长截图
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item color="red" disabled={!frames.length} onClick={() => onAction("clear")}>
                清空截图
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
        <SimpleGrid cols={3} spacing={8}>
          {frames.map((index) => (
            <ObjectMenu
              key={index}
              items={
                <>
                  <Menu.Item onClick={() => setFrame(index)}>查看大图</Menu.Item>
                  <Menu.Item onClick={() => onAction("cover", index)}>设为封面</Menu.Item>
                  <Menu.Divider />
                  <Menu.Item color="red" onClick={() => onAction("remove", index)}>
                    移除这张截图
                  </Menu.Item>
                </>
              }
            >
              <UnstyledButton
                className="thumb"
                aria-label={`查看截图 ${index + 1}，${timestamp(film, index)}`}
                onClick={() => setFrame(index)}
                onKeyDown={objectMenuKey}
              >
                <Still index={index} label={scenes[index]!} />
                <time>{timestamp(film, index)}</time>
              </UnstyledButton>
            </ObjectMenu>
          ))}
        </SimpleGrid>
        {!frames.length && (
          <Empty icon="image" title="暂无截图" description="可以从视频中截取几帧画面。">
            <Button size="xs" variant="light" onClick={() => onAction("capture")}>
              从视频截取
            </Button>
          </Empty>
        )}
      </section>
      <Modal
        opened={frame !== null}
        onClose={() => setFrame(null)}
        title={`${film.title} · 视频截图`}
        size={980}
        returnFocus={false}
        centered
        zIndex={400}
        onKeyDownCapture={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          event.stopPropagation();
          navigate(event.key === "ArrowLeft" ? -1 : 1);
        }}
      >
        {frame !== null && (
          <>
            <div className="stage">
              <Still index={frame} label={`${scenes[frame]}，${timestamp(film, frame)}`} />
              <UnstyledButton
                className="stage-nav previous"
                aria-label="上一张截图"
                onClick={() => navigate(-1)}
              >
                <Icon name="chevronLeft" size={24} />
              </UnstyledButton>
              <UnstyledButton
                className="stage-nav next"
                aria-label="下一张截图"
                onClick={() => navigate(1)}
              >
                <Icon name="chevron" size={24} />
              </UnstyledButton>
              <time>{timestamp(film, frame)}</time>
            </div>
            <Group justify="space-between" my="sm">
              <Text size="sm">
                {film.code}{" "}
                <Text span c="dimmed">
                  / {film.quality}
                </Text>
              </Text>
              <Text size="sm" c="dimmed" aria-live="polite">
                {frames.indexOf(frame) + 1} / {frames.length}
              </Text>
            </Group>
            <SimpleGrid cols={6} spacing={6} aria-label="选择截图">
              {frames.map((index) => (
                <UnstyledButton
                  key={index}
                  className="thumb"
                  data-active={frame === index || undefined}
                  aria-label={`切换到截图 ${index + 1}`}
                  aria-pressed={frame === index}
                  onClick={() => setFrame(index)}
                >
                  <Still index={index} label={scenes[index]!} />
                </UnstyledButton>
              ))}
            </SimpleGrid>
          </>
        )}
      </Modal>
    </>
  );
}
