import { useEffect, useRef, useState } from "react";
import { Button, Drawer, Menu, Modal, NumberInput, Popover, Radio, Tabs } from "@mantine/core";
import type { Film } from "./data";
import { sampleFilms } from "./data";
import type { FilmDetailView } from "./state";
import { usePrototype } from "./state";
import { getFilmMetadata } from "./filmMetadata";
import type { FilmFacet } from "./filmMetadata";
import { Icon, Poster } from "./visuals";
import { IconButton, Pill } from "./ui";
import { ObjectMenu, ObjectMenuButton, objectMenuKey } from "./ObjectMenu";
import { FilmScreenshots } from "./FilmScreenshots";
import type { ScreenshotAction } from "./FilmScreenshots";
import { allFrames } from "./FilmStills";
import { FilmArtworkEditor } from "./FilmArtworkEditor";
import type { ArtworkMode } from "./FilmArtworkEditor";
import { FilmEditor } from "./FilmEditor";
import { FilmResources } from "./FilmResources";
import "./film-detail.css";

interface Props {
  film: Film | null;
  initialView: FilmDetailView;
  onClose: () => void;
}
type Confirmation = { kind: "cover" | "frame" | "frames" | "delete"; index?: number };

export function FilmDetail({ film, ...props }: Props) {
  return film ? <FilmDetailContent film={film} {...props} /> : null;
}

function FilmDetailContent({ film, initialView, onClose }: Omit<Props, "film"> & { film: Film }) {
  const { play, scrape, browseFacet, notice, setFilms } = usePrototype();
  const [editing, setEditing] = useState(initialView === "edit");
  const [tab, setTab] = useState<string | null>(
    initialView === "files" ? "files" : initialView === "links" ? "links" : "info",
  );
  const [frame, setFrame] = useState<number | null>(
    initialView === "screenshots" ? ((film.previewFrames ?? allFrames)[0] ?? null) : null,
  );
  const [artwork, setArtwork] = useState<ArtworkMode | null>(null);
  const [coverZoom, setCoverZoom] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [ratingOpen, setRatingOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [deleteMode, setDeleteMode] = useState("record");
  const metadata = getFilmMetadata(film);
  const filePath = `${metadata.directory}\\${metadata.fileName}`;
  const overlay =
    editing ||
    frame !== null ||
    artwork !== null ||
    coverZoom ||
    folderOpen ||
    ratingOpen ||
    confirmation !== null;
  const contentRef = useRef<HTMLDivElement>(null);
  const controlRef = useRef<HTMLElement | null>(null);
  const overlayWasOpened = useRef(overlay);
  useEffect(() => {
    if (overlay) {
      overlayWasOpened.current = true;
      return;
    }
    if (!overlayWasOpened.current) return;
    overlayWasOpened.current = false;
    // 抽屉重新启用焦点约束后，返回刚才的操作入口。
    const timeout = window.setTimeout(() => {
      const control = controlRef.current;
      const fallback = contentRef.current?.querySelector<HTMLElement>(
        '[aria-label="更多影片操作"]',
      );
      (control?.isConnected ? control : fallback)?.focus({ preventScroll: true });
    });
    return () => window.clearTimeout(timeout);
  }, [overlay]);
  const patch = (value: Partial<Film>) =>
    setFilms((previous) =>
      previous.map((item) => (item.id === film.id ? { ...item, ...value } : item)),
    );
  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notice(`${label}已复制`);
    } catch {
      notice("复制失败，请重试");
    }
  };
  const launchPlayer = () => {
    onClose();
    play(film);
  };
  const findResources = () => {
    onClose();
    scrape(film, "links");
  };
  const facet = (name: FilmFacet, values: string[]) =>
    values.length ? (
      <div className="film-facet-values">
        {values.map((value) => (
          <button
            type="button"
            key={value}
            onClick={() => {
              onClose();
              browseFacet(name, value);
            }}
          >
            {value}
            <Icon name="chevron" size={12} />
          </button>
        ))}
      </div>
    ) : (
      <span className="muted">未填写</span>
    );
  const completeMetadata = () => {
    const sample = sampleFilms.find((item) => item.id === film.id) ?? sampleFilms[0]!;
    const fallback = getFilmMetadata({ ...sample, missing: false });
    const actors = metadata.actors.length ? metadata.actors : fallback.actors;
    const genres = metadata.genres.length ? metadata.genres : fallback.genres;
    patch({
      missing: false,
      actor: actors[0],
      genre: genres[0] ?? film.genre,
      rating: film.rating ?? sample.rating,
      coverFrame: film.coverFrame === null ? undefined : film.coverFrame,
      previewFrames: (film.previewFrames ?? allFrames).length ? film.previewFrames : allFrames,
      metadata: {
        ...fallback,
        ...metadata,
        actors,
        genres,
        director: metadata.director || fallback.director,
        studio: metadata.studio || fallback.studio,
        series: metadata.series || fallback.series,
        premiered: metadata.premiered || fallback.premiered,
        source: "来源 A · 融合资料",
      },
    });
    notice("已补全缺失资料，已有内容保持不变");
  };
  const screenshotAction = (action: ScreenshotAction, index?: number) => {
    if (action === "cover" && index !== undefined) {
      patch({ coverFrame: index });
      notice("封面已更新");
    } else if (action === "remove") setConfirmation({ kind: "frame", index });
    else if (action === "clear") setConfirmation({ kind: "frames" });
    else if (action === "capture" || action === "fetch" || action === "long") setArtwork(action);
  };
  const coverMenu = (
    <>
      <Menu.Item disabled={film.coverFrame === null} onClick={() => setCoverZoom(true)}>
        查看封面
      </Menu.Item>
      <Menu.Item leftSection={<Icon name="download" />} onClick={() => setArtwork("fetch")}>
        获取封面与截图
      </Menu.Item>
      <Menu.Item leftSection={<Icon name="image" />} onClick={() => setArtwork("cover")}>
        从视频选取封面
      </Menu.Item>
      <Menu.Divider />
      <Menu.Item
        color="red"
        disabled={film.coverFrame === null}
        onClick={() => setConfirmation({ kind: "cover" })}
      >
        移除封面
      </Menu.Item>
    </>
  );
  const files = [
    { name: metadata.fileName, size: film.size, kind: "video" },
    ...(film.coverFrame !== null ? [{ name: "poster.jpg", size: "1.2 MB", kind: "cover" }] : []),
    ...(metadata.source !== "本地文件" ? [{ name: "movie.nfo", size: "4 KB", kind: "nfo" }] : []),
    ...(film.previewFrames ?? allFrames).map((index) => ({
      name: `screenshot-${String(index + 1).padStart(2, "0")}.jpg`,
      size: "640 KB",
      kind: `frame-${index}`,
    })),
    ...(film.hasLongScreenshot
      ? [{ name: "contact-sheet.jpg", size: "2.8 MB", kind: "long" }]
      : []),
  ];
  const fileList = (
    <div className="film-file-list">
      {files.map((file) => (
        <div className="film-file-row" key={file.name}>
          <Icon name={file.kind === "video" ? "play" : file.kind === "nfo" ? "list" : "image"} />
          <span>{file.name}</span>
          <small>{file.size}</small>
          <IconButton
            icon="link"
            label={`复制 ${file.name} 路径`}
            onClick={() => void copy(`${metadata.directory}\\${file.name}`, "文件路径")}
          />
        </div>
      ))}
    </div>
  );
  const confirmAction = () => {
    if (confirmation?.kind === "cover") patch({ coverFrame: null });
    else if (confirmation?.kind === "frame")
      patch({
        previewFrames: (film.previewFrames ?? allFrames).filter(
          (index) => index !== confirmation.index,
        ),
      });
    else if (confirmation?.kind === "frames") patch({ previewFrames: [] });
    else if (confirmation?.kind === "delete") {
      if (deleteMode === "metadata") {
        patch({
          missing: true,
          rating: undefined,
          actor: undefined,
          genre: "未分类",
          coverFrame: null,
          previewFrames: [],
          hasLongScreenshot: false,
          metadata: {
            ...metadata,
            director: "",
            studio: "",
            series: "",
            actors: [],
            genres: [],
            premiered: "",
            source: "本地文件",
          },
        });
        notice("刮削资料已清除，视频保留");
      } else {
        setFilms((previous) => previous.filter((item) => item.id !== film.id));
        onClose();
        notice(deleteMode === "record" ? "已从片库移除，文件保留" : "影片及关联文件已移除");
      }
    }
    setConfirmation(null);
  };
  return (
    <>
      <Drawer
        opened
        onClose={onClose}
        position="right"
        size="min(900px, 100vw)"
        title="影片详情"
        className="film-detail-drawer"
        closeOnEscape={!overlay}
        closeOnClickOutside={!overlay}
        trapFocus={!overlay}
        returnFocus={false}
        overlayProps={{ backgroundOpacity: 0.48, blur: 3 }}
      >
        <div
          ref={contentRef}
          onFocusCapture={(event) => {
            if (event.currentTarget.contains(event.target)) controlRef.current = event.target;
          }}
        >
          <div className="film-detail-header">
            <ObjectMenu items={coverMenu}>
              <div className="film-detail-cover">
                <button
                  type="button"
                  className="film-cover-preview"
                  aria-label="查看影片封面"
                  disabled={film.coverFrame === null}
                  onClick={() => setCoverZoom(true)}
                  onKeyDown={objectMenuKey}
                >
                  <Poster film={film} />
                </button>
                <ObjectMenuButton label="封面操作" />
              </div>
            </ObjectMenu>
            <div className="film-detail-summary">
              <div className="film-detail-kicker">
                <button
                  type="button"
                  className="film-code-copy"
                  onClick={() => void copy(film.code, "番号")}
                  title="复制番号"
                >
                  {film.code || "番号未填写"}
                  <Icon name="link" size={13} />
                </button>
                <Pill>{film.quality}</Pill>
                {film.missing && <Pill tone="warning">资料待补全</Pill>}
              </div>
              <h2>{film.title}</h2>
              <div className="film-detail-facts">
                <span>{metadata.premiered || "发行日期未知"}</span>
                <span>
                  <Icon name="clock" size={14} />
                  {film.duration ? `${film.duration} 分钟` : "时长未知"}
                </span>
                <span>{film.size}</span>
              </div>
              <Popover
                width={230}
                position="bottom-start"
                zIndex={350}
                trapFocus
                opened={ratingOpen}
                onChange={setRatingOpen}
              >
                <Popover.Target>
                  <button
                    type="button"
                    className="film-rating"
                    aria-label="修改影片评分"
                    onClick={() => setRatingOpen((previous) => !previous)}
                  >
                    <Icon name="star" size={19} />
                    <strong>{film.rating == null ? "暂无评分" : film.rating.toFixed(1)}</strong>
                    {film.rating != null && <span>/ 10</span>}
                    <Icon name="edit" size={12} />
                  </button>
                </Popover.Target>
                <Popover.Dropdown>
                  <NumberInput
                    label="影片评分"
                    min={0}
                    max={10}
                    step={0.1}
                    decimalScale={1}
                    value={film.rating ?? ""}
                    onChange={(value) =>
                      patch({ rating: value === "" ? undefined : Number(value) })
                    }
                  />
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    mt="xs"
                    onClick={() => patch({ rating: undefined })}
                  >
                    清除评分
                  </Button>
                </Popover.Dropdown>
              </Popover>
              <div className="film-primary-actions">
                <Button leftSection={<Icon name="play" size={17} />} onClick={launchPlayer}>
                  播放影片
                </Button>
                <Button
                  variant="default"
                  leftSection={<Icon name="scan" size={16} />}
                  onClick={completeMetadata}
                >
                  一键刮削
                </Button>
                <Button
                  variant="default"
                  leftSection={<Icon name="edit" size={16} />}
                  onClick={() => setEditing(true)}
                >
                  编辑资料
                </Button>
                <IconButton
                  icon="heart"
                  label={film.favorite ? "取消影片收藏" : "收藏影片"}
                  active={film.favorite}
                  onClick={() => patch({ favorite: !film.favorite })}
                />
                <Menu position="bottom-end" zIndex={350}>
                  <Menu.Target>
                    <Button
                      variant="default"
                      className="film-more-button"
                      aria-label="更多影片操作"
                    >
                      <Icon name="more" />
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item
                      leftSection={<Icon name="search" />}
                      onClick={() => {
                        onClose();
                        scrape(film);
                      }}
                    >
                      手动匹配资料
                    </Menu.Item>
                    <Menu.Item leftSection={<Icon name="link" />} onClick={() => setTab("links")}>
                      资源链接
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<Icon name="image" />}
                      onClick={() => setArtwork("fetch")}
                    >
                      获取封面与截图
                    </Menu.Item>
                    <Menu.Divider />
                    <Menu.Item
                      leftSection={<Icon name="folder" />}
                      onClick={() => setFolderOpen(true)}
                    >
                      打开所在文件夹
                    </Menu.Item>
                    <Menu.Item onClick={() => void copy(filePath, "文件路径")}>
                      复制文件路径
                    </Menu.Item>
                    <Menu.Divider />
                    <Menu.Item
                      color="red"
                      leftSection={<Icon name="trash" />}
                      onClick={() => {
                        setDeleteMode("record");
                        setConfirmation({ kind: "delete" });
                      }}
                    >
                      移除与清理
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </div>
            </div>
          </div>
          <Tabs value={tab} onChange={setTab} className="film-detail-tabs" keepMounted={false}>
            <Tabs.List>
              <Tabs.Tab value="info">资料与截图</Tabs.Tab>
              <Tabs.Tab value="links">资源链接</Tabs.Tab>
              <Tabs.Tab value="files">
                本地文件 <span className="tab-count">{files.length}</span>
              </Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="info">
              <div className="film-detail-overview">
                <dl className="film-metadata-grid">
                  <div>
                    <dt>演员</dt>
                    <dd>{facet("演员", metadata.actors)}</dd>
                  </div>
                  <div>
                    <dt>导演</dt>
                    <dd>{facet("导演", metadata.director ? [metadata.director] : [])}</dd>
                  </div>
                  <div>
                    <dt>厂商</dt>
                    <dd>{facet("厂商", metadata.studio ? [metadata.studio] : [])}</dd>
                  </div>
                  <div>
                    <dt>系列</dt>
                    <dd>{facet("系列", metadata.series ? [metadata.series] : [])}</dd>
                  </div>
                  <div className="metadata-wide">
                    <dt>分类</dt>
                    <dd>{facet("分类", metadata.genres)}</dd>
                  </div>
                  <div className="metadata-wide">
                    <dt>原始名称</dt>
                    <dd className="film-original-title">{metadata.originalTitle}</dd>
                  </div>
                  <div>
                    <dt>分辨率</dt>
                    <dd>{metadata.resolution || "未知"}</dd>
                  </div>
                  <div>
                    <dt>资料来源</dt>
                    <dd>{metadata.source}</dd>
                  </div>
                </dl>
                <FilmScreenshots
                  film={film}
                  frame={frame}
                  setFrame={setFrame}
                  onAction={screenshotAction}
                />
              </div>
            </Tabs.Panel>
            <Tabs.Panel value="links">
              <FilmResources film={film} onSearch={findResources} />
            </Tabs.Panel>
            <Tabs.Panel value="files">
              <div className="film-detail-section-head">
                <span className="path-text">{metadata.directory}</span>
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<Icon name="folder" size={15} />}
                  onClick={() => setFolderOpen(true)}
                >
                  打开文件夹
                </Button>
              </div>
              <div className="film-file-specs">
                <span>{metadata.resolution}</span>
                <span>HEVC</span>
                <span>23.976 fps</span>
                <span>AAC 2.0</span>
                <span>{film.size}</span>
              </div>
              {fileList}
            </Tabs.Panel>
          </Tabs>
        </div>
      </Drawer>
      {editing && <FilmEditor film={film} onClose={() => setEditing(false)} />}
      {artwork && <FilmArtworkEditor film={film} mode={artwork} onClose={() => setArtwork(null)} />}
      <Modal
        opened={coverZoom}
        onClose={() => setCoverZoom(false)}
        title={`${film.title} · 封面`}
        size={600}
        centered
        zIndex={400}
        returnFocus={false}
      >
        <div className="film-cover-large">
          <Poster film={film} />
        </div>
      </Modal>
      <Modal
        opened={folderOpen}
        onClose={() => setFolderOpen(false)}
        title="所在文件夹"
        size={620}
        centered
        zIndex={400}
        returnFocus={false}
      >
        <div className="film-folder-path">
          <Icon name="folder" />
          <span className="path-text">{metadata.directory}</span>
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={() => void copy(metadata.directory, "目录路径")}
          >
            复制路径
          </Button>
        </div>
        {fileList}
      </Modal>
      <Modal
        opened={confirmation !== null}
        onClose={() => setConfirmation(null)}
        title={
          confirmation?.kind === "delete"
            ? "移除与清理"
            : confirmation?.kind === "cover"
              ? "移除封面"
              : "移除截图"
        }
        centered
        zIndex={400}
        returnFocus={false}
      >
        {confirmation?.kind === "delete" ? (
          <>
            <p className="film-delete-title">
              {film.code} · {film.title}
            </p>
            <Radio.Group value={deleteMode} onChange={setDeleteMode} label="处理方式">
              <div className="film-delete-options">
                <Radio value="record" label="仅从片库移除" description="保留视频、图片和资料文件" />
                <Radio
                  value="metadata"
                  label="清除刮削资料"
                  description="保留视频，移除封面、截图及 NFO"
                />
                <Radio
                  value="files"
                  label="删除影片及关联文件"
                  description="同时删除视频、图片、资料和片库记录"
                />
              </div>
            </Radio.Group>
          </>
        ) : (
          <p>
            {confirmation?.kind === "cover"
              ? "移除当前封面，视频文件保留。"
              : confirmation?.kind === "frames"
                ? "清空全部视频截图，封面和视频文件保留。"
                : "移除这张截图，视频文件保留。"}
          </p>
        )}
        <div className="modal-footer">
          <Button variant="default" onClick={() => setConfirmation(null)}>
            取消
          </Button>
          <Button color="red" onClick={confirmAction}>
            {confirmation?.kind === "delete"
              ? deleteMode === "metadata"
                ? "清除资料"
                : deleteMode === "files"
                  ? "删除影片及文件"
                  : "移出片库"
              : "确认移除"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
