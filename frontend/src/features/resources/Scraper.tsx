import { useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { Ref } from "react";
import { Button, Group, SegmentedControl, Tabs, Text } from "@mantine/core";
import type { Film } from "../../contracts/media";
import { useWorkspace } from "../../app/state";
import { Icon } from "../../components/icons";
import { BatchScraper } from "./BatchScraper";
import { MetaTubeSearch } from "./MetaTubeSearch";
import { ResourceSearch } from "./ResourceSearch";
import { FilmDetail } from "../films/FilmDetail";
import { movieDetailsToFilm } from "./movieDetailsFilm";
import type { ScrapeTask } from "../../contracts/scraping";
import type { MovieCandidate } from "../../services/metadata/MetaTubeService";

export interface ScraperHandle {
  showQueue: () => void;
  select: (film: Film, view: "match" | "links") => void;
}
export function Scraper({ ref }: { ref: Ref<ScraperHandle> }) {
  const { openFilm, scraping, notice, resourceSearch } = useWorkspace();
  const [searchMode, setSearchMode] = useState("video");
  const [matching, setMatching] = useState<ScrapeTask | null>(null);
  const [selected, setSelected] = useState<Film | null>(null);
  const [preview, setPreview] = useState<Film | null>(null);
  const [previewCandidate, setPreviewCandidate] = useState<MovieCandidate | null>(null);
  const collect = async (candidate: MovieCandidate) => {
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
    showQueue: () => {
      setMatching(null);
      setSelected(null);
      setTab("batch");
    },
    select: (film, view) => {
      setSelected(film);
      setMatching(null);
      setTab(view === "match" && scraping ? "batch" : "search");
      if (view === "links") {
        setSearchMode("video");
        resourceSearch?.search(film.code, String(film.id));
      }
    },
  }));
  return (
    <Tabs value={tab} onChange={setTab} className="fill-column">
      <Tabs.List mb="md">
        <Tabs.Tab value="search" leftSection={<Icon name="search" size={16} />}>
          搜索资源
        </Tabs.Tab>
        <Tabs.Tab value="batch" leftSection={<Icon name="layers" size={16} />}>
          批量刮削
        </Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="search" className="fill-column">
        <SegmentedControl
          mb="md"
          aria-label="搜索内容"
          value={searchMode}
          onChange={setSearchMode}
          data={[
            { value: "video", label: "视频资源" },
            { value: "metadata", label: "影片资料" },
          ]}
        />
        {searchMode === "video" ? (
          <ResourceSearch />
        ) : (
          <>
            {matching && (
              <Text size="sm" mb="sm">
                正在匹配：{matching.name}。选择正确资料后点击“采用并刮削”。
              </Text>
            )}
            {selected && (
              <Group mb="md" justify="space-between">
                <Text size="sm">当前影片：{selected.title}</Text>
                <Button variant="default" size="xs" onClick={() => openFilm(selected, "edit")}>
                  编辑并补全资料
                </Button>
              </Group>
            )}
            <MetaTubeSearch
              onCollect={collect}
              key={matching?.id ?? selected?.id ?? "search"}
              initialQuery={
                matching?.query || matching?.name || selected?.code || selected?.title || ""
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
                setPreviewCandidate(candidate);
              }}
            />
          </>
        )}
      </Tabs.Panel>
      <Tabs.Panel value="batch" className="fill-column">
        <BatchScraper
          onMatch={(task) => {
            setMatching(task);
            setSelected(null);
            setTab("search");
            setSearchMode("metadata");
          }}
        />
      </Tabs.Panel>
      <FilmDetail
        key={preview?.id}
        film={preview}
        initialView="info"
        preview
        onCollect={previewCandidate ? () => collect(previewCandidate) : undefined}
        onClose={() => setPreview(null)}
      />
    </Tabs>
  );
}
