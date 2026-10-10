import { useRef, useState, useSyncExternalStore } from "react";
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

export function MetaTubeSearch({
  initialQuery = "",
  onSelect,
  onApply,
  onCollect,
}: {
  initialQuery?: string;
  onSelect: (value: MovieDetails, candidate: MovieCandidate, trigger: HTMLButtonElement) => void;
  onApply?: (candidate: MovieCandidate) => Promise<void>;
  onCollect?: (candidate: MovieCandidate) => Promise<void>;
}) {
  const { metatube } = useWorkspace();
  const state = useSyncExternalStore(metatube.subscribe, metatube.getSnapshot);
  const [query, setQuery] = useState(initialQuery),
    [error, setError] = useState("");
  const [results, setResults] = useState<MovieCandidate[]>([]),
    [searched, setSearched] = useState(false);
  const [page, setPage] = useState(1);
  const [opening, setOpening] = useState<MovieCandidate | null>(null);
  const [saving, setSaving] = useState<MovieCandidate | null>(null);
  const selecting = useRef(false);
  // 只复用本次搜索中看过的详情，不预取全部候选；新搜索或卸载后释放。
  const detailsCache = useRef(new Map<string, MovieDetails>());
  const search = async () => {
    if (selecting.current || state.querying || state.busy) return;
    setError("");
    try {
      const result = await metatube.search(query);
      detailsCache.current.clear();
      setResults(result);
      setPage(1);
      setSearched(true);
    } catch (reason) {
      setError(serviceError(reason));
    }
  };
  const select = async (candidate: MovieCandidate, trigger: HTMLButtonElement) => {
    if (selecting.current || state.querying || state.busy) return;
    selecting.current = true;
    setError("");
    try {
      const key = JSON.stringify([candidate.provider, candidate.id]);
      let result = detailsCache.current.get(key);
      if (!result) {
        setOpening(candidate);
        result = await metatube.details(candidate);
        if (detailsCache.current.size >= 50)
          detailsCache.current.delete(detailsCache.current.keys().next().value!);
        detailsCache.current.set(key, result);
      }
      if (trigger.isConnected && trigger.getClientRects().length)
        onSelect(result, candidate, trigger);
    } catch (reason) {
      setError(serviceError(reason));
    } finally {
      selecting.current = false;
      setOpening(null);
    }
  };
  return (
    <Stack gap="md">
      <Group align="flex-start" wrap="nowrap">
        <TextInput
          aria-label="MetaTube 搜索关键词"
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
          disabled={state.querying}
        />
        <Button
          loading={state.querying && !opening}
          aria-busy={state.querying && !opening}
          disabled={state.querying || !query.trim() || state.busy}
          onClick={() => void search()}
        >
          搜索
        </Button>
        {state.querying && (
          <Button variant="default" onClick={metatube.cancel}>
            取消
          </Button>
        )}
      </Group>
      {error && (
        <Alert color="red" role="alert">
          {error}
        </Alert>
      )}
      {state.querying && (
        <Text size="sm" component="output" aria-live="polite">
          {state.status === "starting"
            ? "正在准备资料服务…"
            : opening
              ? `正在从 ${opening.provider} 获取完整资料…`
              : "正在查询 MetaTube…"}
        </Text>
      )}
      {!state.querying && searched && !results.length && (
        <Text size="sm">没有找到匹配资料，可修改关键词或来源后重试。</Text>
      )}
      {results.slice((page - 1) * 10, page * 10).map((item, index) => (
        <Group key={`${item.provider}:${item.id}:${index}`} wrap="nowrap" gap="xs">
          <UnstyledButton
            style={{ flex: 1, minWidth: 0 }}
            type="button"
            className="metadata-result"
            aria-label={`打开详情 ${item.code || "未提供番号"} ${item.title || "未提供标题"} · ${item.provider}`}
            aria-disabled={state.querying || state.busy}
            aria-busy={opening === item}
            data-loading={opening === item || undefined}
            onClick={(event) => void select(item, event.currentTarget)}
          >
            <span style={{ minWidth: 0, flex: 1 }}>
              <Text span display="block" size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>
                {item.code || "未提供番号"} · {item.title || "未提供标题"}
              </Text>
              <Text span display="block" size="xs" c="dimmed">
                {item.provider}
              </Text>
            </span>
            {opening === item && <Loader size="sm" aria-hidden="true" style={{ flexShrink: 0 }} />}
          </UnstyledButton>
          {(onApply || onCollect) && (
            <Button
              size="compact-xs"
              variant="light"
              disabled={state.querying || state.busy || saving !== null}
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
      ))}
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
