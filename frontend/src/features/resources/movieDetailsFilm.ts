import type { Film, MediaImage, MediaTrailer } from "../../contracts/media";
import type { MovieCandidate, MovieDetails } from "../../services/metadata/MetaTubeService";

export function movieDetailsToFilm(details: MovieDetails, candidate: MovieCandidate): Film {
  const { fields } = details;
  const provider = details.provider || candidate.provider;
  const artwork: MediaImage[] = [];
  for (const [src, title] of [
    [details.bigThumbUrl, "高清缩略图"],
    [details.thumbUrl, "缩略图"],
    [details.bigCoverUrl, "高清封面"],
    [details.coverUrl, "封面"],
  ] as const) {
    if (src && !artwork.some((image) => image.src === src)) artwork.push({ src, title });
  }
  const trailers: MediaTrailer[] = [];
  if (details.previewVideoUrl)
    trailers.push({
      src: details.previewVideoUrl,
      format: details.previewVideoUrl === details.previewVideoHlsUrl ? "hls" : undefined,
    });
  if (details.previewVideoHlsUrl && details.previewVideoHlsUrl !== details.previewVideoUrl)
    trailers.push({ src: details.previewVideoHlsUrl, format: "hls" });
  return {
    id: `metatube:${provider}:${details.id || candidate.id}`,
    code: fields.code || candidate.code,
    title: fields.title || candidate.title || "未提供标题",
    english: fields.originalTitle ?? "",
    year: Number.parseInt(fields.premiered?.slice(0, 4) ?? "", 10) || 0,
    duration: fields.duration ?? 0,
    rating: fields.rating || undefined,
    genre: fields.genres?.[0] ?? "",
    quality: "",
    size: "",
    favorite: false,
    missing: false,
    coverUrl: artwork[0]?.src,
    artwork,
    trailers,
    screenshots: details.previewImages?.map((src, index) => ({
      src,
      title: `预览图 ${index + 1}`,
    })),
    metadata: {
      originalTitle: fields.originalTitle ?? "",
      plot: fields.plot ?? "",
      premiered: fields.premiered ?? "",
      actors: fields.actors ?? [],
      director: fields.director ?? "",
      studio: fields.studio ?? "",
      label: details.label,
      series: fields.series ?? "",
      genres: fields.genres ?? [],
      tags: fields.tags ?? [],
      resolution: "",
      directory: "",
      fileName: "",
      source: provider,
      sourceId: details.id || candidate.id,
      homepage: details.homepage,
    },
  };
}
