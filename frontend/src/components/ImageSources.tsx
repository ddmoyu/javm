import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Image } from "@mantine/core";
import type { ElementProps, ImageProps } from "@mantine/core";
import { ImageSourceService, imageCandidates } from "../services/images/ImageSourceService";
import type { ResolvedImage } from "../services/images/ImageSourceService";

const ImageSourcesContext = createContext(new ImageSourceService());
export const ImageSourcesProvider = ImageSourcesContext.Provider;
export const useImageSources = () => useContext(ImageSourcesContext);

interface Props
  extends
    Omit<ImageProps, "src" | "fallbackSrc" | "onError">,
    ElementProps<"img", "src" | "onError" | keyof ImageProps> {
  candidates: (string | undefined)[];
  referer?: string;
  placeholder: (loading: boolean) => ReactNode;
}
export function SourceImage({ candidates, ...props }: Props) {
  const urls = imageCandidates(candidates);
  // 换作品或来源页时同步重置，迟到结果不能覆盖新图片。
  return <CandidateImage key={JSON.stringify([urls, props.referer])} urls={urls} {...props} />;
}
function CandidateImage({
  urls,
  referer,
  placeholder,
  ...props
}: Omit<Props, "candidates"> & { urls: string[] }) {
  const service = useImageSources();
  const anchor = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [resolved, setResolved] = useState<ResolvedImage>();
  const [rejected, setRejected] = useState<string[]>([]);
  const [loading, setLoading] = useState(!!urls.length);
  const key = JSON.stringify(urls.filter((url) => !rejected.includes(url)));
  useEffect(() => {
    const element = anchor.current?.parentElement;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const abort = new AbortController();
    const remaining = JSON.parse(key) as string[];
    void service
      .resolve(remaining, referer, abort.signal)
      .then((image) => {
        if (!abort.signal.aborted) {
          setResolved(image);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [service, visible, key, referer]);
  return (
    <span ref={anchor} style={{ display: "contents" }}>
      {resolved ? (
        <Image
          {...props}
          data-private-image
          src={resolved.src}
          loading="lazy"
          decoding="async"
          onError={() => {
            const source = resolved.source;
            setResolved(undefined);
            setLoading(true);
            // 浏览器最终解码失败时也剔除坏缓存，再尝试下一张，而不是显示裂图。
            void service.invalidate(source, referer).catch(() => {});
            setRejected((current) => [...current, source]);
          }}
        />
      ) : (
        placeholder(loading)
      )}
    </span>
  );
}
