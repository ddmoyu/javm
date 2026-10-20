import { t, localizeOptions, useLocale } from "../../i18n/index";
import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Ref } from "react";
import { Alert, Button, Group, SegmentedControl, Tabs, Text } from "@mantine/core";
import { MagnetSearchPanel } from "./MagnetSearch";
import type { Film } from "../../contracts/media";
import { useWorkspace } from "../../app/state";
import { Icon } from "../../components/icons";
import { BatchScraper } from "./BatchScraper";
import { MetaTubeSearch } from "./MetaTubeSearch";
import { FilmDetail } from "../films/FilmDetail";
import { movieDetailsToFilm } from "./movieDetailsFilm";
import type { ScrapeTask } from "../../contracts/scraping";
import type { MovieCandidate, MovieDetails } from "../../services/metadata/MetaTubeService";

export interface ScraperHandle {
  showSearch: (query?: string) => void;
  showQueue: () => void;
  select: (film: Film) => void;
}
const noSubscribe = () => () => {};
export function Scraper({ ref }: { ref: Ref<ScraperHandle> }) {
  useLocale();
  const { openFilm, scraping, notice, library, resourceSearch } = useWorkspace();
  const [matching, setMatching] = useState<ScrapeTask | null>(null);
  const [searchKind, setSearchKind] = useState("metadata");
  const [selected, setSelected] = useState<Film | null>(null);
  const [searchRequest, setSearchRequest] = useState({ query: "", revision: 0 });
  const [preview, setPreview] = useState<Film | null>(null);
  const [previewCandidate, setPreviewCandidate] = useState<MovieCandidate | null>(null);
  const [previewDetails, setPreviewDetails] = useState<MovieDetails | null>(null);
  const [previewView, setPreviewView] = useState<"info" | "links">("info");
  const [collecting, setCollecting] = useState(false);
  const artwork = library.artwork;
  const artworkState = useSyncExternalStore(
    artwork?.subscribe ?? noSubscribe,
    () => artwork?.getSnapshot() ?? null,
  );
  const collect = async (candidate: MovieCandidate, details?: MovieDetails) => {
    if (details) {
      setCollecting(true);
      try {
        let warning = "";
        const saved = await library.collectMetadata(details, (message) => {
          warning = message;
        });
        setPreview(null);
        notice(warning || "资料已保存到片库，可查找资源或关联本地视频。");
        openFilm(saved);
      } finally {
        setCollecting(false);
      }
      return;
    }
    if (!scraping) throw new Error("请在桌面应用中保存资料。");
    await scraping.enqueue({ name: candidate.title || candidate.code, candidate, collect: true });
    notice("已加入资料刮削队列，可在批量刮削中查看进度。");
  };
  const previewOrigin = useRef<HTMLButtonElement | null>(null);
  const [tab, setTab] = useState<string | null>("search");
  useLayoutEffect(() => {
    if (preview || !previewOrigin.current) return;
    const origin = previewOrigin.current;
    if (origin.isConnected && origin.getClientRects().length) origin.focus({ preventScroll: true });
    previewOrigin.current = null;
  }, [preview]);
  useImperativeHandle(ref, () => ({
    showSearch: (query) => {
      setSearchKind("metadata");
      setMatching(null);
      setSelected(null);
      if (query !== undefined)
        setSearchRequest((value) => ({ query, revision: value.revision + 1 }));
      setTab("search");
    },
    showQueue: () => {
      setMatching(null);
      setSelected(null);
      setTab("batch");
    },
    select: (film) => {
      setMatching(null);
      setSelected(film);
      setTab(scraping ? "batch" : "search");
    },
  }));
  return (
    <Tabs value={tab} onChange={setTab} className="fill-column">
      <Tabs.List mb="md">
        <Tabs.Tab value="search" leftSection={<Icon name="search" size={16} />}>
          {t("搜索资源")}
        </Tabs.Tab>
        <Tabs.Tab value="batch" leftSection={<Icon name="layers" size={16} />}>
          {t("批量刮削")}
        </Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="search" className="fill-column">
        {!matching && resourceSearch?.magnets && (
          <Group mb="md">
            <SegmentedControl
              size="sm"
              aria-label={t("资源搜索类型")}
              value={searchKind}
              onChange={setSearchKind}
              data={localizeOptions([
                { value: "metadata", label: "影片资料" },
                { value: "magnet", label: "磁力资源" },
              ])}
            />
          </Group>
        )}
        {resourceSearch?.magnets && (
          <div
            className="fill-column"
            style={{
              overflow: "auto",
              display: !matching && searchKind === "magnet" ? undefined : "none",
            }}
          >
            <MagnetSearchPanel service={resourceSearch.magnets} notice={notice} />
          </div>
        )}
        <div
          className="fill-column"
          style={{
            display:
              !matching && searchKind === "magnet" && resourceSearch?.magnets ? "none" : undefined,
          }}
        >
          {collecting && !preview && artworkState?.busy && (
            <Group justify="space-between" mb="sm">
              <Text size="sm" component="output" aria-live="polite">
                {t("正在保存图片 · {0} / {1}", artworkState.processed, artworkState.total)}
              </Text>
              <Button size="xs" variant="default" onClick={artwork?.cancel}>
                {t("停止获取图片")}
              </Button>
            </Group>
          )}
          {selected && (
            <Group mb="md" justify="space-between">
              <Text size="sm">{t("当前影片：{0}", selected.title)}</Text>
              <Button variant="default" size="xs" onClick={() => openFilm(selected, "edit")}>
                {t("编辑并补全资料")}
              </Button>
            </Group>
          )}
          <MetaTubeSearch
            allowResourceLookup={!matching}
            onCollect={collect}
            onLookupResources={(code, trigger) => {
              previewOrigin.current = trigger;
              const candidate = { provider: "", id: `code:${code}`, code, title: code };
              setPreview(
                movieDetailsToFilm(
                  { ...candidate, fields: { code, title: code }, homepage: "" },
                  candidate,
                ),
              );
              setPreviewCandidate(null);
              setPreviewDetails(null);
              setPreviewView("links");
              resourceSearch?.search(code);
            }}
            key={matching?.id ?? selected?.id ?? searchRequest.revision}
            initialQuery={
              matching?.query ||
              matching?.name ||
              selected?.code ||
              selected?.title ||
              searchRequest.query
            }
            onApply={
              matching && scraping
                ? async (candidate) => {
                    await scraping.retry(matching.id, undefined, candidate);
                    setMatching(null);
                    setTab("batch");
                  }
                : undefined
            }
            onSelect={(details, candidate, trigger) => {
              previewOrigin.current = trigger;
              setPreview(movieDetailsToFilm(details, candidate));
              setPreviewCandidate(candidate.provider ? candidate : null);
              setPreviewDetails(details);
              setPreviewView("info");
            }}
          />
        </div>
      </Tabs.Panel>
      <Tabs.Panel value="batch" className="fill-column">
        <BatchScraper
          onMatch={(task) => {
            setMatching(task);
            setSelected(null);
            setTab("search");
          }}
        />
      </Tabs.Panel>
      <FilmDetail
        key={preview?.id}
        film={preview}
        initialView={previewView}
        preview
        onCollect={
          previewCandidate && previewDetails
            ? () => collect(previewCandidate, previewDetails)
            : undefined
        }
        previewStatus={
          collecting && artworkState?.busy ? (
            <Group justify="space-between">
              <Text size="sm" component="output" aria-live="polite">
                {t("正在保存图片 · {0} / {1}", artworkState.processed, artworkState.total)}
              </Text>
              <Button size="xs" variant="default" onClick={artwork?.cancel}>
                {t("停止获取图片")}
              </Button>
            </Group>
          ) : !previewDetails ? (
            <Alert color="yellow">{t("尚未获取影片资料，此处仅按番号查找资源链接。")}</Alert>
          ) : undefined
        }
        onClose={() => setPreview(null)}
      />
    </Tabs>
  );
}
