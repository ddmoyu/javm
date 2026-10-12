import type { MediaTrailer } from "../../contracts/media";

export function movieTrailers(details: {
  previewVideoUrl?: string;
  previewVideoHlsUrl?: string;
}): MediaTrailer[] {
  const src = details.previewVideoUrl || details.previewVideoHlsUrl;
  return src ? [{ src, format: src === details.previewVideoHlsUrl ? "hls" : undefined }] : [];
}
