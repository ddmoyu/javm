import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Alert,
  Button,
  Group,
  Loader,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useWorkspace } from "../../app/state";
import { Poster } from "../../components/Cover";
import { Empty, Pill } from "../../components/ui";
import { FilmDetail } from "../films/FilmDetail";
import { movieDetailsToFilm } from "../resources/movieDetailsFilm";
import type { AvwikiWorksService } from "../../services/catalog/AvwikiWorksService";
import type { AvwikiDimension } from "../../services/catalog/avwikiCsv";
import type { AvwikiWork } from "../../services/catalog/avwikiWorks";
import { ResourceLookupButton } from "../resources/ResourceSearch";

const candidateOf = (work: AvwikiWork) => ({
  provider: "AVWikiDB",
  id: work.code,
  code: work.code,
  title: work.title,
});
function summaryFilm(work: AvwikiWork) {
  const candidate = candidateOf(work);
  return movieDetailsToFilm(
    {
      ...candidate,
      homepage: work.url,
      coverUrl: work.coverUrl,
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
}: {
  service: AvwikiWorksService;
  dimension: AvwikiDimension;
  name: string;
  active: boolean;
}) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const { library, libraryState, openFilm, resourceSearch, notice } = useWorkspace();
  const [detailView, setDetailView] = useState<"info" | "links">("info");
  const root = useRef<HTMLDivElement>(null);
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
  const page = (value: number) => {
    service.loadPage(value);
    root.current?.scrollIntoView({ block: "start" });
  };
  const preview = detail
    ? detail.value
      ? movieDetailsToFilm(detail.value, candidateOf(detail.work))
      : summaryFilm(detail.work)
    : null;
  return (
    <div ref={root} aria-busy={state.loading}>
      <Group justify="space-between" my="md">
        <Text size="sm" c="dimmed">
          AVWikiDB ·{" "}
          {result?.total === undefined ? "在线作品" : `${result.total.toLocaleString()} 部作品`}
          {result ? ` · 第 ${result.page} 页` : ""}
        </Text>
        <Group gap="xs">
          <Button size="xs" variant="subtle" disabled={state.loading} onClick={service.retry}>
            刷新作品
          </Button>
          {state.loading && (
            <Button size="xs" variant="default" onClick={service.cancel}>
              取消
            </Button>
          )}
        </Group>
      </Group>
      {matches && state.entities.length > 1 && (
        <Select
          label="选择对应的来源条目"
          description="同名条目拥有不同来源编号，选择后查看各自作品。"
          mb="md"
          value={state.entity?.id ?? null}
          placeholder="请选择来源编号"
          allowDeselect={false}
          data={state.entities.map((entity) => ({
            value: entity.id,
            label: `${entity.name} · ${entity.id}`,
          }))}
          onChange={(id) => {
            if (id) service.choose(id);
          }}
        />
      )}
      {matches && state.error && (
        <Alert color="red" role="alert" mb="md">
          {state.error}
          <Button size="xs" variant="subtle" onClick={service.retry}>
            重试
          </Button>
        </Alert>
      )}
      {state.loading && (
        <Group component="output" justify="center" py="md" aria-live="polite">
          <Loader size="sm" />
          <Text size="sm">正在读取作品…</Text>
        </Group>
      )}
      {!!result?.items.length && (
        <SimpleGrid
          component="ul"
          className="facet-grid"
          aria-label="在线作品列表"
          type="container"
          cols={{ base: 2, "600px": 3, "900px": 4, "1200px": 5 }}
          spacing="md"
        >
          {result.items.map((work) => {
            const film = summaryFilm(work);
            return (
              <Paper component="li" key={work.url} withBorder p="sm" radius="md">
                <Stack gap="xs">
                  <UnstyledButton
                    disabled={state.loading}
                    aria-label={`查看作品 ${work.code}`}
                    onClick={(event) => {
                      detailOrigin.current = event.currentTarget;
                      setDetailView("info");
                      service.open(work);
                    }}
                  >
                    <div
                      style={{
                        position: "relative",
                        height: 210,
                        display: "flex",
                        justifyContent: "center",
                        overflow: "hidden",
                      }}
                    >
                      <Poster film={film} />
                    </div>
                    <Text size="xs" c="dimmed" mt="sm" ff="monospace">
                      {work.code}
                    </Text>
                    <Text size="sm" fw={500} lineClamp={2} title={work.title}>
                      {work.title}
                    </Text>
                  </UnstyledButton>
                  <Group justify="space-between" gap="xs">
                    <Pill>在线资料</Pill>
                    {resourceSearch && (
                      <ResourceLookupButton
                        service={resourceSearch}
                        code={work.code}
                        disabled={state.loading}
                        onStart={() => {
                          detailOrigin.current =
                            document.activeElement instanceof HTMLElement
                              ? document.activeElement
                              : null;
                          setDetailView("links");
                          service.open(work);
                        }}
                      />
                    )}
                  </Group>
                </Stack>
              </Paper>
            );
          })}
        </SimpleGrid>
      )}
      {result && !result.items.length && !state.loading && !state.error && (
        <Empty title="暂无在线作品" description="来源尚未收录该条目的作品。" />
      )}
      {!result && !state.loading && !state.error && state.entities.length <= 1 && (
        <Empty title="尚未读取作品" description="点击读取或刷新，获取来源的作品分页。">
          <Button size="xs" onClick={service.retry}>
            读取作品
          </Button>
        </Empty>
      )}
      {result && (
        <Group justify="center" py="lg" aria-label="在线作品分页">
          <Button
            variant="default"
            size="xs"
            disabled={state.loading || result.page <= 1}
            onClick={() => page(result.page - 1)}
          >
            上一页
          </Button>
          <Text size="sm">第 {result.page} 页</Text>
          <Button
            variant="default"
            size="xs"
            disabled={state.loading || result.nextPage === null}
            onClick={() => page(result.nextPage!)}
          >
            下一页
          </Button>
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
                const saved = await library.collectMetadata(detail.value!);
                service.closeDetail();
                notice("资料已保存到片库，可查找资源或关联本地视频。");
                openFilm(saved);
              }
            : undefined
        }
        previewStatus={
          detail?.loading ? (
            <Text size="sm" component="output">
              正在读取完整资料…
            </Text>
          ) : detail?.error ? (
            <Alert color="yellow" role="alert">
              {detail.error}
              <Button size="xs" variant="subtle" onClick={() => service.open(detail.work)}>
                重试详情
              </Button>
            </Alert>
          ) : undefined
        }
      />
    </div>
  );
}
