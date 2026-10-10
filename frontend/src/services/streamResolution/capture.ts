import type { ResolutionRequest } from "../../contracts/streamResolution";
import type { StreamCandidate } from "./ports";
import type { CdpConnection, CdpEvent } from "./cdp";
import { bounds, check, normalizeRequest, ResolutionError, webUrl } from "./shared";

const hls = (url: string) => /\.m3u8(?:[?#]|$)/i.test(url);
interface RequestInfo {
  url: string;
  headers: Record<string, string>;
}
const headersOf = (raw: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(raw)
      .filter(
        ([key, value]) => /^(referer|origin|user-agent)$/i.test(key) && typeof value === "string",
      )
      .map(([key, value]) => [key.toLowerCase(), String(value)]),
  );

/** CDP 仅观察本任务隔离的 Neu/WebView2。不会读取网页图片、标题或正文。 */
export async function captureStreams(
  cdp: CdpConnection,
  request: ResolutionRequest,
  signal: AbortSignal,
) {
  const candidates = new Map<string, StreamCandidate>();
  const requests = new Map<string, RequestInfo>();
  const sessions = new Set<string>();
  let rootSession = "",
    failed: unknown,
    firstAt = 0,
    requestCount = 0;
  const version = await cdp.send("Browser.getVersion");
  const userAgent = typeof version.userAgent === "string" ? version.userAgent : "";
  const add = (raw: string, headers: Record<string, string> = {}) => {
    if (candidates.size >= bounds.candidates) return;
    try {
      const url = webUrl(raw);
      const publicHeaders = normalizeRequest({
        url,
        provider: "direct-hls",
        publicHeaders: { "user-agent": userAgent, ...headers },
      }).publicHeaders!;
      candidates.set(url, { url, publicHeaders });
      firstAt ||= Date.now();
    } catch {
      /* 非 HTTP 地址、blob 或无效响应不能交给下载器。 */
    }
  };
  const configure = async (sessionId: string, page: boolean) => {
    if (sessions.has(sessionId)) return;
    if (sessions.size >= 16) throw new ResolutionError("limit_exceeded");
    sessions.add(sessionId);
    await cdp.send(
      "Network.enable",
      { maxTotalBufferSize: 1024 * 1024, maxResourceBufferSize: 64 * 1024 },
      sessionId,
    );
    await cdp.send(
      "Network.setBlockedURLs",
      { urls: ["*.jpg*", "*.jpeg*", "*.png*", "*.gif*", "*.webp*", "*.avif*", "*.svg*", "*.ico*"] },
      sessionId,
    );
    await cdp.send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId,
    );
    if (page) {
      await cdp.send(
        "Fetch.enable",
        {
          patterns: [
            { resourceType: "Image", requestStage: "Request" },
            { resourceType: "Media", requestStage: "Request" },
          ],
        },
        sessionId,
      );
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send(
        "Page.addScriptToEvaluateOnNewDocument",
        {
          source:
            "window.open=()=>null; window.alert=()=>{}; window.confirm=()=>false; window.prompt=()=>null; document.addEventListener('play',e=>{if(e.target instanceof HTMLMediaElement)e.target.muted=true},true);",
        },
        sessionId,
      );
    }
    await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
  };
  const event = (value: CdpEvent) => {
    const { method, sessionId, params } = value;
    if (method === "Target.attachedToTarget") {
      const target = params.targetInfo as { type: string; targetId: string };
      const id = String(params.sessionId);
      if (["iframe", "worker", "service_worker"].includes(target.type)) {
        void configure(id, target.type === "iframe").catch((error: unknown) => {
          failed = error;
        });
      } else if (target.type === "page" && rootSession && id !== rootSession) {
        void cdp
          .send("Target.closeTarget", { targetId: target.targetId })
          .catch((error: unknown) => {
            failed = error;
          });
      }
      return;
    }
    if (!sessionId || !sessions.has(sessionId)) return;
    const key = `${sessionId}:${String(params.requestId)}`;
    if (method === "Fetch.requestPaused") {
      const info = params.request as { url: string; headers: Record<string, unknown> };
      if (hls(info.url)) add(info.url, headersOf(info.headers));
      void cdp
        .send(
          "Fetch.failRequest",
          { requestId: params.requestId, errorReason: "BlockedByClient" },
          sessionId,
        )
        .catch((error: unknown) => {
          failed = error;
        });
    } else if (method === "Network.requestWillBeSent") {
      if (++requestCount > 512) {
        failed = new ResolutionError("limit_exceeded");
        return;
      }
      const info = params.request as { url: string; headers: Record<string, unknown> };
      if (requests.size >= 256) requests.delete(requests.keys().next().value!);
      const row = { url: info.url, headers: headersOf(info.headers) };
      requests.set(key, row);
      if (hls(row.url)) add(row.url, row.headers);
    } else if (method === "Network.responseReceived") {
      const response = params.response as { url: string; mimeType: string; status: number };
      if (/mpegurl/i.test(response.mimeType) || hls(response.url))
        add(response.url, requests.get(key)?.headers);
      if (params.type === "Document" && sessionId === rootSession && response.url === request.url) {
        if ([404, 410].includes(response.status)) failed = new ResolutionError("not_found");
        else if ([401, 403].includes(response.status))
          failed = new ResolutionError("interaction_required");
        else if (response.status === 429) failed = new ResolutionError("rate_limited");
      }
    } else if (method === "Page.javascriptDialogOpening") {
      void cdp.send("Page.handleJavaScriptDialog", { accept: false }, sessionId).catch(() => {});
      failed = new ResolutionError("interaction_required");
    }
  };
  const unsubscribe = cdp.on(event);
  try {
    await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" });
    for (const name of ["geolocation", "notifications", "camera", "microphone"])
      await cdp.send("Browser.setPermission", { permission: { name }, setting: "denied" });
    const targets = (await cdp.send("Target.getTargets")).targetInfos as {
      type: string;
      targetId: string;
    }[];
    const target = targets.find((item) => item.type === "page");
    if (!target) throw new ResolutionError("unavailable");
    rootSession = String(
      (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true }))
        .sessionId,
    );
    await configure(rootSession, true);
    const navigation = await cdp.send("Page.navigate", { url: request.url }, rootSession);
    if (navigation.errorText) throw new ResolutionError("network_error");
    const rule = JSON.stringify(request.failRule ?? null);
    while (true) {
      check(signal);
      if (failed) throw failed;
      // 短暂收集同一播放器的主清单/变体；不等待页面加载完毕。
      if (firstAt && Date.now() - firstAt > 650) return [...candidates.values()];
      const evaluated = await cdp.send(
        "Runtime.evaluate",
        {
          expression: `(()=>{
        const r=${rule}; const missing=r&&document.querySelector(r.selector);
        if(missing&&(!r.text||missing.textContent.includes(r.text)))return {missing:true};
        if(document.querySelector('input[type="password"],iframe[src*="challenges.cloudflare.com"],.g-recaptcha'))return {interaction:true};
        const media=[...document.querySelectorAll('video,audio')].slice(0,8);
        for(const v of media){v.muted=true;if(v.paused)void v.play().catch(()=>{});}
        const play=document.querySelector('.plyr__control--overlaid,.vjs-big-play-button,.jw-display-icon-container');
        if(play&&!play.dataset.javmTried){play.dataset.javmTried='1';play.click();}
        return {urls:[...document.querySelectorAll('video[src],source[src]')].slice(0,16).map(e=>e.src)};
      })()`,
          returnByValue: true,
          userGesture: true,
        },
        rootSession,
      );
      const result = (
        evaluated.result as {
          value?: { missing?: boolean; interaction?: boolean; urls?: string[] };
        }
      )?.value;
      if (result?.missing) throw new ResolutionError("not_found");
      if (result?.interaction) throw new ResolutionError("interaction_required");
      for (const url of result?.urls ?? []) if (hls(url)) add(url);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    unsubscribe();
  }
}
