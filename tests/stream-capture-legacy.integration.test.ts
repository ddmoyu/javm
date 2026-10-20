import { describe, expect, it } from "vite-plus/test";
import { captureStreams } from "../frontend/src/services/streamResolution/capture";
import { ResolutionError } from "../frontend/src/services/streamResolution/shared";
import { withSafeCatalogBrowser } from "./helpers/safeCatalogBrowser";
import type { SafeBrowserReply } from "./helpers/safeCatalogBrowser";

// 所有页面、脚本、清单均由 CDP 本地返回，DNS 被禁用；不连接真实内容站点。
const page = "https://player.example.invalid/DEMO-001";
const frame = "https://embed.example.invalid/player";
const playlist = "https://media.example.invalid/safe/master.m3u8?token=synthetic";
const manifest = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsafe.bin\n#EXT-X-ENDLIST\n";

async function capture(route: (url: URL) => SafeBrowserReply | undefined, source = page) {
  return withSafeCatalogBrowser(route, async (browser, signal) => {
    const abort = new AbortController();
    const cancel = () => abort.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => abort.abort(new ResolutionError("timeout")), 5000);
    try {
      return await captureStreams(browser, { url: source, provider: "webview" }, abort.signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    }
  });
}

const empty = { status: 404, body: "" };

describe.runIf(process.env.JAVM_WEBVIEW_INTEGRATION === "1")(
  "对齐旧版资源捕获（隔离隐藏宿主、安全 mock）",
  () => {
    it("网页查询参数中的 m3u8 不算候选，等待真正的清单请求", async () => {
      const source = `${page}?src=${encodeURIComponent(playlist)}`;
      const streams = await capture((url) => {
        if (url.href === source)
          return {
            body: `<main>Safe delayed player</main><script>setTimeout(()=>fetch(atob('${btoa(playlist)}')),1400)</script>`,
          };
        if (url.href === playlist) return { type: "application/vnd.apple.mpegurl", body: manifest };
        return empty;
      }, source);
      expect(streams.map((stream) => stream.url)).toEqual([playlist]);
    }, 20000);

    it("播放器只公布配置时也能读取链接，保留页面 Referer", async () => {
      const streams = await capture((url) =>
        url.href === page
          ? {
              body: `<main>Safe fictional player</main><script>const playerConfig={source:${JSON.stringify(playlist).replaceAll("/", "\\/")}};</script>`,
            }
          : empty,
      );
      expect(streams).toContainEqual({
        url: playlist,
        publicHeaders: expect.objectContaining({ referer: page }),
      });
    }, 20000);

    it("隐藏页面依赖动画帧时仍能启动播放器请求", async () => {
      const streams = await capture((url) => {
        if (url.href === page)
          return {
            body: `<main>Safe animation fixture</main><script>requestAnimationFrame(()=>fetch(atob('${btoa(playlist)}')));</script>`,
          };
        if (url.href === playlist) return { type: "application/vnd.apple.mpegurl", body: manifest };
        return empty;
      });
      expect(streams.some((stream) => stream.url === playlist)).toBe(true);
    }, 20000);

    it("自动验证的 403 可以完成重载，隐藏登录框不误判为人工操作", async () => {
      let requests = 0;
      const streams = await capture((url) => {
        if (url.href === page) {
          const checking = ++requests === 1;
          return {
            status: checking ? 403 : 200,
            headers: checking ? { "cf-mitigated": "challenge" } : undefined,
            body: checking
              ? "<main>Safe automatic check</main><script>setTimeout(()=>location.reload(),350)</script>"
              : `<main>Safe ready</main><input type="password" hidden><script>fetch('${playlist}')</script>`,
          };
        }
        if (url.href === playlist) return { type: "application/vnd.apple.mpegurl", body: manifest };
        return empty;
      });
      expect(requests).toBe(2);
      expect(streams.some((stream) => stream.url === playlist)).toBe(true);
    }, 20000);

    it("跨站 iframe 的播放器按钮也会启动，沿用 iframe 实际请求头", async () => {
      const streams = await capture((url) => {
        if (url.href === page)
          return { body: `<main>Safe embed</main><iframe src="${frame}"></iframe>` };
        if (url.href === frame)
          return {
            headers: { "Referrer-Policy": "unsafe-url" },
            body: `<button class="vjs-big-play-button">Play safe fixture</button><script>document.querySelector('button').onclick=()=>fetch(atob('${btoa(playlist)}'));</script>`,
          };
        if (url.href === playlist) return { type: "application/vnd.apple.mpegurl", body: manifest };
        return empty;
      });
      expect(streams).toContainEqual({
        url: playlist,
        publicHeaders: expect.objectContaining({ referer: frame }),
      });
    }, 20000);

    it.each(["fetch", "xhr"])(
      "%s 返回无后缀纯文本清单时按内容捕获",
      async (api) => {
        const address = "https://player.example.invalid/manifest?id=safe";
        const streams = await capture((url) => {
          if (url.href === page)
            return {
              body: `<main>Safe plain-text fixture</main><script>${
                api === "fetch"
                  ? `fetch('${address}')`
                  : `const request=new XMLHttpRequest();request.open('GET','${address}');request.send()`
              };</script>`,
            };
          if (url.href === address) return { type: "text/plain", body: manifest };
          return empty;
        });
        expect(streams.some((stream) => stream.url === address)).toBe(true);
      },
      20000,
    );

    it("脚本查询参数中的图片名不会阻止 Hls 初始化，图片和弹窗仍被拦截", async () => {
      const address = "https://media.example.invalid/safe/manifest";
      let loadedScript = false;
      const forbidden: string[] = [];
      const streams = await capture((url) => {
        if (url.href === page)
          return {
            body: '<main>Safe Hls fixture</main><img src="/safe.png"><script src="/player.js?poster=safe.jpg"></script><script>window.open("/popup")</script>',
          };
        if (url.pathname === "/player.js") {
          loadedScript = true;
          return {
            type: "application/javascript",
            body: `window.Hls=class{loadSource(url){this.source=url}};new Hls().loadSource(atob('${btoa(address)}'));`,
          };
        }
        if (["/safe.png", "/popup"].includes(url.pathname)) forbidden.push(url.pathname);
        return empty;
      });
      expect(loadedScript).toBe(true);
      expect(streams.some((stream) => stream.url === address)).toBe(true);
      expect(forbidden).toEqual([]);
    }, 20000);

    it("同站 iframe 的临时媒体属性在节点移除后仍能捕获", async () => {
      const localFrame = "https://player.example.invalid/embed";
      const streams = await capture((url) => {
        if (url.href === page) return { body: `<iframe src="${localFrame}"></iframe>` };
        if (url.href === localFrame)
          return {
            body: `<button class="plyr__control--overlaid">Safe playback</button><script>
              document.querySelector('button').onclick=()=>{
                const source=document.createElement('source');source.src=atob('${btoa(playlist)}');
                source.removeAttribute('src');source.remove();
              };</script>`,
          };
        return empty;
      });
      expect(streams).toContainEqual({
        url: playlist,
        publicHeaders: expect.objectContaining({ referer: localFrame }),
      });
    }, 20000);

    it("遇到实际人工验证仍自动结束，不点击验证控件", async () => {
      let clicked = false;
      await expect(
        capture((url) => {
          if (url.href === page)
            return {
              status: 403,
              headers: { "cf-mitigated": "challenge" },
              body: '<main>Safe manual check</main><iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/safe"></iframe>',
            };
          if (url.pathname === "/cdn-cgi/challenge-platform/safe")
            return {
              body: `<div id="safe"></div><script>
                const root=document.querySelector('#safe').attachShadow({mode:'closed'});
                root.innerHTML='<label><input type="checkbox">Safe manual verification</label>';
                root.addEventListener('click',()=>fetch('/clicked'));
              </script>`,
            };
          if (url.pathname === "/clicked") clicked = true;
          return empty;
        }),
      ).rejects.toMatchObject({ code: "interaction_required" });
      expect(clicked).toBe(false);
    }, 20000);
  },
);
