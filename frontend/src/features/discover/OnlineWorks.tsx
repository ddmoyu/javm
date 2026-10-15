import { t, localizeOptions, useLocale } from "../../i18n/index";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Alert, Badge, Button, Group, Loader, Select, Text, UnstyledButton } from "@mantine/core";
import { useWorkspace } from "../../app/state";
import { Poster } from "../../components/Cover";
import { Empty } from "../../components/ui";
import { VirtualGrid } from "../../components/VirtualGrid";
import { FilmDetail } from "../films/FilmDetail";
import { movieDetailsToFilm } from "../resources/movieDetailsFilm";
import type { OnlineWorksService } from "../../services/catalog/OnlineWorksService";
import type { WorksDimension } from "../../services/catalog/javbusWorks";
import type { OnlineWork } from "../../services/catalog/onlineWorks";
import { ResourceLookupButton } from "../resources/ResourceSearch";
import { publicMessage } from "../../services/publicMessage";
import { normalizeCode } from "../../services/scraping/identity";
import { onlineWorkChoices } from "./onlineWorkChoices";

const noSubscribe = () => () => {};
const WORK_GAP = 12;
/** 番号与标题两行文字的高度。 */
const WORK_META_HEIGHT = 44;
const workCardHeight = (width: number) => Math.round((width * 2) / 3) + WORK_META_HEIGHT;
export type OnlineWorkScope = "all" | "missing";
const filterKey = (value: string) => value.normalize("NFKC").toLowerCase();

const candidateOf = (work: OnlineWork) => ({
  provider: "JavBus",
  id: work.code,
  code: work.code,
  title: work.title,
});
function summaryFilm(work: OnlineWork) {
  const candidate = candidateOf(work);
  return movieDetailsToFilm(
    {
      ...candidate,
      homepage: work.url,
      coverUrl: work.coverUrl,
      coverCandidates: work.coverCandidates,
      fields: { code: work.code, title: work.title },
    },
    candidate,
  );
}

export function OnlineWorks({
  service,
  dimension,
  name,
  active,
  filter,
  scope,
  localCodes,
  cardWidth,
}: {
  service: OnlineWorksService;
  dimension: WorksDimension;
  name: string;
  active: boolean;
  /** 番号或标题关键词，只过滤已加载的作品。 */
  filter: string;
  scope: OnlineWorkScope;
  /** 本地已收录番号（规范化）；尚未读取时为 null。 */
  localCodes: ReadonlySet<string> | null;
  cardWidth: number;
}) {
  useLocale();
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const { library, libraryState, openFilm, resourceSearch, notice } = useWorkspace();
  const artwork = library.artwork;
  const artworkState = useSyncExternalStore(
    artwork?.subscribe ?? noSubscribe,
    () => artwork?.getSnapshot() ?? null,
  );
  const [detailView, setDetailView] = useState<"info" | "links">("info");
  const [collecting, setCollecting] = useState(false);
  const detailOrigin = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!active) return;
    service.select(dimension, name);
    return () => {
      service.closeDetail();
      service.cancel();
    };
  }, [service, dimension, name, active]);
  useLayoutEffect(() => {
    if (!state.detail && detailOrigin.current) {
      if (detailOrigin.current.isConnected) detailOrigin.current.focus({ preventScroll: true });
      detailOrigin.current = null;
    }
  }, [state.detail]);
  const matches = state.selection?.dimension === dimension && state.selection.name === name;
  const result = matches ? state.result : null;
  const detail = matches ? state.detail : null;
  const choices = onlineWorkChoices(dimension, matches ? state.entities : []);
  const preview = detail
    ? detail.value
      ? movieDetailsToFilm(detail.value, candidateOf(detail.work))
      : summaryFilm(detail.work)
    : null;
  const isLocal = useCallback(
    (work: OnlineWork) => !!localCodes?.has(normalizeCode(work.code)),
    [localCodes],
  );
  const keyword = filterKey(filter.trim());
  // 作品逐页追加，单次过滤至多数千条短文本，不构成长任务。
  const items = useMemo(() => {
    const source = result?.items ?? [];
    if (!keyword && scope === "all") return source;
    return source.filter(
      (work) =>
        (scope === "all" || (!!localCodes && !isLocal(work))) &&
        (!keyword ||
          filterKey(work.code).includes(keyword) ||
          filterKey(work.title).includes(keyword)),
    );
  }, [result, keyword, scope, localCodes, isLocal]);
  const columns = useCallback(
    (width: number) => Math.max(1, Math.floor((width + WORK_GAP) / (cardWidth + WORK_GAP))),
    [cardWidth],
  );
  const openWork = (work: OnlineWork, view: "info" | "links", origin: HTMLElement | null) => {
    detailOrigin.current = origin;
    setDetailView(view);
    service.open(work);
  };
  return (
    <div aria-busy={state.loading}>
      {matches && state.entities.length > 1 && (
        <Select
          label={t(choices.label)}
          description={t(choices.description)}
          mb="md"
          value={state.entity?.id ?? null}
          placeholder={t(choices.placeholder)}
          allowDeselect={false}
          data={localizeOptions(choices.data)}
          onChange={(id) => {
            if (id) service.choose(id);
          }}
        />
      )}
      {matches && state.error && !result?.items.length && (
        <Alert color="red" role="alert" mb="md">
          {t(publicMessage(state.error))}
          <Button size="xs" variant="subtle" onClick={service.retry}>
            {t("重试")}
          </Button>
        </Alert>
      )}
      {state.loading && !result?.items.length && (
        <Group component="output" justify="center" py="md" aria-live="polite">
          <Loader size="sm" />
          <Text size="sm">{state.entity ? t("正在读取作品…") : t("正在查找条目…")}</Text>
        </Group>
      )}
      {scope === "missing" && !localCodes && !!result?.items.length && (
        <Group component="output" justify="center" py="md">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            {t("正在核对本地已收录作品…")}
          </Text>
        </Group>
      )}
      {!!items.length && (
        <VirtualGrid
          count={items.length}
          columns={columns}
          rowHeight={workCardHeight}
          gap={WORK_GAP}
          active={active}
          getKey={(index) => items[index]!.url}
          onEndReached={service.loadMore}
          label={t("在线作品列表")}
          renderItem={(index) => {
            const work = items[index]!;
            const local = localCodes ? isLocal(work) : null;
            return (
              <div className="online-work">
                <UnstyledButton
                  className="online-work-open"
                  disabled={state.loading}
                  aria-label={t(
                    "查看作品 {0}{1}",
                    work.code,
                    local === null ? "" : local ? t("，本地已收录") : t("，本地缺失"),
                  )}
                  onClick={(event) => openWork(work, "info", event.currentTarget)}
                >
                  <span className="online-work-cover">
                    <Poster film={summaryFilm(work)} compact={cardWidth < 200} />
                    {local !== null && (
                      <Badge
                        className="online-work-status"
                        size="xs"
                        radius="sm"
                        variant="filled"
                        color={local ? "teal.7" : "dark.6"}
                      >
                        {local ? t("本地") : t("缺失")}
                      </Badge>
                    )}
                  </span>
                  <Text span size="xs" fw={600} ff="monospace" truncate title={work.code}>
                    {work.code}
                  </Text>
                  <Text span size="xs" c="dimmed" truncate title={work.title}>
                    {work.title}
                  </Text>
                </UnstyledButton>
                {resourceSearch && (
                  <span className="online-work-actions">
                    <ResourceLookupButton
                      compact
                      service={resourceSearch}
                      code={work.code}
                      disabled={state.loading}
                      onStart={() =>
                        openWork(
                          work,
                          "links",
                          document.activeElement instanceof HTMLElement
                            ? document.activeElement
                            : null,
                        )
                      }
                    />
                  </span>
                )}
              </div>
            );
          }}
        />
      )}
      {result && !result.items.length && !state.loading && !state.error && (
        <Empty title={t("暂无在线作品")} description={t("暂未找到该条目的作品。")} />
      )}
      {!!result?.items.length &&
        !items.length &&
        (scope === "all" || !!localCodes) &&
        !state.loading && (
          <Empty
            title={keyword ? t("无匹配作品") : t("已加载的作品均已收录")}
            description={
              result.nextPage === null
                ? t("已加载全部作品。")
                : t("只过滤已加载的作品，可继续加载更多后再查看。")
            }
          >
            {result.nextPage !== null && !state.error && (
              <Button size="xs" variant="subtle" onClick={service.loadMore}>
                {t("加载更多作品")}
              </Button>
            )}
          </Empty>
        )}
      {!result && !state.loading && !state.error && state.entities.length <= 1 && (
        <Empty title={t("尚未读取作品")} description={t("点击重新抓取，获取作品列表。")}>
          <Button size="xs" onClick={service.retry}>
            {t("读取作品")}
          </Button>
        </Empty>
      )}
      {!!result?.items.length && (
        <Group justify="center" py="lg" aria-live="polite">
          {state.loading ? (
            <>
              <Loader size="xs" />
              <Text size="sm" c="dimmed">
                {t("正在加载更多作品…")}
              </Text>
            </>
          ) : state.error ? (
            <Alert color="red" role="alert">
              {t(publicMessage(state.error))}
              <Button size="xs" variant="subtle" onClick={service.retryMore}>
                {t("重试")}
              </Button>
            </Alert>
          ) : result.nextPage === null && items.length ? (
            <Text size="sm" c="dimmed">
              {t("已加载全部作品")}
            </Text>
          ) : null}
        </Group>
      )}
      <FilmDetail
        key={preview?.id}
        film={active ? preview : null}
        preview
        initialView={detailView}
        onClose={service.closeDetail}
        onCollect={
          detail?.value && libraryState.available && libraryState.ready
            ? async () => {
                setCollecting(true);
                try {
                  let warning = "";
                  const saved = await library.collectMetadata(detail.value!, (message) => {
                    warning = message;
                  });
                  service.closeDetail();
                  notice(warning || "资料已保存到片库，可查找资源或关联本地视频。");
                  openFilm(saved);
                } finally {
                  setCollecting(false);
                }
              }
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
          ) : detail?.loading ? (
            <Text size="sm" component="output">
              {t("正在读取完整资料…")}
            </Text>
          ) : detail?.error ? (
            <Alert color="yellow" role="alert">
              {t(publicMessage(detail.error))}
              <Button size="xs" variant="subtle" onClick={() => service.open(detail.work)}>
                {t("重试详情")}
              </Button>
            </Alert>
          ) : undefined
        }
      />
    </div>
  );
}
