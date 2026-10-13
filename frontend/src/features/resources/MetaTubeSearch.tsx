import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Alert,
  Button,
  Group,
  Loader,
  Pagination,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { useWorkspace } from "../../app/state";
import type { MovieCandidate, MovieDetails } from "../../services/metadata/MetaTubeService";
import { serviceError } from "../../services/metadata/shared";
import type { MovieSearchGroup } from "../../services/metadata/mergeMovieCandidates";
import { normalizeCode } from "../../services/streamResolution/sources";
import { requireMovieDetails, searchMovieMetadata } from "../../services/metadata/movieSearch";
import { StopUnconfirmedError } from "../../services/downloads/ports";

/**
 * 每条搜索结果单独显示，不再按番号合并不同来源；只去掉同一来源、同一编号的完全重复项。
 */
function separateCandidates(rows: readonly MovieCandidate[]): MovieSearchGroup[] {
  const seen = new Set<string>();
  const groups: MovieSearchGroup[] = [];
  for (const candidate of rows) {
    const key = JSON.stringify([candidate.provider, candidate.id]);
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push({ key, candidate, candidates: [candidate] });
  }
  return groups;
}

export function MetaTubeSearch({
  initialQuery = "",
  onSelect,
  onApply,
  onCollect,
  onLookupResources,
  allowResourceLookup = false,
}: {
  initialQuery?: string;
  onSelect: (value: MovieDetails, candidate: MovieCandidate, trigger: HTMLButtonElement) => void;
  onApply?: (candidate: MovieCandidate) => Promise<void>;
  onCollect?: (candidate: MovieCandidate, details?: MovieDetails) => Promise<void>;
  onLookupResources?: (code: string, trigger: HTMLButtonElement) => void;
  allowResourceLookup?: boolean;
}) {
  const { metatube, notice } = useWorkspace();
  const state = useSyncExternalStore(metatube.subscribe, metatube.getSnapshot);
  const [query, setQuery] = useState(initialQuery),
    [error, setError] = useState("");
  const [results, setResults] = useState<MovieSearchGroup[]>([]),
    [searched, setSearched] = useState(false);
  const [page, setPage] = useState(1);
  const [opening, setOpening] = useState<MovieSearchGroup | null>(null);
  const [saving, setSaving] = useState<MovieCandidate | null>(null);
  const [pending, setPending] = useState(false);
  const [resourceCode, setResourceCode] = useState<string>();
  const operation = useRef<AbortController | null>(null);
  const selecting = useRef(false);
  const searching = useRef(false);
  const revision = useRef(0);
  const cancelled = useRef(false);
  useEffect(
    () => () => {
      revision.current++;
      cancelled.current = true;
      operation.current?.abort();
      if (selecting.current || searching.current) metatube.cancel();
    },
    [metatube],
  );
  // 只复用本次搜索中看过的详情，不预取全部候选；新搜索或卸载后释放。
  const detailsCache = useRef(new Map<string, MovieDetails>());
  const candidateKey = (candidate: MovieCandidate) =>
    JSON.stringify([candidate.provider, candidate.id]);
  const remember = (candidate: MovieCandidate, details: MovieDetails) => {
    if (detailsCache.current.size >= 50)
      detailsCache.current.delete(detailsCache.current.keys().next().value!);
    detailsCache.current.set(candidateKey(candidate), details);
  };
  const search = async () => {
    if (selecting.current || searching.current || state.querying || state.busy) return;
    searching.current = true;
    setPending(true);
    cancelled.current = false;
    const abort = new AbortController();
    operation.current = abort;
    const current = ++revision.current;
    setError("");
    setResourceCode(undefined);
    setResults([]);
    setSearched(false);
    detailsCache.current.clear();
    try {
      const found = await searchMovieMetadata(
        {
          search: (value) => metatube.search(value, abort.signal),
        },
        query,
        abort.signal,
        allowResourceLookup,
      );
      if (current !== revision.current || cancelled.current) return;
      const result = separateCandidates(found.candidates);
      if (found.details) remember(found.candidates[0]!, found.details);
      setError(found.error);
      setResourceCode(found.resourceCode);
      setResults(result);
      setPage(1);
      setSearched(true);
    } catch (reason) {
      if (current === revision.current) {
        if (cancelled.current && !(reason instanceof StopUnconfirmedError)) notice("已取消搜索。");
        else setError(serviceError(reason));
      }
    } finally {
      searching.current = false;
      if (current === revision.current) {
        operation.current = null;
        setPending(false);
      }
    }
  };
  const select = async (group: MovieSearchGroup, trigger: HTMLButtonElement) => {
    if (selecting.current || searching.current || state.querying || state.busy) return;
    selecting.current = true;
    setPending(true);
    cancelled.current = false;
    const abort = new AbortController();
    operation.current = abort;
    const current = revision.current;
    setError("");
    setResourceCode(undefined);
    setOpening(group);
    try {
      let last: unknown;
      for (const candidate of group.candidates.slice(0, 8)) {
        if (cancelled.current || current !== revision.current) return;
        try {
          const key = candidateKey(candidate);
          let result = detailsCache.current.get(key);
          if (!result) {
            result = requireMovieDetails(
              await metatube.details(candidate, abort.signal),
              candidate,
            );
            remember(candidate, result);
          }
          if (
            !cancelled.current &&
            current === revision.current &&
            trigger.isConnected &&
            trigger.getClientRects().length
          )
            onSelect(result, candidate, trigger);
          return;
        } catch (reason) {
          if (reason instanceof StopUnconfirmedError) throw reason;
          last = reason;
        }
      }
      if (cancelled.current || current !== revision.current) return;
      let code: string | undefined;
      try {
        code = normalizeCode(group.candidate.code);
      } catch {
        /* 无番号时不猜测。 */
      }
      if (cancelled.current || current !== revision.current) return;
      setResourceCode(allowResourceLookup ? code : undefined);
      throw last ?? new Error("尚未取得影片详情，请重试。");
    } catch (reason) {
      if (current === revision.current) {
        if (cancelled.current && !(reason instanceof StopUnconfirmedError))
          notice("已取消获取详情。");
        else setError(serviceError(reason));
      }
    } finally {
      selecting.current = false;
      if (current === revision.current) {
        operation.current = null;
        setOpening(null);
        setPending(false);
      }
    }
  };
  return (
    <Stack gap="md">
      <Group align="flex-start" wrap="nowrap">
        <TextInput
          aria-label="搜索番号或片名"
          placeholder="输入番号或片名"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (!pending && !state.querying && !state.busy && query.trim()) void search();
            }
          }}
          style={{ flex: 1 }}
          disabled={pending || state.querying}
        />
        <Button
          loading={(pending || state.querying) && !opening}
          aria-busy={(pending || state.querying) && !opening}
          disabled={pending || state.querying || !query.trim() || state.busy}
          onClick={() => void search()}
        >
          搜索
        </Button>
        {(pending || state.querying) && (
          <Button
            variant="default"
            onClick={() => {
              cancelled.current = true;
              operation.current?.abort();
              metatube.cancel();
            }}
          >
            取消
          </Button>
        )}
      </Group>
      {error && (
        <Alert color="red" role="alert">
          {error}
        </Alert>
      )}
      {(pending || state.querying) && (
        <Text size="sm" component="output" aria-live="polite">
          {state.status === "starting"
            ? "正在准备资料服务…"
            : opening
              ? "正在获取影片详情…"
              : "正在搜索…"}
        </Text>
      )}
      {/* 出错时只显示上方的错误提示，不再重复一行说明。 */}
      {!pending && !state.querying && searched && !results.length && !error && (
        <Text size="sm">没有找到匹配结果。</Text>
      )}
      {!pending && resourceCode && onLookupResources && (
        <Group>
          <Text size="sm" c="dimmed">
            尚未取得影片资料，可仅按番号查找资源链接。
          </Text>
          <Button
            variant="default"
            size="xs"
            onClick={(event) => onLookupResources(resourceCode, event.currentTarget)}
          >
            按番号查找资源
          </Button>
        </Group>
      )}
      {searched && !!results.length && (
        <Text size="xs" c="dimmed">
          {results.length} 条结果
        </Text>
      )}
      {results.slice((page - 1) * 10, page * 10).map((group) => {
        const item = group.candidate;
        return (
          <Group key={group.key} wrap="nowrap" gap="xs">
            <UnstyledButton
              style={{ flex: 1, minWidth: 0 }}
              type="button"
              className="metadata-result"
              aria-label={`打开详情 ${item.code || "未提供番号"} ${item.title || "未提供标题"}`}
              aria-disabled={pending || state.querying || state.busy}
              aria-busy={opening === group}
              data-loading={opening === group || undefined}
              onClick={(event) => void select(group, event.currentTarget)}
            >
              <span style={{ minWidth: 0, flex: 1 }}>
                <Text span display="block" size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>
                  {item.code || "未提供番号"} · {item.title || "未提供标题"}
                </Text>
                {item.provider && (
                  <Text span display="block" size="xs" c="dimmed">
                    {item.provider}
                  </Text>
                )}
              </span>
              {opening === group && (
                <Loader size="sm" aria-hidden="true" style={{ flexShrink: 0 }} />
              )}
            </UnstyledButton>
            {(onApply || onCollect) && item.provider && (
              <Button
                size="compact-xs"
                variant="light"
                disabled={pending || state.querying || state.busy || saving !== null}
                loading={saving === item}
                onClick={() => {
                  if (saving) return;
                  setSaving(item);
                  void (
                    onApply
                      ? onApply(item)
                      : onCollect!(item, detailsCache.current.get(candidateKey(item)))
                  )
                    .catch((reason: unknown) => setError(serviceError(reason)))
                    .finally(() => setSaving(null));
                }}
              >
                {onApply ? "采用并刮削" : "收藏并保存资料"}
              </Button>
            )}
          </Group>
        );
      })}
      {results.length > 10 && (
        <Pagination
          total={Math.ceil(results.length / 10)}
          value={page}
          onChange={setPage}
          disabled={pending || state.querying}
        />
      )}
    </Stack>
  );
}
