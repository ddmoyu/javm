import { useState } from "react";
import { Button, Group, Paper, SegmentedControl, Stack, Text, ThemeIcon } from "@mantine/core";
import type { Film } from "./data";
import { usePrototype } from "./state";
import { Icon } from "./icons";
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
    <section aria-label="影片资源链接">
      <Group justify="space-between" mb="md">
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
      </Group>
      <Stack gap="xs">
        {resources.map((resource) => {
          const queued = isResourceQueued(resource, tasks, film);
          return (
            <Paper key={resource.id} withBorder radius="md" p="sm" component="article">
              <Group wrap="nowrap" gap="md">
                <ThemeIcon
                  size={40}
                  radius="md"
                  variant="light"
                  color={resource.kind === "online" ? "orchid" : "rouge"}
                >
                  <Icon name={resource.kind === "online" ? "play" : "magnet"} size={19} />
                </ThemeIcon>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" fw={600}>
                    {resource.code} · {resource.quality}
                  </Text>
                  <Text size="xs" c="dimmed" truncate>
                    {resource.kind === "online" ? "在线视频" : "磁力链接"} ·{" "}
                    {resourceSources.find((source) => source.id === resource.sources[0])?.name} ·{" "}
                    {resource.size} GB · {resource.date}
                  </Text>
                </div>
                <Pill>{resource.quality}</Pill>
                <Group gap={6} wrap="nowrap">
                  {resource.kind === "online" && (
                    <Button
                      size="xs"
                      disabled={queued}
                      onClick={() => {
                        setTasks((previous) =>
                          isResourceQueued(resource, previous, film)
                            ? previous
                            : [...previous, resourceDownloadTask(resource, previous, film)],
                        );
                        notice("已加入下载队列");
                      }}
                    >
                      {queued ? "已在队列" : "加入下载"}
                    </Button>
                  )}
                  <Button size="xs" variant="default" onClick={() => void copy(resource.url)}>
                    {resource.kind === "online" ? "复制链接" : "复制磁力"}
                  </Button>
                </Group>
              </Group>
            </Paper>
          );
        })}
      </Stack>
    </section>
  );
}
