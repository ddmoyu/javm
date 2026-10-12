import { Button, Group, Menu, SimpleGrid, Text, UnstyledButton } from "@mantine/core";
import type { Film, MediaTrailer } from "../../contracts/media";
import { Icon } from "../../components/icons";
import { Empty } from "../../components/ui";
import { useImagePreview } from "../../components/ImagePreview";
import { ObjectMenu } from "../../components/ObjectMenu";
import { SourceImage } from "../../components/ImageSources";

export type ScreenshotAction = "capture" | "fetch" | "long" | "clear" | "remove" | "cover";
export function FilmScreenshots({
  film,
  label = "视频截图",
  onAction,
  onPlayTrailer,
}: {
  film: Film;
  label?: string;
  onAction?: (action: ScreenshotAction, index?: number) => void;
  onPlayTrailer?: (trailer: MediaTrailer) => void;
}) {
  const { open } = useImagePreview();
  const images = film.screenshots ?? [];
  const trailer = onPlayTrailer ? film.trailers?.[0] : undefined;
  const poster = images[0]?.src || film.coverUrl;
  return (
    <section aria-label={label}>
      <Group justify="space-between" mb="sm">
        <Text fw={600} size="sm">
          {label}{" "}
          <Text span size="xs" c="dimmed">
            {trailer ? `1 段预览片 · ${images.length} 张图片` : `${images.length} 张图片`}
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
              <Menu.Item
                color="red"
                disabled={!images.some((image) => image.id)}
                onClick={() => onAction("clear")}
              >
                清空截图
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
      <SimpleGrid cols={3} spacing={8}>
        {trailer && (
          <UnstyledButton
            className="thumb trailer-thumb"
            aria-label="播放预览片"
            onClick={() => onPlayTrailer?.(trailer)}
          >
            {poster && (
              <SourceImage
                candidates={[poster]}
                referer={film.metadata?.homepage}
                placeholder={() => null}
                alt=""
                h="100%"
                fit="cover"
                loading="lazy"
                decoding="async"
              />
            )}
            <span className="trailer-thumb-content">
              <Icon name="play" size={24} filled />
              <span>预览片</span>
            </span>
          </UnstyledButton>
        )}
        {images.map((image, index) => (
          <ObjectMenu
            key={image.id ?? `${image.src}:${index}`}
            items={
              onAction &&
              (image.path || image.id) && (
                <>
                  {image.path && (
                    <Menu.Item onClick={() => onAction("cover", index)}>设为封面</Menu.Item>
                  )}
                  {image.id && (
                    <Menu.Item color="red" onClick={() => onAction("remove", index)}>
                      删除截图
                    </Menu.Item>
                  )}
                </>
              )
            }
          >
            <UnstyledButton
              key={`${image.src}:${index}`}
              className="thumb"
              aria-label={`查看截图 ${index + 1}`}
              onClick={() => open(images, index, film.metadata?.homepage)}
            >
              <SourceImage
                candidates={[image.src]}
                referer={film.metadata?.homepage}
                placeholder={(loading) => (
                  <span className="poster-empty">{loading ? "读取中…" : "图片暂不可用"}</span>
                )}
                alt={image.title || `截图 ${index + 1}`}
                h="100%"
                fit="cover"
                loading="lazy"
                decoding="async"
              />
              {image.timestamp && <time>{image.timestamp}</time>}
            </UnstyledButton>
          </ObjectMenu>
        ))}
      </SimpleGrid>
      {!images.length && !trailer && (
        <Empty
          icon="image"
          title="暂无截图"
          description={onAction ? "可以从视频中截取画面，或获取影片预览图。" : "暂无影片预览图。"}
        />
      )}
    </section>
  );
}
