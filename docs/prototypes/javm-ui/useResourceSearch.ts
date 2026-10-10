import { useEffect, useRef, useState } from "react";
import type { Film } from "./data";
import {
  createResourcePacket,
  matchResourceQuery,
  mergeResourceResults,
  resourcePageSize,
  resourceSources,
  sampleResourceResults,
} from "./resourceSearch";
import type { ResourceMatch, ResourcePacket, SourceId, SourceState } from "./resourceSearch";

interface SearchSession {
  query: string;
  matches: ResourceMatch[];
  packets: Record<string, ResourcePacket>;
}

function resolveSource(match: ResourceMatch, source: SourceId, retry: boolean) {
  const failed =
    !retry &&
    ((source === "magnet-b" && match.code === "JVM-010") ||
      (source === "metadata" && match.code === "JVM-009"));
  const resources =
    source === "metadata" || failed
      ? []
      : sampleResourceResults(match.code)
          .filter((item) => item.sources.includes(source))
          .map((item) => ({ ...item, sources: [source] }));
  const status: SourceState = failed
    ? "error"
    : (source === "metadata" ? !!match.film : !!resources.length)
      ? "ready"
      : "empty";
  return { status, resources };
}

// 每页预取资源，返回结果直接复用缓存。所有来源与时序仍为本地示例。
export function useResourceSearch(films: Film[]) {
  const [session, setSession] = useState<SearchSession>(() => {
    const matches = matchResourceQuery("JVM", films);
    return {
      query: "JVM",
      matches,
      packets: Object.fromEntries(
        matches.slice(0, resourcePageSize).map((match) => [
          match.code,
          {
            sources: createResourcePacket("ready").sources,
            resources: sampleResourceResults(match.code),
          },
        ]),
      ),
    };
  });
  const generation = useRef(0);
  const timers = useRef<number[]>([]);
  const loaded = useRef(
    new Set(session.matches.slice(0, resourcePageSize).map((match) => match.code)),
  );
  const clearTimers = () => {
    timers.current.forEach(window.clearTimeout);
    timers.current = [];
  };
  useEffect(
    () => () => {
      generation.current += 1;
      timers.current.forEach(window.clearTimeout);
    },
    [],
  );

  const deliver = (matches: ResourceMatch[], source: SourceId, revision: number, retry = false) => {
    if (revision !== generation.current) return;
    setSession((current) => {
      const packets = { ...current.packets };
      for (const match of matches) {
        const previous = packets[match.code];
        if (!previous) continue;
        const result = resolveSource(match, source, retry);
        packets[match.code] = {
          sources: { ...previous.sources, [source]: result.status },
          resources: mergeResourceResults(previous.resources, result.resources),
        };
      }
      return { ...current, packets };
    });
  };
  const ensure = (matches: ResourceMatch[]) => {
    const missing = matches.filter((match) => !loaded.current.has(match.code));
    if (!missing.length) return;
    missing.forEach((match) => loaded.current.add(match.code));
    const revision = generation.current;
    setSession((current) => ({
      ...current,
      packets: {
        ...current.packets,
        ...Object.fromEntries(missing.map((match) => [match.code, createResourcePacket()])),
      },
    }));
    resourceSources.forEach((source, index) => {
      timers.current.push(
        window.setTimeout(() => deliver(missing, source.id, revision), 350 + index * 350),
      );
    });
  };
  const start = (query: string) => {
    clearTimers();
    generation.current += 1;
    loaded.current = new Set();
    const matches = matchResourceQuery(query, films);
    setSession({ query: query.trim(), matches, packets: {} });
    ensure(matches.slice(0, resourcePageSize));
    return matches;
  };
  const stop = () => {
    clearTimers();
    generation.current += 1;
    setSession((current) => ({
      ...current,
      packets: Object.fromEntries(
        Object.entries(current.packets).map(([code, packet]) => [
          code,
          {
            ...packet,
            sources: Object.fromEntries(
              Object.entries(packet.sources).map(([source, status]) => [
                source,
                status === "searching" ? "stopped" : status,
              ]),
            ) as ResourcePacket["sources"],
          },
        ]),
      ),
    }));
  };
  const retry = (code: string, source: SourceId) => {
    const match = session.matches.find((item) => item.code === code);
    if (!match) return;
    const revision = generation.current;
    setSession((current) => {
      const packet = current.packets[code] ?? createResourcePacket("stopped");
      return {
        ...current,
        packets: {
          ...current.packets,
          [code]: { ...packet, sources: { ...packet.sources, [source]: "searching" } },
        },
      };
    });
    timers.current.push(window.setTimeout(() => deliver([match], source, revision, true), 650));
  };
  return {
    session,
    start,
    ensure,
    stop,
    retry,
    searching: Object.values(session.packets).some((packet) =>
      Object.values(packet.sources).includes("searching"),
    ),
  };
}
