import { useState } from "react";
import { Button, SegmentedControl } from "@mantine/core";
import type { Film } from "./data";
import { usePrototype } from "./state";
import { Icon } from "./visuals";
import { Pill } from "./ui";
import {
  isResourceQueued,
  resourceDownloadTask,
  resourceSources,
  sampleResourceResults,
  sortResourceResults,
} from "./resourceSearch";
import type { ResourceSort } from "./resourceSearch";

export function FilmResources({ film, onSearch }: { film: Film; onSearch: () => void }) {
  const { tasks, setTasks, notice } = usePrototype();
  const [sort, setSort] = useState<ResourceSort>("recommended");
  const resources = sortResourceResults(
    sampleResourceResults(film.code).filter((_, index) => [0, 4, 6].includes(index)),
    sort,
  );
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notice("资源链接已复制");
    } catch {
      notice("复制失败，请重试");
    }
  };
  return (
    <section className="film-detail-resources" aria-label="影片资源链接">
      <div className="film-detail-section-head">
        <SegmentedControl
          aria-label="资源排序"
          size="xs"
          value={sort}
          onChange={(value) => setSort(value as ResourceSort)}
          data={[
            { value: "recommended", label: "推荐" },
            { value: "size", label: "体积" },
            { value: "date", label: "日期" },
          ]}
        />
        <Button
          size="xs"
          variant="default"
          leftSection={<Icon name="search" size={15} />}
          onClick={onSearch}
        >
          查找更多资源
        </Button>
      </div>
      <div className="film-resource-list">
        {resources.map((resource) => (
          <article className="film-resource-row" key={resource.id}>
            <span className="film-resource-icon">
              <Icon name={resource.kind === "online" ? "play" : "link"} size={20} />
            </span>
            <div className="film-resource-info">
              <strong>
                {resource.code} · {resource.quality}
              </strong>
              <span>
                {resource.kind === "online" ? "在线视频" : "磁力链接"} ·{" "}
                {resourceSources.find((source) => source.id === resource.sources[0])?.name} ·{" "}
                {resource.size} GB · {resource.date}
              </span>
            </div>
            <Pill>{resource.quality}</Pill>
            <div className="film-resource-buttons">
              {resource.kind === "online" && (
                <Button
                  size="xs"
                  disabled={isResourceQueued(resource, tasks, film)}
                  onClick={() => {
                    setTasks((previous) =>
                      isResourceQueued(resource, previous, film)
                        ? previous
                        : [...previous, resourceDownloadTask(resource, previous, film)],
                    );
                    notice("已加入下载队列");
                  }}
                >
                  {isResourceQueued(resource, tasks, film) ? "已在队列" : "加入下载"}
                </Button>
              )}
              <Button size="xs" variant="default" onClick={() => void copy(resource.url)}>
                {resource.kind === "online" ? "复制链接" : "复制磁力"}
              </Button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
