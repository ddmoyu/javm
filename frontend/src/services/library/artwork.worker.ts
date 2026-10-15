import type { CropArea } from "./ArtworkService";
interface Input {
  buffers: ArrayBuffer[];
  sheet: boolean;
  crop?: CropArea;
}
self.onmessage = async (event: MessageEvent<Input>) => {
  try {
    const { buffers, sheet, crop } = event.data;
    if (!buffers.length || buffers.length > 24 || (!sheet && buffers.length !== 1))
      throw new Error("图片数量无效。");
    if (
      crop &&
      (![crop.left, crop.top, crop.width, crop.height].every(Number.isFinite) ||
        crop.left < 0 ||
        crop.top < 0 ||
        crop.width <= 0 ||
        crop.height <= 0 ||
        crop.left + crop.width > 100 ||
        crop.top + crop.height > 100)
    )
      throw new Error("裁剪范围超出图片。");
    let canvas: OffscreenCanvas | undefined;
    for (const [index, buffer] of buffers.entries()) {
      if (buffer.byteLength > 20 * 1024 * 1024) throw new Error("图片超过 20 MiB。");
      const bitmap = await createImageBitmap(new Blob([buffer]));
      try {
        if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 50_000_000)
          throw new Error("图片像素超过限制。");
        if (sheet) {
          canvas ??= new OffscreenCanvas(3 * 480, Math.ceil(buffers.length / 3) * 270);
          const context = canvas.getContext("2d")!;
          const scale = Math.min(480 / bitmap.width, 270 / bitmap.height);
          const width = bitmap.width * scale,
            height = bitmap.height * scale;
          context.fillStyle = "#171717";
          context.fillRect((index % 3) * 480, Math.floor(index / 3) * 270, 480, 270);
          context.drawImage(
            bitmap,
            (index % 3) * 480 + (480 - width) / 2,
            Math.floor(index / 3) * 270 + (270 - height) / 2,
            width,
            height,
          );
        } else {
          const area = crop ?? { left: 0, top: 0, width: 100, height: 100 };
          const width = (bitmap.width * area.width) / 100,
            height = (bitmap.height * area.height) / 100,
            scale = Math.min(1, 1920 / width, 2880 / height);
          canvas = new OffscreenCanvas(
            Math.max(1, Math.round(width * scale)),
            Math.max(1, Math.round(height * scale)),
          );
          canvas
            .getContext("2d")!
            .drawImage(
              bitmap,
              (bitmap.width * area.left) / 100,
              (bitmap.height * area.top) / 100,
              width,
              height,
              0,
              0,
              canvas.width,
              canvas.height,
            );
        }
      } finally {
        bitmap.close();
      }
    }
    const bytes = await (
      await canvas!.convertToBlob({ type: "image/jpeg", quality: 0.9 })
    ).arrayBuffer();
    self.postMessage({ bytes }, { transfer: [bytes] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "图片处理失败。" });
  }
};
