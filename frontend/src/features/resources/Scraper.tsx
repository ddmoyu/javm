import { useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { Ref } from "react";
import { Button, Group, Tabs, Text } from "@mantine/core";
import type { Film } from "../../contracts/media";
import { useWorkspace } from "../../app/state";
import { Icon } from "../../components/icons";
import { BatchScraper } from "./BatchScraper";
import { MetaTubeSearch } from "./MetaTubeSearch";
import { FilmDetail } from "../films/FilmDetail";
import { movieDetailsToFilm } from "./movieDetailsFilm";
import type { ScrapeTask } from "../../contracts/scraping";
import type { MovieCandidate } from "../../services/metadata/MetaTubeService";

export interface ScraperHandle {
  showSearch: (query?: string) => void;
  showQueue: () => void;
  select: (film: Film, view: "match" | "links") => void;
}
export function Scraper({ ref }: { ref: Ref<ScraperHandle> }) {
  const { openFilm, scraping, notice } = useWorkspace();
  const [matching, setMatching] = useState<ScrapeTask | null>(null);
  const [selected, setSelected] = useState<Film | null>(null);
  const [searchRequest, setSearchRequest] = useState({ query: "", revision: 0 });
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
    showSearch: (query) => {
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
    select: (film, view) => {
      setMatching(null);
      if (view === "links") {
        setSelected(null);
        setTab("search");
        openFilm(film, "links");
      } else {
        setSelected(film);
        setTab(scraping ? "batch" : "search");
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
          allowResourceLookup={!matching}
          onCollect={collect}
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
          }}
        />
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
        initialView="info"
        preview
        onCollect={previewCandidate ? () => collect(previewCandidate) : undefined}
        onClose={() => setPreview(null)}
      />
    </Tabs>
  );
}
