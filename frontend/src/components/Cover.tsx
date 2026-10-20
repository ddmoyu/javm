import { t, useLocale } from "../i18n/index";
import type { Film } from "../contracts/media";
import { Icon } from "./icons";
import { SourceImage } from "./ImageSources";

export function Poster({ film, compact = false }: { film: Film; compact?: boolean }) {
  useLocale();
  return (
    <SourceImage
      className="poster-fill"
      candidates={[film.coverUrl, ...(film.artwork ?? []).map((image) => image.src)]}
      referer={film.metadata?.homepage}
      placeholder={(loading) => (
        <span className="poster-empty">
          <Icon name="image" size={compact ? 18 : 34} />
          {!compact && (
            <span>
              {loading ? t("封面加载中…") : film.coverUrl ? t("封面暂不可用") : t("暂无封面")}
            </span>
          )}
        </span>
      )}
      alt={t("{0} 封面", film.title)}
      fit="contain"
      w="100%"
      h="100%"
    />
  );
}
