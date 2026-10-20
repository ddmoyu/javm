import { filesystem } from "@neutralinojs/lib";

interface LocalStream {
  file: string;
  url?: string;
  size: number;
  mime: string;
  ports: Set<MessagePort>;
}
const streams = new Map<string, LocalStream>();
let ready: Promise<void> | undefined;
let listening = false;
async function waitForWorker(operation: Promise<unknown>, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
function initializeStreamWorker() {
  ready ??= (async () => {
    if (!navigator.serviceWorker)
      throw new Error("当前 WebView 不支持本地视频分块播放，请更新 WebView2。");
    if (!listening)
      navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
        if (event.data?.type !== "javm-playback-open") return;
        const port = event.ports[0];
        if (!port) return;
        const stream = streams.get(String(event.data.path));
        if (!stream || stream.ports.size >= 4) {
          port.postMessage({ type: "error" });
          port.close();
          return;
        }
        stream.ports.add(port);
        let reading = false;
        port.onmessage = ({ data }: MessageEvent) => {
          if (data.type === "close") {
            stream.ports.delete(port);
            port.close();
          } else if (data.type === "read" && !reading) {
            const { offset, length } = data as { offset: number; length: number };
            if (
              !Number.isSafeInteger(offset) ||
              !Number.isSafeInteger(length) ||
              offset < 0 ||
              length < 1 ||
              length > 262144 ||
              offset + length > stream.size
            ) {
              port.postMessage({ type: "error" });
              return;
            }
            reading = true;
            void filesystem
              .readBinaryFile(stream.file, { pos: offset, size: length })
              .then((bytes) => port.postMessage({ type: "bytes", bytes }, [bytes]))
              .catch(() => port.postMessage({ type: "error" }))
              .finally(() => {
                reading = false;
              });
          }
        };
        port.postMessage({
          type: "metadata",
          url: stream.url,
          size: stream.size,
          mime: stream.mime,
          viaClient: !stream.url || location.port !== String(window.NL_PORT),
        });
      });
    listening = true;
    await waitForWorker(
      navigator.serviceWorker
        .register("/playback-worker.js", { scope: "/" })
        .then(() => navigator.serviceWorker.ready),
      AbortSignal.timeout(10000),
    );
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve, reject) => {
        const change = () => {
          clearTimeout(timer);
          navigator.serviceWorker.removeEventListener("controllerchange", change);
          resolve();
        };
        const timer = setTimeout(() => {
          navigator.serviceWorker.removeEventListener("controllerchange", change);
          reject(new Error("本地视频服务初始化超时，请重新打开应用。"));
        }, 10000);
        navigator.serviceWorker.addEventListener("controllerchange", change);
        if (navigator.serviceWorker.controller) change();
      });
    }
  })().catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

export async function createLocalPlaybackStream(
  file: string,
  url: string | undefined,
  size: number,
  signal: AbortSignal,
) {
  await waitForWorker(initializeStreamWorker(), signal);
  signal.throwIfAborted();
  const path = `/javm-playback-stream/${crypto.randomUUID()}`;
  const mime = /\.webm$/i.test(file)
    ? "video/webm"
    : /\.(mp4|m4v|mov)$/i.test(file)
      ? "video/mp4"
      : "application/octet-stream";
  const stream: LocalStream = { file, url, size, mime, ports: new Set() };
  streams.set(path, stream);
  return {
    url: `${location.origin}${path}`,
    dispose: () => {
      streams.delete(path);
      for (const port of stream.ports) {
        port.postMessage({ type: "abort" });
        port.close();
      }
      stream.ports.clear();
    },
  };
}
