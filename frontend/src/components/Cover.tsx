import type { Film } from "../contracts/media";
import { Icon } from "./icons";
import { SourceImage } from "./ImageSources";

export function Poster({
  film,
  compact = false,
  natural = false,
}: {
  film: Film;
  compact?: boolean;
  natural?: boolean;
}) {
  return (
    <SourceImage
      className="poster-fill"
      data-natural={natural || undefined}
      candidates={[film.coverUrl, ...(film.artwork ?? []).map((image) => image.src)]}
      referer={film.metadata?.homepage}
      placeholder={(loading) => (
        <span className="poster-empty" data-natural={natural || undefined}>
          <Icon name="image" size={compact ? 18 : 34} />
          {!compact && (
            <span>{loading ? "封面加载中…" : film.coverUrl ? "封面暂不可用" : "暂无封面"}</span>
          )}
        </span>
      )}
      alt={`${film.title} 封面`}
      fit="contain"
      w={natural ? "auto" : "100%"}
      h={natural ? "auto" : "100%"}
    />
  );
}
