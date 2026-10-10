import { useState } from "react";
import {
  Button,
  Group,
  Menu,
  Modal,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import type { Film } from "./data";
import { getFilmMetadata } from "./filmMetadata";
import { allFrames, Poster, scenes, Still, timestamp } from "./Cover";
import { usePrototype } from "./state";
import { Icon } from "./icons";
import { IconButton, Pill } from "./ui";
import type { ResourceMatch, ResourcePacket } from "./resourceSearch";

export function SearchMovieInfo({
  match,
  packet,
  localFilm,
  onFill,
}: {
  match: ResourceMatch;
  packet: ResourcePacket;
  localFilm?: Film;
  onFill: () => void;
}) {
  const { openFilm, notice } = usePrototype();
  const [preview, setPreview] = useState<number | "cover" | null>(null);
  const film = match.film;
  const remoteReady = packet.sources.metadata === "ready";
  const metadata = film
    ? getFilmMetadata(
        remoteReady ? { ...film, metadata: undefined, missing: false } : (localFilm ?? film),
      )
    : null;
  const frames = film?.previewFrames ?? allFrames;
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(match.code);
      notice("番号已复制");
    } catch {
      notice("复制失败，请重试");
    }
  };
  return (
    <Paper withBorder p="lg" radius="lg" component="section" aria-label="完整影片资料">
      <Group align="flex-start" gap="lg" wrap="nowrap">
        {film ? (
          <UnstyledButton
            className="detail-poster"
            w={96}
            onClick={() => setPreview("cover")}
            aria-label="查看搜索影片封面"
          >
            <Poster film={film} compact />
          </UnstyledButton>
        ) : (
          <span className="detail-poster poster-empty" style={{ width: 96 }}>
            <Icon name="image" size={30} />
          </span>
        )}
        <Stack gap={8} style={{ minWidth: 0 }}>
          <Group gap={8}>
            <Text size="sm" ff="monospace" c="dimmed">
              {match.code}
            </Text>
            <Pill tone={localFilm ? "success" : "neutral"}>
              {localFilm ? "已在片库" : "未入库"}
            </Pill>
            {(match.metadataSources?.length ?? 0) > 1 && (
              <Text size="xs" c="dimmed" title={match.metadataSources!.join("、")}>
                {match.metadataSources!.length} 个来源
              </Text>
            )}
          </Group>
          <Title order={2} fz={22}>
            {film?.title ?? "影片资料未匹配"}
          </Title>
          {film && (
            <Group gap="md">
              <Text size="sm" c="dimmed">
                {film.year}
              </Text>
              <Text size="sm" c="dimmed">
                {film.duration} 分钟
              </Text>
              <Group gap={4} c="champagne.4">
                <Icon name="star" size={13} filled={film.rating != null} />
                <Text size="sm">{film.rating?.toFixed(1) ?? "暂无评分"}</Text>
              </Group>
              <Pill>{film.quality}</Pill>
            </Group>
          )}
          <Group gap="xs" mt={4}>
            {localFilm && (
              <Button
                variant="default"
                size="xs"
                leftSection={<Icon name="scan" size={14} />}
                onClick={onFill}
              >
                补全片库资料
              </Button>
            )}
            <Menu position="bottom-end">
              <Menu.Target>
                <Button
                  variant="subtle"
                  color="gray"
                  size="xs"
                  rightSection={<Icon name="down" size={13} />}
                >
                  更多
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item onClick={() => void copyCode()}>复制番号</Menu.Item>
                {localFilm && (
                  <>
                    <Menu.Item onClick={() => openFilm(localFilm)}>打开片库详情</Menu.Item>
                    <Menu.Item onClick={() => openFilm(localFilm, "edit")}>编辑片库资料</Menu.Item>
                  </>
                )}
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Stack>
      </Group>
      {film && metadata ? (
        <>
          <SimpleGrid
            component="dl"
            cols={4}
            spacing="md"
            verticalSpacing="sm"
            mt="lg"
            className="facts"
          >
            {[
              ["演员", metadata.actors.join("、") || "暂无资料"],
              ["发行日期", metadata.premiered || "未知"],
              ["导演", metadata.director || "未知"],
              ["厂商", metadata.studio || "未知"],
              ["系列", metadata.series || "未知"],
              ["分类", metadata.genres.join(" / ") || "未知"],
              ["分辨率", metadata.resolution || "未知"],
              ["资料来源", remoteReady ? "资料源 A" : localFilm ? "本地资料" : "待获取"],
            ].map(([label, value]) => (
              <div key={label}>
                <Text component="dt" size="xs" c="dimmed">
                  {label}
                </Text>
                <Text component="dd" size="sm">
                  {value}
                </Text>
              </div>
            ))}
            <div style={{ gridColumn: "1 / -1" }}>
              <Text component="dt" size="xs" c="dimmed">
                原始名称
              </Text>
              <Text component="dd" size="sm" ff="monospace">
                {metadata.originalTitle || "未知"}
              </Text>
            </div>
          </SimpleGrid>
          <Text size="xs" c="dimmed" mt="lg" mb={6}>
            视频截图 {frames.length}
          </Text>
          <ScrollArea type="hover" offsetScrollbars scrollbarSize={6}>
            <Group gap="xs" wrap="nowrap" aria-label="搜索影片截图">
              {frames.map((frame) => (
                <UnstyledButton
                  key={frame}
                  className="thumb"
                  w={140}
                  onClick={() => setPreview(frame)}
                  aria-label={`查看搜索截图 ${frame + 1}`}
                >
                  <Still index={frame} label={scenes[frame]!} />
                  <time>{timestamp(film, frame)}</time>
                </UnstyledButton>
              ))}
            </Group>
          </ScrollArea>
        </>
      ) : (
        <Text size="sm" c="dimmed" mt="lg">
          {packet.sources.metadata === "searching"
            ? "正在获取影片资料"
            : "暂未找到影片资料，可继续查看下方资源。"}
        </Text>
      )}
      <Modal
        opened={preview !== null}
        onClose={() => setPreview(null)}
        title={preview === "cover" ? "影片封面" : "视频截图"}
        size={preview === "cover" ? 400 : 850}
        centered
      >
        {film &&
          (preview === "cover" ? (
            <div className="large-poster">
              <Poster film={film} />
            </div>
          ) : typeof preview === "number" ? (
            <>
              <div className="stage">
                <Still index={preview} label={scenes[preview]!} />
              </div>
              <Group justify="center" mt="sm" gap="sm">
                <IconButton
                  icon="chevronLeft"
                  label="上一张搜索截图"
                  onClick={() =>
                    setPreview(
                      frames[(frames.indexOf(preview) - 1 + frames.length) % frames.length]!,
                    )
                  }
                />
                <Text size="sm" c="dimmed">
                  {frames.indexOf(preview) + 1} / {frames.length}
                </Text>
                <IconButton
                  icon="chevron"
                  label="下一张搜索截图"
                  onClick={() => setPreview(frames[(frames.indexOf(preview) + 1) % frames.length]!)}
                />
              </Group>
            </>
          ) : null)}
      </Modal>
    </Paper>
  );
}
