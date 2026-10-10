import { Button, Group, Image, Menu, SimpleGrid, Text, UnstyledButton } from "@mantine/core";
import type { Film } from "../../contracts/media";
import { Icon } from "../../components/icons";
import { Empty } from "../../components/ui";
import { useImagePreview } from "../../components/ImagePreview";

export type ScreenshotAction = "capture" | "fetch" | "long" | "clear" | "remove" | "cover";
export function FilmScreenshots({
  film,
  label = "视频截图",
  onAction,
}: {
  film: Film;
  label?: string;
  onAction?: (action: ScreenshotAction, index?: number) => void;
}) {
  const { open } = useImagePreview();
  const images = film.screenshots ?? [];
  return (
    <section aria-label={label}>
      <Group justify="space-between" mb="sm">
        <Text fw={600} size="sm">
          {label}{" "}
          <Text span size="xs" c="dimmed">
            {images.length}
          </Text>
        </Text>
        {onAction && (
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
              <Menu.Item color="red" disabled={!images.length} onClick={() => onAction("clear")}>
                清空截图
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
      <SimpleGrid cols={3} spacing={8}>
        {images.map((image, index) => (
          <UnstyledButton
            key={`${image.src}:${index}`}
            className="thumb"
            aria-label={`查看截图 ${index + 1}`}
            onClick={() => open(images, index)}
          >
            <Image
              src={image.src}
              alt={image.title || `截图 ${index + 1}`}
              h="100%"
              fit="cover"
              loading="lazy"
              decoding="async"
            />
            {image.timestamp && <time>{image.timestamp}</time>}
          </UnstyledButton>
        ))}
      </SimpleGrid>
      {!images.length && (
        <Empty
          icon="image"
          title="暂无截图"
          description={
            onAction ? "可以从视频中截取画面，或获取影片预览图。" : "资料来源未提供预览图。"
          }
        />
      )}
    </section>
  );
}
