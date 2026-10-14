import type { Film } from "../../contracts/media";
import { useState } from "react";
import { SegmentedControl, Stack } from "@mantine/core";
import { Empty } from "../../components/ui";
import { useWorkspace } from "../../app/state";
import { ResourceSearchPanel } from "../resources/ResourceSearch";
import { MagnetSearchPanel } from "../resources/MagnetSearch";

export function FilmResources({ film, preview = false }: { film: Film; preview?: boolean }) {
  const { resourceSearch, library, notice } = useWorkspace();
  const [kind, setKind] = useState("video");
  return resourceSearch ? (
    <Stack gap="md">
      {resourceSearch.magnets && (
        <SegmentedControl
          aria-label="资源类型"
          value={kind}
          onChange={setKind}
          data={[
            { value: "video", label: "在线视频" },
            { value: "magnet", label: "磁力资源" },
          ]}
        />
      )}
      {kind === "magnet" && resourceSearch.magnets ? (
        <MagnetSearchPanel
          service={resourceSearch.magnets}
          query={film.code || film.title}
          notice={notice}
        />
      ) : (
        <ResourceSearchPanel
          key={String(film.id) + ":" + film.code}
          service={resourceSearch}
          code={film.code}
          workId={preview ? undefined : String(film.id)}
          documents={preview ? undefined : library.documents}
          notice={notice}
        />
      )}
    </Stack>
  ) : (
    <Empty icon="link" title="暂无资源链接" description="请在桌面应用中获取资源链接。" />
  );
}
