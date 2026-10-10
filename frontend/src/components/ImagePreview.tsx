import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Fancybox } from "@fancyapps/ui/dist/fancybox/";
import { zh_CN } from "@fancyapps/ui/dist/fancybox/l10n/zh_CN.js";
import "@fancyapps/ui/dist/fancybox/fancybox.css";
import type { MediaImage } from "../contracts/media";
import { bindImagePreviewFullscreen } from "../platform/neutralino/imagePreviewFullscreen";

interface Gallery {
  images: MediaImage[];
  index: number;
  trigger: HTMLElement | undefined;
}
const PreviewContext = createContext<{
  opened: boolean;
  open: (images: MediaImage[], index?: number) => void;
} | null>(null);

// Fancybox 的 caption 是 HTML；影片标题始终按纯文本显示。
export function escapeCaption(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}

export function ImagePreviewProvider({ children }: { children: ReactNode }) {
  const [gallery, setGallery] = useState<Gallery | null>(null);
  const returnTarget = useRef<HTMLElement | undefined>(undefined);
  const value = useMemo(
    () => ({
      opened: gallery !== null,
      open: (images: MediaImage[], index = 0) => {
        if (!images.length) return;
        const trigger =
          document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
        returnTarget.current = trigger;
        setGallery({
          images,
          index: Math.max(0, Math.min(index, images.length - 1)),
          trigger,
        });
      },
    }),
    [gallery],
  );
  useEffect(() => {
    if (!gallery) {
      // Mantine 重新启用焦点约束会先聚焦关闭按钮，随后再返回图片入口。
      const trigger = returnTarget.current;
      const timer = window.setTimeout(() => {
        if (trigger?.isConnected) trigger.focus({ preventScroll: true });
        returnTarget.current = undefined;
      });
      return () => window.clearTimeout(timer);
    }
    let disposed = false;
    let releaseFullscreen: (() => void) | undefined;
    const instance = Fancybox.show(
      gallery.images.map((image) => ({
        src: image.src,
        thumbSrc: image.src,
        caption: escapeCaption(image.title ?? ""),
        type: "image",
      })),
      {
        startIndex: gallery.index,
        triggerEl: gallery.trigger,
        placeFocusBack: true,
        l10n: zh_CN,
        mainClass: "javm-image-preview",
        mainStyle: { "z-index": "1000" },
        theme: "dark",
        Carousel: {
          Toolbar: {
            display: {
              left: ["counter"],
              middle: ["zoomIn", "zoomOut", "toggle1to1", "fullscreen"],
              right: ["autoplay", "thumbs", "close"],
            },
          },
        },
        on: {
          initLayout: (preview) => {
            releaseFullscreen = bindImagePreviewFullscreen(preview.getContainer());
          },
          destroy: () => {
            releaseFullscreen?.();
            if (!disposed) setGallery(null);
          },
        },
      },
    );
    return () => {
      disposed = true;
      instance?.destroy();
      releaseFullscreen?.();
    };
  }, [gallery]);
  return <PreviewContext.Provider value={value}>{children}</PreviewContext.Provider>;
}

export function useImagePreview() {
  const value = useContext(PreviewContext);
  if (!value) throw new Error("图片预览上下文未初始化");
  return value;
}
