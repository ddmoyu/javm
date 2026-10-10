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
import { mergeMovieCandidates } from "../../services/metadata/mergeMovieCandidates";
import type { MovieSearchGroup } from "../../services/metadata/mergeMovieCandidates";
import { normalizeCode } from "../../services/streamResolution/sources";

export function MetaTubeSearch({
  initialQuery = "",
  onSelect,
  onApply,
  onCollect,
  allowResourceLookup = false,
}: {
  initialQuery?: string;
  onSelect: (value: MovieDetails, candidate: MovieCandidate, trigger: HTMLButtonElement) => void;
  onApply?: (candidate: MovieCandidate) => Promise<void>;
  onCollect?: (candidate: MovieCandidate) => Promise<void>;
  allowResourceLookup?: boolean;
}) {
  const { metatube } = useWorkspace();
  const state = useSyncExternalStore(metatube.subscribe, metatube.getSnapshot);
  const [query, setQuery] = useState(initialQuery),
    [error, setError] = useState("");
  const [results, setResults] = useState<MovieSearchGroup[]>([]),
    [searched, setSearched] = useState(false);
  const [page, setPage] = useState(1);
  const [opening, setOpening] = useState<MovieSearchGroup | null>(null);
  const [saving, setSaving] = useState<MovieCandidate | null>(null);
  const selecting = useRef(false);
  const searching = useRef(false);
  const revision = useRef(0);
  const cancelled = useRef(false);
  const [merging, setMerging] = useState(false);
  useEffect(
    () => () => {
      revision.current++;
      cancelled.current = true;
      if (selecting.current || searching.current) metatube.cancel();
    },
    [metatube],
  );
  // 只复用本次搜索中看过的详情，不预取全部候选；新搜索或卸载后释放。
  const detailsCache = useRef(new Map<string, MovieDetails>());
  const basicDetails = (candidate: MovieCandidate): MovieDetails => ({
    fields: { code: candidate.code, title: candidate.title },
    provider: candidate.provider,
    id: candidate.id,
    homepage: "",
  });
  const search = async () => {
    if (selecting.current || searching.current || state.querying || state.busy) return;
    searching.current = true;
    cancelled.current = false;
    const current = ++revision.current;
    setError("");
    try {
      let candidates: MovieCandidate[];
      try {
        candidates = await metatube.search(query);
      } catch (reason) {
        if (!allowResourceLookup || cancelled.current) throw reason;
        // 精确番号仍可进入详情获取链接，不强依赖资料服务成功。
        let code: string;
        try {
          code = normalizeCode(query);
        } catch {
          throw reason;
        }
        candidates = [{ provider: "", id: `code:${code}`, code, title: code }];
        if (current === revision.current) setError("影片资料暂不可用，可打开详情获取资源链接。");
      }
      if (!candidates.length && allowResourceLookup) {
        try {
          const code = normalizeCode(query);
          candidates = [{ provider: "", id: `code:${code}`, code, title: code }];
        } catch {
          /* 片名没有结果时不猜测番号。 */
        }
      }
      if (current !== revision.current || cancelled.current) return;
      setMerging(true);
      const result = await mergeMovieCandidates(candidates);
      if (current !== revision.current || cancelled.current) return;
      detailsCache.current.clear();
      setResults(result);
      setPage(1);
      setSearched(true);
    } catch (reason) {
      if (current === revision.current)
        setError(cancelled.current ? "已取消搜索。" : serviceError(reason));
    } finally {
      searching.current = false;
      if (current === revision.current) setMerging(false);
    }
  };
  const select = async (group: MovieSearchGroup, trigger: HTMLButtonElement) => {
    if (selecting.current || searching.current || state.querying || state.busy) return;
    selecting.current = true;
    cancelled.current = false;
    const current = revision.current;
    setError("");
    setOpening(group);
    try {
      let last: unknown;
      for (const candidate of group.candidates.slice(0, 8)) {
        if (cancelled.current || current !== revision.current) return;
        try {
          const key = JSON.stringify([candidate.provider, candidate.id]);
          let result = detailsCache.current.get(key);
          if (!result) {
            result = candidate.provider
              ? await metatube.details(candidate)
              : basicDetails(candidate);
            if (detailsCache.current.size >= 50)
              detailsCache.current.delete(detailsCache.current.keys().next().value!);
            detailsCache.current.set(key, result);
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
          last = reason;
        }
      }
      if (cancelled.current || current !== revision.current) return;
      if (
        allowResourceLookup &&
        group.candidate.code &&
        trigger.isConnected &&
        trigger.getClientRects().length
      ) {
        onSelect(basicDetails(group.candidate), group.candidate, trigger);
        setError("完整资料暂不可用，仍可在详情中获取资源链接。");
      } else throw last;
    } catch (reason) {
      if (current === revision.current)
        setError(cancelled.current ? "已取消。" : serviceError(reason));
    } finally {
      selecting.current = false;
      if (current === revision.current) setOpening(null);
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
              if (!state.querying && !state.busy && query.trim()) void search();
            }
          }}
          style={{ flex: 1 }}
          disabled={state.querying || merging}
        />
        <Button
          loading={(state.querying && !opening) || merging}
          aria-busy={(state.querying && !opening) || merging}
          disabled={state.querying || merging || !query.trim() || state.busy}
          onClick={() => void search()}
        >
          搜索
        </Button>
        {(state.querying || merging) && (
          <Button
            variant="default"
            onClick={() => {
              cancelled.current = true;
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
      {(state.querying || merging) && (
        <Text size="sm" component="output" aria-live="polite">
          {state.status === "starting"
            ? "正在准备资料服务…"
            : opening
              ? "正在获取影片详情…"
              : "正在搜索并合并相同结果…"}
        </Text>
      )}
      {!state.querying && !merging && searched && !results.length && (
        <Text size="sm">没有找到匹配结果，可修改番号或片名后重试。</Text>
      )}
      {searched && !!results.length && (
        <Text size="xs" c="dimmed">
          {results.length} 部影片
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
              aria-disabled={state.querying || state.busy || merging}
              aria-busy={opening === group}
              data-loading={opening === group || undefined}
              onClick={(event) => void select(group, event.currentTarget)}
            >
              <span style={{ minWidth: 0, flex: 1 }}>
                <Text span display="block" size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>
                  {item.code || "未提供番号"} · {item.title || "未提供标题"}
                </Text>
              </span>
              {opening === group && (
                <Loader size="sm" aria-hidden="true" style={{ flexShrink: 0 }} />
              )}
            </UnstyledButton>
            {(onApply || onCollect) && item.provider && (
              <Button
                size="compact-xs"
                variant="light"
                disabled={state.querying || state.busy || merging || saving !== null}
                loading={saving === item}
                onClick={() => {
                  if (saving) return;
                  setSaving(item);
                  void (onApply ?? onCollect)!(item)
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
          disabled={state.querying}
        />
      )}
    </Stack>
  );
}
