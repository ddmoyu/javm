import { Loader } from "@mantine/core";
import { Icon } from "./visuals";
import { resourceSources } from "./resourceSearch";
import type { ResourcePacket, SourceId, SourceState } from "./resourceSearch";
const sourceLabels: Record<SourceState, string> = {
  searching: "搜索中",
  ready: "已完成",
  empty: "无结果",
  error: "连接超时",
  stopped: "已停止",
};

export function SearchSourceStatus({
  packet,
  retry,
}: {
  packet: ResourcePacket;
  retry: (source: SourceId) => void;
}) {
  return (
    <div className="resource-source-status" aria-label="搜索来源状态">
      {resourceSources.map((source) => {
        const status = packet.sources[source.id];
        const canRetry = ["error", "stopped", "empty"].includes(status);
        return (
          <button
            type="button"
            key={source.id}
            className={`resource-source-chip source-${status}`}
            disabled={!canRetry}
            title={`${source.type} · ${sourceLabels[status]}${canRetry ? "，点击重试" : ""}`}
            aria-label={`${source.name}：${sourceLabels[status]}${canRetry ? "，重试" : ""}`}
            onClick={() => retry(source.id)}
          >
            {status === "searching" ? (
              <Loader size={11} color="rose" />
            ) : (
              <Icon
                name={
                  status === "error"
                    ? "warning"
                    : status === "ready"
                      ? "check"
                      : status === "stopped"
                        ? "stop"
                        : "search"
                }
                size={12}
              />
            )}
            {source.name}
            <span>{sourceLabels[status]}</span>
            {canRetry && <Icon name="refresh" size={11} />}
          </button>
        );
      })}
    </div>
  );
}
