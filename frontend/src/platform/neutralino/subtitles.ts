import { filesystem } from "@neutralinojs/lib";
export async function prepareSubtitles(paths: string[], signal: AbortSignal) {
  const subtitles: { url: string; label: string }[] = [],
    errors: string[] = [];
  const dispose = () => {
    for (const item of subtitles) URL.revokeObjectURL(item.url);
  };
  try {
    for (const path of paths) {
      signal.throwIfAborted();
      const name = path.split(/[\\/]/).at(-1) ?? "字幕";
      try {
        const stat = await filesystem.getStats(path);
        if (!stat.isFile || stat.size > 5 * 1024 * 1024) throw new Error("文件不存在或超过 5 MiB");
        const bytes = await filesystem.readBinaryFile(path, { pos: 0, size: 5 * 1024 * 1024 + 1 });
        const text = await new Promise<string>((resolve, reject) => {
          const worker = new Worker(
            new URL("../../services/playback/subtitles.worker.ts", import.meta.url),
            { type: "module" },
          );
          const active = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
          const cleanup = () => {
            worker.terminate();
            active.removeEventListener("abort", cancel);
          };
          const cancel = () => {
            cleanup();
            reject(active.reason);
          };
          active.addEventListener("abort", cancel, { once: true });
          worker.onmessage = ({ data }: { data: { text: string; error?: string } }) => {
            cleanup();
            data.error ? reject(new Error(data.error)) : resolve(data.text);
          };
          worker.onerror = () => {
            cleanup();
            reject(new Error("字幕处理失败"));
          };
          if (active.aborted) {
            cancel();
            return;
          }
          worker.postMessage({ bytes, name }, [bytes]);
        });
        subtitles.push({
          url: URL.createObjectURL(new Blob([text], { type: "text/vtt" })),
          label: `${subtitles.length + 1}. ${name}`,
        });
      } catch (e) {
        signal.throwIfAborted();
        errors.push(`${name}：${e instanceof Error ? e.message : "无法读取"}`);
      }
    }
    signal.throwIfAborted();
    return { subtitles, warning: errors.join("；"), dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}
