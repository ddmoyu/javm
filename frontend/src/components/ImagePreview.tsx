import { t, useLocale } from "../i18n/index";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Fancybox } from "@fancyapps/ui/dist/fancybox/";
import { imagePreviewLanguages } from "../i18n/imagePreview";
import "@fancyapps/ui/dist/fancybox/fancybox.css";
import type { MediaImage } from "../contracts/media";
import { bindImagePreviewFullscreen } from "../platform/neutralino/imagePreviewFullscreen";
import { Button, Group, Loader, Modal, Text } from "@mantine/core";
import { useImageSources } from "./ImageSources";
import { getPrivacySession, subscribePrivacySession } from "../services/privacy/session";

interface Gallery {
  images: MediaImage[];
  index: number;
  trigger: HTMLElement | undefined;
  referer?: string;
}
const PreviewContext = createContext<{
  opened: boolean;
  open: (images: MediaImage[], index?: number, referer?: string) => void;
} | null>(null);

// Fancybox 的 caption 是 HTML；影片标题始终按纯文本显示。
export function escapeCaption(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}

async function decodeImage(src: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const image = new window.Image();
  image.decoding = "async";
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => {
      image.src = "";
      reject(signal.reason);
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    image.src = src;
    await Promise.race([image.decode(), cancelled]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export function ImagePreviewProvider({ children }: { children: ReactNode }) {
  const language = useLocale();
  const [gallery, setGallery] = useState<Gallery | null>(null);
  const images = useImageSources();
  const [preparing, setPreparing] = useState<{
    gallery: Gallery;
    completed: number;
    failed?: boolean;
  }>();
  const returnTarget = useRef<HTMLElement | undefined>(undefined);
  useEffect(
    () =>
      subscribePrivacySession(() => {
        if (getPrivacySession().protected) setGallery(null);
      }),
    [],
  );
  const value = useMemo(
    () => ({
      opened: gallery !== null,
      open: (images: MediaImage[], index = 0, referer?: string) => {
        if (!images.length || getPrivacySession().protected) return;
        const trigger =
          document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
        returnTarget.current = trigger;
        const next = {
          images: images.slice(0, 100),
          index: Math.max(0, Math.min(index, Math.min(100, images.length) - 1)),
          trigger,
          referer,
        };
        setPreparing({ gallery: next, completed: 0 });
        setGallery(next);
      },
    }),
    [gallery],
  );
  useEffect(() => {
    if (!gallery) {
      // Mantine 重新启用焦点约束会先聚焦关闭按钮，随后再返回图片入口。
      const trigger = returnTarget.current;
      const timer = window.setTimeout(() => {
        if (trigger?.isConnected && !getPrivacySession().protected)
          trigger.focus({ preventScroll: true });
        returnTarget.current = undefined;
      });
      return () => window.clearTimeout(timer);
    }
    let disposed = false;
    let releaseFullscreen: (() => void) | undefined;
    let instance: ReturnType<typeof Fancybox.show>;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 30_000);
    const prepare = async () => {
      const resolved: (MediaImage | undefined)[] = new Array(gallery.images.length);
      const order = [
        gallery.index,
        ...gallery.images.map((_, index) => index).filter((index) => index !== gallery.index),
      ];
      let cursor = 0,
        completed = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, order.length) }, async () => {
          while (cursor < order.length && !abort.signal.aborted) {
            const index = order[cursor++]!,
              image = gallery.images[index];
            if (!image) continue;
            try {
              const value = await images.resolve([image.src], gallery.referer, abort.signal);
              try {
                await decodeImage(value.src, abort.signal);
              } catch (error) {
                if (!abort.signal.aborted) await images.invalidate(value.source, gallery.referer);
                throw error;
              }
              if (!disposed) resolved[index] = { ...image, src: value.src };
            } catch {
              /* 失效候选不传入图库，其他封面仍可预览。 */
            }
            completed++;
            if (!disposed) setPreparing({ gallery, completed });
          }
        }),
      );
      clearTimeout(timer);
      if (disposed || getPrivacySession().protected) return;
      const available = resolved.filter((image): image is MediaImage => !!image);
      if (!available.length) {
        setPreparing({ gallery, completed, failed: true });
        return;
      }
      setPreparing(undefined);
      instance = Fancybox.show(
        available.map((image) => ({
          src: image.src,
          thumbSrc: image.src,
          caption: escapeCaption(image.title ?? ""),
          type: "image",
        })),
        {
          startIndex: Math.max(0, available.indexOf(resolved[gallery.index]!)),
          triggerEl: gallery.trigger,
          placeFocusBack: true,
          l10n: imagePreviewLanguages[language],
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
    };
    void prepare().catch(() => {
      if (!disposed) setPreparing({ gallery, completed: 0, failed: true });
    });
    return () => {
      disposed = true;
      clearTimeout(timer);
      abort.abort();
      instance?.destroy();
      releaseFullscreen?.();
    };
  }, [gallery, images, language]);
  return (
    <PreviewContext.Provider value={value}>
      {children}
      <Modal
        opened={!!gallery && preparing?.gallery === gallery}
        onClose={() => setGallery(null)}
        title={t("图片预览")}
        centered
        zIndex={1000}
      >
        <Group>
          {!preparing?.failed && <Loader size="sm" />}
          <Text component="output" aria-live="polite">
            {preparing?.failed
              ? t("图片暂不可用，请稍后重试。")
              : t("正在读取图片 {0}/{1}…", preparing?.completed ?? 0, gallery?.images.length ?? 0)}
          </Text>
        </Group>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setGallery(null)}>
            {preparing?.failed ? t("关闭") : t("取消")}
          </Button>
        </Group>
      </Modal>
    </PreviewContext.Provider>
  );
}

export function useImagePreview() {
  const value = useContext(PreviewContext);
  if (!value) throw new Error("图片预览上下文未初始化");
  return value;
}
