import { useState } from "react";
import { Button, Menu, Modal } from "@mantine/core";
import type { Film } from "./data";
import { getFilmMetadata } from "./filmMetadata";
import { allFrames, FilmStill, scenes, timestamp } from "./FilmStills";
import { usePrototype } from "./state";
import { Icon, Poster } from "./visuals";
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
    <section className="search-movie-information" aria-label="完整影片资料">
      <div className="search-movie-heading">
        {film ? (
          <button
            type="button"
            className="search-detail-poster"
            onClick={() => setPreview("cover")}
            aria-label="查看搜索影片封面"
          >
            <Poster film={film} compact />
          </button>
        ) : (
          <div className="search-detail-poster search-no-poster">
            <Icon name="image" size={30} />
          </div>
        )}
        <div className="search-movie-heading-copy">
          <div className="search-movie-code">
            <span className="mono">{match.code}</span>
            <Pill tone={localFilm ? "success" : "neutral"}>
              {localFilm ? "已在片库" : "未入库"}
            </Pill>
            {(match.metadataSources?.length ?? 0) > 1 && (
              <span title={match.metadataSources!.join("、")}>
                {match.metadataSources!.length} 个来源
              </span>
            )}
          </div>
          <h2>{film?.title ?? "影片资料未匹配"}</h2>
          {film && (
            <div className="search-movie-metrics">
              <span>{film.year}</span>
              <span>{film.duration} 分钟</span>
              <span>
                <Icon name="star" size={13} /> {film.rating?.toFixed(1) ?? "暂无评分"}
              </span>
              <Pill>{film.quality}</Pill>
            </div>
          )}
          <div className="search-movie-actions">
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
                <Button variant="subtle" size="xs" rightSection={<Icon name="down" size={13} />}>
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
          </div>
        </div>
      </div>
      {film && metadata ? (
        <>
          <dl className="search-movie-facts">
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
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
            <div className="search-original-name">
              <dt>原始名称</dt>
              <dd>{metadata.originalTitle || "未知"}</dd>
            </div>
          </dl>
          <section className="search-movie-stills" aria-label="搜索影片截图">
            <span>
              视频截图 <small>{frames.length}</small>
            </span>
            <div>
              {frames.map((frame) => (
                <button
                  type="button"
                  key={frame}
                  onClick={() => setPreview(frame)}
                  aria-label={`查看搜索截图 ${frame + 1}`}
                >
                  <FilmStill index={frame} label={scenes[frame]!} />
                  <time>{timestamp(film, frame)}</time>
                </button>
              ))}
            </div>
          </section>
        </>
      ) : (
        <p className="search-missing-metadata">
          {packet.sources.metadata === "searching"
            ? "正在获取影片资料"
            : "暂未找到影片资料，可继续查看下方资源。"}
        </p>
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
            <div className="search-cover-preview">
              <Poster film={film} />
            </div>
          ) : typeof preview === "number" ? (
            <>
              <div className="search-still-preview">
                <FilmStill index={preview} label={scenes[preview]!} />
              </div>
              <div className="search-still-controls">
                <IconButton
                  icon="chevron"
                  label="上一张搜索截图"
                  onClick={() =>
                    setPreview(
                      frames[(frames.indexOf(preview) - 1 + frames.length) % frames.length]!,
                    )
                  }
                />
                <span>
                  {frames.indexOf(preview) + 1} / {frames.length}
                </span>
                <IconButton
                  icon="chevron"
                  label="下一张搜索截图"
                  onClick={() => setPreview(frames[(frames.indexOf(preview) + 1) % frames.length]!)}
                />
              </div>
            </>
          ) : null)}
      </Modal>
    </section>
  );
}
