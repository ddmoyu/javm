import type { Film } from "../../contracts/media";
import { Empty } from "../../components/ui";
import { useWorkspace } from "../../app/state";
import { ResourceSearchPanel } from "../resources/ResourceSearch";

export function FilmResources({ film, preview = false }: { film: Film; preview?: boolean }) {
  const { resourceSearch, library, notice } = useWorkspace();
  return resourceSearch ? (
    <ResourceSearchPanel
      key={String(film.id) + ":" + film.code}
      service={resourceSearch}
      code={film.code}
      workId={preview ? undefined : String(film.id)}
      documents={preview ? undefined : library.documents}
      notice={notice}
    />
  ) : (
    <Empty icon="link" title="暂无资源链接" description="请在桌面应用中获取资源链接。" />
  );
}
