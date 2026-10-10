import { useState } from "react";
import { Button, Group, SegmentedControl } from "@mantine/core";
import type { Film } from "../../contracts/media";
import { Icon } from "../../components/icons";
import { Empty } from "../../components/ui";

export function FilmResources({ film, onSearch }: { film: Film; onSearch: () => void }) {
  const [sort, setSort] = useState("recommended");
  return (
    <section aria-label={`${film.code} 资源链接`}>
      <Group justify="space-between" mb="md">
        <SegmentedControl
          size="xs"
          aria-label="资源排序"
          value={sort}
          onChange={setSort}
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
          查找资源
        </Button>
      </Group>
      <Empty icon="link" title="暂无资源链接" description="查找并整理这部影片的资源链接。" />
    </section>
  );
}
