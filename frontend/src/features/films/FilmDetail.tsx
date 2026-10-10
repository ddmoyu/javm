import { useState } from "react";
import type { ReactNode } from "react";
import {
  Anchor,
  Button,
  DataList,
  Drawer,
  Group,
  Menu,
  Modal,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import type { Film, MediaImage, MediaTrailer } from "../../contracts/media";
import type { FilmDetailView } from "../../app/state";
import { useWorkspace } from "../../app/state";
import { getFilmMetadata } from "./filmMetadata";
import type { FilmFacet } from "./filmMetadata";
import { Poster } from "../../components/Cover";
import { Icon } from "../../components/icons";
import { Empty, Pill } from "../../components/ui";
import { useImagePreview } from "../../components/ImagePreview";
import { FilmScreenshots } from "./FilmScreenshots";
import type { ScreenshotAction } from "./FilmScreenshots";
import { FilmArtworkEditor } from "./FilmArtworkEditor";
import type { ArtworkMode } from "./FilmArtworkEditor";
import { FilmEditor } from "./FilmEditor";
import { FilmResources } from "./FilmResources";
import { ResourceLookupButton } from "../resources/ResourceSearch";
import { openExternalLink } from "../../platform/neutralino/externalLinks";
import { os } from "@neutralinojs/lib";
import { libraryError } from "../../services/library/LibraryService";

interface Props {
  film: Film | null;
  initialView: FilmDetailView;
  preview?: boolean;
  onCollect?: () => Promise<void>;
  onClose: () => void;
}
export function FilmDetail({ film, ...props }: Props) {
  return film ? <FilmDetailContent film={film} {...props} /> : null;
}
function FilmDetailContent({
  film,
  initialView,
  preview = false,
  onCollect,
  onClose,
}: Omit<Props, "film"> & { film: Film }) {
  const {
    play,
    playSource,
    scrape,
    browseFacet,
    notice,
    unavailable,
    runtime,
    toggleFavorite,
    library,
    add,
    resourceSearch,
  } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const playable = film.files?.some((file) => file.kind === "video" && !file.missing) ?? false;
  const operate = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await operation();
    } catch (error) {
      notice(libraryError(error));
    } finally {
      setBusy(false);
    }
  };
  const attach = () =>
    operate(async () => {
      const files = await os.showOpenDialog("关联本地视频", { multiSelections: false });
      if (files[0]) {
        await library.attachVideo(film.id, files[0]);
        notice("视频已关联到当前作品。");
      }
    });
  const { open, opened } = useImagePreview();
  const [editing, setEditing] = useState(!preview && initialView === "edit");
  const [artwork, setArtwork] = useState<ArtworkMode | null>(null);
  const [tab, setTab] = useState<string | null>(
    initialView === "files" ? "files" : initialView === "links" ? "links" : "info",
  );
  const metadata = getFilmMetadata(film);
  const covers: MediaImage[] = film.artwork?.length
    ? film.artwork
    : film.coverUrl
      ? [{ src: film.coverUrl, title: `${film.title} · 封面` }]
      : [];
  const gallery: MediaImage[] = [...covers, ...(film.screenshots ?? [])];
  const trailers = film.trailers ?? [];
  const playTrailer = (trailer: MediaTrailer) => {
    onClose();
    playSource(trailer.src, {
      title: `${film.code || film.title} · 预告片`,
      format: trailer.format,
      referer: metadata.homepage || undefined,
    });
  };
  const overlay = opened || editing || artwork !== null || removing;
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notice("已复制");
    } catch {
      notice("复制失败，请重试");
    }
  };
  const facet = (name: FilmFacet, values: string[]) =>
    values.length ? (
      <Group gap={10}>
        {values.map((value) =>
          preview ? (
            <Text key={value} span size="sm" fw={600}>
              {value}
            </Text>
          ) : (
            <Anchor
              key={value}
              component="button"
              type="button"
              size="sm"
              fw={600}
              className="facet-link"
              onClick={() => {
                onClose();
                browseFacet(name, value);
              }}
            >
              {value}
              <Icon name="chevron" size={12} />
            </Anchor>
          ),
        )}
      </Group>
    ) : preview ? (
      "未提供"
    ) : (
      "未填写"
    );
  const action = (value: ScreenshotAction) => {
    if (value === "capture" || value === "fetch" || value === "long") setArtwork(value);
    else unavailable("图片管理");
  };
  const rows: [string, ReactNode][] = [
    ["演员", facet("演员", metadata.actors)],
    ["导演", facet("导演", metadata.director ? [metadata.director] : [])],
    ["制作商", facet("制作商", metadata.studio ? [metadata.studio] : [])],
    ["发行商", facet("发行商", metadata.label ? [metadata.label] : [])],
    ["系列", facet("系列", metadata.series ? [metadata.series] : [])],
    ["分类", facet("分类", metadata.genres)],
  ];
  if (!preview)
    rows.push(
      ["原始名称", metadata.originalTitle || "未填写"],
      [
        "本地视频",
        film.availability === "metadata_only"
          ? "未下载"
          : film.availability === "unavailable"
            ? "文件不可用"
            : "已关联",
      ],
      ...(film.availability !== "metadata_only"
        ? [["分辨率", metadata.resolution || "未知"] as [string, ReactNode]]
        : []),
    );
  rows.push(["资料来源", metadata.source || "未知"]);
  if (metadata.sourceId) rows.push(["来源编号", metadata.sourceId]);
  if (metadata.homepage)
    rows.push([
      "来源网页",
      <Anchor
        key="homepage"
        href={metadata.homepage}
        target="_blank"
        rel="noopener noreferrer"
        size="sm"
        aria-label="查看原始资料（在浏览器中打开）"
        onClick={(event) => {
          if (runtime !== "desktop") return;
          event.preventDefault();
          void openExternalLink(metadata.homepage!).catch(() =>
            notice("打开链接失败，请检查默认浏览器后重试。"),
          );
        }}
      >
        <Group gap={5} component="span">
          查看原始资料 <Icon name="external" size={14} />
        </Group>
      </Anchor>,
    ]);
  return (
    <>
      <Drawer
        opened
        onClose={onClose}
        position="right"
        size="min(900px, 100vw)"
        title="影片详情"
        closeOnEscape={!overlay}
        closeOnClickOutside={!overlay}
        trapFocus={!overlay}
        returnFocus={false}
        padding="xl"
        styles={{ header: { borderBottom: "1px solid var(--velvet-line)", marginBottom: 24 } }}
      >
        <Group align="flex-start" gap={28} wrap="wrap" className="detail-header">
          <div className="detail-cover">
            <UnstyledButton
              className="detail-poster"
              aria-label="查看影片封面"
              disabled={!film.coverUrl}
              onClick={() => open(gallery)}
            >
              <Poster film={film} natural />
            </UnstyledButton>
            {covers.length > 1 && (
              <Button
                variant="subtle"
                size="compact-xs"
                fullWidth
                mt="xs"
                onClick={() => open(gallery)}
              >
                查看封面（{covers.length}）
              </Button>
            )}
          </div>
          <Stack gap={12} style={{ minWidth: 0, flex: 1 }}>
            <Group gap={8}>
              <Button
                variant="subtle"
                size="compact-sm"
                px={4}
                ff="monospace"
                rightSection={<Icon name="copy" size={13} />}
                disabled={!film.code}
                onClick={() => void copy(film.code)}
              >
                {film.code || "番号未填写"}
              </Button>
              {film.quality && <Pill>{film.quality}</Pill>}
              {film.missing && <Pill tone="warning">资料待补全</Pill>}
              {preview && <Pill>资料预览</Pill>}
            </Group>
            <Title order={2} fz={28} lh={1.3} style={{ overflowWrap: "anywhere" }}>
              {film.title}
            </Title>
            <Group gap="lg" c="dimmed">
              <Text size="sm">{metadata.premiered || "发行日期未知"}</Text>
              <Text size="sm">{film.duration ? `${film.duration} 分钟` : "时长未知"}</Text>
              {!preview && film.availability !== "metadata_only" && (
                <Text size="sm">{film.size || "大小未知"}</Text>
              )}
            </Group>
            <UnstyledButton
              component={preview ? "div" : "button"}
              className="rating-button"
              aria-label={preview ? "影片评分" : "修改影片评分"}
              onClick={preview ? undefined : () => setEditing(true)}
              style={preview ? { cursor: "default" } : undefined}
            >
              <Icon name="star" size={19} filled={film.rating !== undefined} />
              <Text span fz={20} fw={700}>
                {film.rating === undefined ? "暂无评分" : film.rating.toFixed(1)}
              </Text>
              {film.rating !== undefined && (
                <Text span size="sm" c="dimmed">
                  / 5
                </Text>
              )}
            </UnstyledButton>
            {trailers[0] && (
              <Group gap={6}>
                <Button
                  leftSection={<Icon name="play" size={16} />}
                  onClick={() => playTrailer(trailers[0]!)}
                >
                  播放预告片
                </Button>
                {trailers.length > 1 && (
                  <Menu position="bottom-start">
                    <Menu.Target>
                      <Button variant="light" px={10} aria-label="其他预告片来源">
                        <Icon name="down" size={16} />
                      </Button>
                    </Menu.Target>
                    <Menu.Dropdown>
                      {trailers.slice(1).map((trailer) => (
                        <Menu.Item
                          key={trailer.src}
                          leftSection={<Icon name="play" size={16} />}
                          onClick={() => playTrailer(trailer)}
                        >
                          {trailer.format === "hls" ? "预告片（流媒体）" : "预告片（普通视频）"}
                        </Menu.Item>
                      ))}
                    </Menu.Dropdown>
                  </Menu>
                )}
              </Group>
            )}
            {preview && onCollect && (
              <Button loading={busy} onClick={() => void operate(onCollect)}>
                收藏并保存资料
              </Button>
            )}
            {tab !== "links" && resourceSearch && (
              <Group>
                <ResourceLookupButton
                  service={resourceSearch}
                  code={film.code}
                  workId={preview ? undefined : String(film.id)}
                  onStart={() => setTab("links")}
                />
              </Group>
            )}
            {!preview && (
              <Group gap="sm">
                <Button
                  disabled={!playable}
                  leftSection={<Icon name="play" size={16} />}
                  onClick={() => play(film)}
                >
                  播放影片
                </Button>
                <Button
                  variant="default"
                  leftSection={<Icon name="heart" size={16} />}
                  onClick={() => toggleFavorite(film)}
                >
                  {film.favorite ? "已收藏" : "收藏"}
                </Button>
                <Button
                  variant="light"
                  leftSection={<Icon name="scan" size={16} />}
                  onClick={() => {
                    onClose();
                    scrape(film);
                  }}
                >
                  刮削资料
                </Button>
                <Button variant="default" onClick={() => add("download", film)}>
                  下载视频
                </Button>
                <Button
                  variant="default"
                  loading={busy}
                  disabled={runtime !== "desktop"}
                  onClick={() => void attach()}
                >
                  关联视频
                </Button>
                <Menu position="bottom-end">
                  <Menu.Target>
                    <Button aria-label="更多影片操作" variant="default" px={10}>
                      <Icon name="more" />
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item onClick={() => setEditing(true)}>编辑资料</Menu.Item>
                    <Menu.Item onClick={() => setArtwork("fetch")}>获取封面与截图</Menu.Item>
                    <Menu.Item onClick={() => setTab("files")}>查看本地文件</Menu.Item>
                    <Menu.Divider />
                    <Menu.Item
                      color="red"
                      disabled={film.files?.some((file) => file.kind === "video")}
                      onClick={() => setRemoving(true)}
                    >
                      从片库移除
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </Group>
            )}
          </Stack>
        </Group>
        <Tabs value={tab} onChange={setTab} mt="xl">
          <Tabs.List mb="lg">
            <Tabs.Tab value="info">资料与截图</Tabs.Tab>
            <Tabs.Tab value="links">资源链接</Tabs.Tab>
            {!preview && <Tabs.Tab value="files">本地文件</Tabs.Tab>}
          </Tabs.List>
          <Tabs.Panel value="info">
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing={36}>
              <DataList orientation="horizontal" labelWidth={72} size="sm" gap={14}>
                {rows.map(([label, value]) => (
                  <DataList.Item key={label}>
                    <DataList.ItemLabel c="dimmed">{label}</DataList.ItemLabel>
                    <DataList.ItemValue style={{ overflowWrap: "anywhere" }}>
                      {value}
                    </DataList.ItemValue>
                  </DataList.Item>
                ))}
              </DataList>
              <FilmScreenshots
                film={film}
                label={preview || film.availability === "metadata_only" ? "预览截图" : "视频截图"}
                onAction={preview || !playable ? undefined : action}
              />
            </SimpleGrid>
            {metadata.plot && (
              <Stack gap="xs" mt="xl">
                <Text fw={600}>简介</Text>
                <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {metadata.plot}
                </Text>
              </Stack>
            )}
          </Tabs.Panel>
          <Tabs.Panel value="links">
            <FilmResources film={film} preview={preview} />
          </Tabs.Panel>
          {!preview && (
            <Tabs.Panel value="files">
              {film.files?.length ? (
                <Stack>
                  {film.files.map((file) => (
                    <Group key={file.path} justify="space-between">
                      <div>
                        <Text size="sm">{file.name}</Text>
                        <Text size="xs" c="dimmed">
                          {file.missing
                            ? "文件不可用"
                            : file.size || (file.kind === "metadata" ? "NFO 资料" : "")}
                        </Text>
                      </div>
                      <Group gap="xs">
                        {file.kind === "video" && (
                          <Button
                            variant="light"
                            size="xs"
                            disabled={file.missing}
                            onClick={() => playSource(file.path, { title: file.name })}
                          >
                            播放
                          </Button>
                        )}
                        <Button variant="subtle" size="xs" onClick={() => void copy(file.path)}>
                          复制路径
                        </Button>
                      </Group>
                    </Group>
                  ))}
                </Stack>
              ) : (
                <Empty
                  icon="folder"
                  title="暂无关联文件"
                  description="关联本地影片后，在这里查看文件信息。"
                />
              )}
            </Tabs.Panel>
          )}
        </Tabs>
      </Drawer>
      <Modal
        opened={removing}
        onClose={() => !busy && setRemoving(false)}
        title="从片库移除资料"
        centered
        closeOnClickOutside={!busy}
        closeOnEscape={!busy}
      >
        <Stack>
          <Text size="sm">
            移除这部未关联视频的作品及收藏记录。磁盘上的 NFO 和图片会保留，重新扫描可再次导入。
          </Text>
          <Button
            color="red"
            loading={busy}
            onClick={() =>
              void operate(async () => {
                await library.removeWork(film.id);
                setRemoving(false);
                onClose();
              })
            }
          >
            移出片库，保留文件
          </Button>
        </Stack>
      </Modal>
      {editing && <FilmEditor film={film} onClose={() => setEditing(false)} />}
      {artwork && <FilmArtworkEditor film={film} mode={artwork} onClose={() => setArtwork(null)} />}
    </>
  );
}
