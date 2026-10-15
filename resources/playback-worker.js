// 仅代理本应用登记的本地视频。每次从官方资源服务器读取最多 1 MiB，
// 避免 WebView 的 bytes=0- 请求让 Neutralino 一次分配整个视频文件。
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith("/javm-playback-stream/"))
    event.respondWith(streamVideo(event, url.pathname));
});

async function streamVideo(event, path) {
  const client = await self.clients.get(event.clientId);
  if (!client) return new Response(null, { status: 404 });
  const channel = new MessageChannel();
  const controller = new AbortController();
  let pending;
  let timer;
  let closed = false;
  const receive = () =>
    new Promise((resolve, reject) => {
      pending = { resolve, reject };
      timer = setTimeout(() => {
        pending = undefined;
        reject(new Error("本地媒体读取超时"));
      }, 10000);
    });
  channel.port1.onmessage = ({ data }) => {
    if (data.type === "abort") controller.abort();
    if (!pending) return;
    clearTimeout(timer);
    const current = pending;
    pending = undefined;
    if (data.type === "error" || data.type === "abort")
      current.reject(new Error("本地媒体读取失败"));
    else current.resolve(data);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    controller.abort();
    pending?.reject(new Error("播放已关闭"));
    pending = undefined;
    channel.port1.postMessage({ type: "close" });
    channel.port1.close();
  };
  const metadata = receive();
  client.postMessage({ type: "javm-playback-open", path }, [channel.port2]);
  try {
    const info = await metadata;
    const range = event.request.headers.get("range");
    const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = 0;
    let end = info.size - 1;
    if (match) {
      if (match[1]) {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      } else if (match[2]) start = Math.max(0, info.size - Number(match[2]));
    }
    if (
      (range && !match) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end
    ) {
      close();
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${info.size}` },
      });
    }
    const headers = {
      "Content-Type": info.mime,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${info.size}` } : {}),
    };
    if (event.request.method === "HEAD") {
      close();
      return new Response(null, { status: range ? 206 : 200, headers });
    }
    const stream = new ReadableStream(
      {
        async pull(output) {
          try {
            controller.signal.throwIfAborted();
            const length = Math.min(info.viaClient ? 262144 : 1048576, end - start + 1);
            let bytes;
            if (info.viaClient) {
              const reply = receive();
              channel.port1.postMessage({ type: "read", offset: start, length });
              bytes = (await reply).bytes;
            } else {
              const response = await fetch(info.url, {
                headers: { Range: `bytes=${start}-${start + length - 1}` },
                signal: controller.signal,
                cache: "no-store",
              });
              if (response.status !== 206) throw new Error("本地媒体不支持分块读取");
              bytes = await response.arrayBuffer();
            }
            controller.signal.throwIfAborted();
            if (bytes.byteLength !== length) throw new Error("本地媒体读取不完整");
            start += bytes.byteLength;
            output.enqueue(new Uint8Array(bytes));
            if (start > end) {
              output.close();
              close();
            }
          } catch (error) {
            output.error(error);
            close();
          }
        },
        cancel: close,
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, { status: range ? 206 : 200, headers });
  } catch {
    close();
    return new Response(null, { status: 404 });
  }
}
