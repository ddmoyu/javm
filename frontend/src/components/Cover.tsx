import { Image } from "@mantine/core";
import type { Film } from "../contracts/media";
import { Icon } from "./icons";

export function Poster({
  film,
  compact = false,
  natural = false,
}: {
  film: Film;
  compact?: boolean;
  natural?: boolean;
}) {
  if (!film.coverUrl)
    return (
      <span className="poster-empty" data-natural={natural || undefined}>
        <Icon name="image" size={compact ? 18 : 34} />
        {!compact && <span>暂无封面</span>}
      </span>
    );
  return (
    <Image
      className="poster-fill"
      data-natural={natural || undefined}
      src={film.coverUrl}
      loading="lazy"
      decoding="async"
      alt={`${film.title} 封面`}
      fit="contain"
      w={natural ? "auto" : "100%"}
      h={natural ? "auto" : "100%"}
    />
  );
}
