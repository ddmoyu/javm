import { useEffect, useState, useSyncExternalStore } from "react";
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
import { FilmDeleteDialog } from "./FilmDeleteDialog";
import { FilmResources } from "./FilmResources";
import { os } from "@neutralinojs/lib";
import { copyText } from "../../platform/neutralino/clipboard";
import { libraryError } from "../../services/library/LibraryService";
import { LibraryDocumentsPanel } from "../directories/LibraryDocumentsPanel";
import { FileOrganizationModal } from "./FileOrganizationModal";

interface Props {
  film: Film | null;
  initialView: FilmDetailView;
  preview?: boolean;
  onCollect?: () => Promise<void>;
  previewStatus?: ReactNode;
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
  previewStatus,
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
    downloads,
  } = useWorkspace();
  const downloadConfirmation = useSyncExternalStore(downloads.subscribe, downloads.getConfirmation);
  const [busy, setBusy] = useState(false);
  const [deletingVideo, setDeletingVideo] = useState<Film | null>(null);
  const [organizing, setOrganizing] = useState<{ id: string; path: string } | null>(null);
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
  const [artworkSource, setArtworkSource] = useState<string>();
  const [removingImages, setRemovingImages] = useState<{ ids?: string[] } | null>(null);
  const [tab, setTab] = useState<string | null>(initialView === "links" ? "links" : "info");
  const lookupWorkId = preview ? undefined : String(film.id);
  useEffect(
    () => resourceSearch?.magnets?.holdView(film.code || film.title),
    [resourceSearch, film.code, film.title],
  );
  // 资源查找随详情页存在；关闭或切换到其他影片后结束该番号仍在进行的后台取流。
  useEffect(
    () => resourceSearch?.holdView(film.code, lookupWorkId),
    [resourceSearch, film.code, lookupWorkId],
  );
  const metadata = getFilmMetadata(film);
  const covers: MediaImage[] = film.artwork?.length
    ? film.artwork
    : film.coverUrl
      ? [{ src: film.coverUrl, title: `${film.title} · 封面` }]
      : [];
  const gallery: MediaImage[] = [...covers, ...(film.screenshots ?? [])];
  const playTrailer = (trailer: MediaTrailer) => {
    onClose();
    playSource(trailer.src, {
      title: `${film.code || film.title} · 预览片`,
      format: trailer.format,
      referer: metadata.homepage || undefined,
    });
  };
  const overlay =
    opened ||
    editing ||
    artwork !== null ||
    !!deletingVideo ||
    !!removingImages ||
    !!organizing ||
    !!downloadConfirmation;
  const copy = async (value: string) => {
    try {
      await copyText(value);
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
  const action = (value: ScreenshotAction, index?: number) => {
    if (!library.artwork) {
      unavailable("图片管理");
      return;
    }
    if (value === "clear") setRemovingImages({});
    else if (value === "remove") {
      const id = film.screenshots?.[index ?? -1]?.id;
      if (id) setRemovingImages({ ids: [id] });
    } else {
      setArtworkSource(value === "cover" ? film.screenshots?.[index ?? -1]?.path : undefined);
      setArtwork(value);
    }
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
              onClick={() => open(gallery, 0, metadata.homepage)}
            >
              <Poster film={film} />
            </UnstyledButton>
            {covers.length > 1 && (
              <Button
                variant="subtle"
                size="compact-xs"
                fullWidth
                mt="xs"
                onClick={() => open(gallery, 0, metadata.homepage)}
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
            {preview && onCollect && (
              <Group gap="sm" wrap="wrap">
                <Button loading={busy} onClick={() => void operate(onCollect)}>
                  收藏并保存资料
                </Button>
              </Group>
            )}
            {preview && previewStatus}
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
                {/* 已有可播放的本地视频时不再突出下载与关联，关联入口收进更多菜单。 */}
                {!playable && (
                  <>
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
                  </>
                )}
                <Menu position="bottom-end">
                  <Menu.Target>
                    <Button aria-label="更多影片操作" variant="default" px={10}>
                      <Icon name="more" />
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item onClick={() => setEditing(true)}>编辑资料</Menu.Item>
                    <Menu.Item onClick={() => action("fetch")}>获取封面与截图</Menu.Item>
                    <Menu.Item onClick={() => setTab("files")}>查看本地文件</Menu.Item>
                    {playable && (
                      <Menu.Item
                        disabled={busy || runtime !== "desktop"}
                        onClick={() => void attach()}
                      >
                        关联其他视频
                      </Menu.Item>
                    )}
                    <Menu.Divider />
                    <Menu.Item
                      color="red"
                      disabled={busy || !library.maintenance}
                      onClick={() => setDeletingVideo(film)}
                    >
                      删除
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </Group>
            )}
          </Stack>
        </Group>
        <Tabs value={tab} onChange={setTab} mt="xl">
          <Tabs.List mb="lg">
            <Tabs.Tab value="info">资料与预览</Tabs.Tab>
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
                label="预览"
                onAction={preview ? undefined : action}
                onPlayTrailer={playTrailer}
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
              {library.documents && (
                <LibraryDocumentsPanel service={library.documents} workId={String(film.id)} />
              )}
              {film.files?.length ? (
                <Stack>
                  {film.files.map((file) => (
                    <Group key={file.path} justify="space-between">
                      <div>
                        <Text size="sm">
                          {file.part
                            ? `第 ${file.part}${file.parts ? `／${file.parts}` : ""} 卷 · `
                            : ""}
                          {file.name}
                        </Text>
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
                            onClick={() =>
                              playSource(file.streamUrl ?? file.path, {
                                title: file.name,
                              })
                            }
                          >
                            播放
                          </Button>
                        )}
                        <Button variant="subtle" size="xs" onClick={() => void copy(file.path)}>
                          复制路径
                        </Button>
                        {file.kind === "video" && file.id && library.maintenance && (
                          <Button
                            color="red"
                            variant="subtle"
                            size="xs"
                            disabled={busy}
                            onClick={() => setDeletingVideo({ ...film, files: [file] })}
                          >
                            删除
                          </Button>
                        )}
                        {file.kind === "video" &&
                          file.id &&
                          !file.missing &&
                          library.organization && (
                            <Button
                              size="xs"
                              variant="subtle"
                              disabled={busy}
                              onClick={() => setOrganizing({ id: file.id!, path: file.path })}
                            >
                              改名／移动
                            </Button>
                          )}
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
      {deletingVideo && (
        <FilmDeleteDialog film={deletingVideo} onClose={() => setDeletingVideo(null)} />
      )}
      {editing && <FilmEditor film={film} onClose={() => setEditing(false)} />}
      {organizing && library.organization && (
        <FileOrganizationModal
          service={library.organization}
          file={organizing}
          onClose={() => setOrganizing(null)}
        />
      )}
      <Modal
        opened={!!removingImages}
        onClose={() => !busy && setRemovingImages(null)}
        title={removingImages?.ids ? "删除截图" : "清空截图"}
        centered
      >
        <Stack>
          <Text size="sm">删除这部作品的所选截图文件与记录，当前封面会保留。</Text>
          <Button
            color="red"
            loading={busy}
            onClick={() =>
              void operate(async () => {
                await library.artwork!.remove(String(film.id), removingImages?.ids);
                setRemovingImages(null);
              })
            }
          >
            确认删除
          </Button>
        </Stack>
      </Modal>
      {artwork && (
        <FilmArtworkEditor
          film={film}
          mode={artwork}
          source={artworkSource}
          onClose={() => {
            setArtwork(null);
            setArtworkSource(undefined);
          }}
        />
      )}
    </>
  );
}
