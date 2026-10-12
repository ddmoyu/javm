import type { ResolutionRequest } from "../../contracts/streamResolution";
import type { StreamCandidate } from "./ports";
import type { CdpConnection, CdpEvent } from "./cdp";
import { bounds, check, normalizeRequest, ResolutionError, webUrl } from "./shared";
import { installCapture } from "./capturePage";
import { inspectChallengeInteraction } from "../catalog/challengeInteraction";

const hls = (raw: string) => {
  try {
    // 播放页的 ?src=...m3u8 不是清单，不能提前结束捕获。
    return /\.m3u8$/i.test(new URL(raw).pathname);
  } catch {
    return false;
  }
};
interface RequestInfo {
  url: string;
  headers: Record<string, string>;
  root: boolean;
}
// 广告位常嵌入直播或短预告；只有点播且达到该时长的清单才视为正片并提前结束。
type Kind = "master" | "feature" | "short" | "live";
/** 有界读取浏览器已加载的清单文本，只判断类型、时长和变体地址。 */
export function classifyPlaylist(text: string, base: string) {
  const lines = text.slice(0, 65_536).split(/\r?\n/);
  if (!/^\uFEFF?#EXTM3U/.test(lines[0] ?? "")) return;
  if (lines.some((line) => line.startsWith("#EXT-X-STREAM-INF"))) {
    const variants: string[] = [];
    for (let index = 0; index < lines.length && variants.length < 16; index++)
      if (lines[index]!.startsWith("#EXT-X-STREAM-INF")) {
        const next = lines.slice(index + 1).find((line) => line.trim() && !line.startsWith("#"));
        try {
          if (next) variants.push(new URL(next.trim(), base).href);
        } catch {
          /* 无效变体由后续 HLS 检查处理。 */
        }
      }
    return { kind: "master" as Kind, variants };
  }
  if (!lines.some((line) => line.trim() === "#EXT-X-ENDLIST"))
    return { kind: "live" as Kind, variants: [] };
  let duration = 0;
  for (const line of lines)
    if (line.startsWith("#EXTINF:")) duration += Number.parseFloat(line.slice(8)) || 0;
  return { kind: (duration >= bounds.featureSeconds ? "feature" : "short") as Kind, variants: [] };
}
const headersOf = (raw: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(raw)
      .filter(
        ([key, value]) => /^(referer|origin|user-agent)$/i.test(key) && typeof value === "string",
      )
      .map(([key, value]) => [key.toLowerCase(), String(value)]),
  );

/** 仅在本任务隔离的 Neu/WebView2 内提取候选，不把网页内容传回主界面。 */
export async function captureStreams(
  cdp: Pick<CdpConnection, "send" | "on">,
  request: ResolutionRequest,
  signal: AbortSignal,
) {
  const candidates = new Map<string, StreamCandidate>();
  const requests = new Map<string, RequestInfo>();
  const sessions = new Set<string>();
  const pages = new Set<string>();
  const contexts = new Map<string, { session: string; id: number; frame: string }>();
  const observed = new Set<string>();
  const extraHeaders = new Map<string, Record<string, string>>();
  const challengeSessions = new Set<string>();
  const kinds = new Map<string, Kind>();
  const parents = new Map<string, string>();
  const preferredRoot = new Set<string>();
  let bodies = 0;
  let rootSession = "",
    rootFrame = "",
    failed: unknown,
    requestCount = 0,
    challenged = false,
    documentSeen = false,
    interactionSince = 0,
    nextInteractionProbe = 0,
    navigatedAt = 0,
    preferredAt = 0;
  const version = await cdp.send("Browser.getVersion");
  const userAgent = typeof version.userAgent === "string" ? version.userAgent : "";
  const rejected = (url: string) => {
    const kind = kinds.get(url);
    if (kind === "live") return true;
    if (kind !== "master") return false;
    const children = [...parents].filter(([, parent]) => parent === url).map(([child]) => child);
    return children.length > 0 && children.every((child) => kinds.get(child) === "live");
  };
  const preferred = (url: string): boolean => {
    if (rejected(url)) return false;
    const kind = kinds.get(url);
    if (kind === "feature") return true;
    if (kind === "master")
      return [...parents].some(([child, parent]) => parent === url && preferred(child));
    // 主文档自身公布或请求的清单通常就是正片；尚未分类时也可提前返回。
    return preferredRoot.has(url) && kind !== "short";
  };
  const classify = async (sessionId: string, requestId: unknown, url: string) => {
    if (bodies >= 24 || kinds.has(url)) return;
    bodies++;
    try {
      const response = await cdp.send("Network.getResponseBody", { requestId }, sessionId);
      const raw = String(response.body ?? "").slice(0, 98_304);
      const text = response.base64Encoded ? atob(raw) : raw;
      const result = classifyPlaylist(text, url);
      if (!result) return;
      kinds.set(url, result.kind);
      for (const variant of result.variants) if (!parents.has(variant)) parents.set(variant, url);
    } catch {
      /* 读取失败的清单保持未分类，交给后续 HLS 检查。 */
    }
  };
  const add = (
    raw: string,
    headers: Record<string, string> = {},
    network = false,
    root = false,
  ) => {
    try {
      const url = webUrl(raw);
      if (root) preferredRoot.add(url);
      if (!candidates.has(url) && candidates.size >= bounds.candidates) return;
      if (!network && observed.has(url)) return;
      const publicHeaders = normalizeRequest({
        url,
        provider: "direct-hls",
        publicHeaders: {
          "user-agent": userAgent,
          ...(network && !observed.has(url) ? {} : candidates.get(url)?.publicHeaders),
          ...headers,
        },
      }).publicHeaders!;
      candidates.set(url, { url, publicHeaders });
      if (network) observed.add(url);
    } catch {
      /* 非 HTTP 地址、blob 或无效响应不能交给下载器。 */
    }
  };
  const configure = async (sessionId: string, page: boolean) => {
    if (sessions.has(sessionId)) return;
    if (sessions.size >= 16) throw new ResolutionError("limit_exceeded");
    sessions.add(sessionId);
    if (page) pages.add(sessionId);
    // 跨进程 iframe 的文档响应可能先在父会话到达；不能据此漏掉子会话的验证控件。
    if (page && sessionId !== rootSession) challengeSessions.add(sessionId);
    await cdp.send(
      "Network.enable",
      { maxTotalBufferSize: 1024 * 1024, maxResourceBufferSize: 64 * 1024 },
      sessionId,
    );
    await cdp.send(
      "Network.setBlockedURLs",
      {
        // 只按路径拦截图片，不能误拦带 poster=cover.jpg 参数的播放器脚本。
        urls: [],
        urlPatterns: ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "ico"].map(
          (extension) => ({ urlPattern: `*://*:*/*.${extension}`, block: true }),
        ),
      },
      sessionId,
    );
    await cdp.send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId,
    );
    if (page) {
      await cdp.send("Runtime.enable", {}, sessionId);
      // 与目录读取保持一致：让隐藏页面执行动画帧，不显示或聚焦原生窗口。
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
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
            "window.open=()=>null; window.alert=()=>{}; window.confirm=()=>false; window.prompt=()=>null; document.addEventListener('play',e=>{if(e.target instanceof HTMLMediaElement)e.target.muted=true},true);" +
            installCapture,
        },
        sessionId,
      );
    }
    await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
  };
  const event = (value: CdpEvent) => {
    if (signal.aborted) return;
    const { method, sessionId, params } = value;
    if (method === "Target.attachedToTarget") {
      const target = params.targetInfo as { type: string; targetId: string };
      const id = String(params.sessionId);
      if (["iframe", "worker", "shared_worker", "service_worker"].includes(target.type)) {
        void configure(id, target.type === "iframe").catch((error: unknown) => {
          if (
            sessions.has(id) ||
            (error instanceof ResolutionError && error.code === "limit_exceeded")
          )
            failed = error;
        });
      } else if (target.type === "page" && rootSession && id !== rootSession) {
        void cdp
          .send("Target.closeTarget", { targetId: target.targetId })
          .catch((error: unknown) => {
            failed = error;
          });
      } else if (target.type !== "page") {
        // 不支持的目标也不能永久暂停在等待调试器状态。
        void cdp.send("Target.detachFromTarget", { sessionId: id }).catch(() => {});
      }
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const id = String(params.sessionId);
      sessions.delete(id);
      pages.delete(id);
      challengeSessions.delete(id);
      for (const [key, context] of contexts) if (context.session === id) contexts.delete(key);
      for (const key of requests.keys()) if (key.startsWith(`${id}:`)) requests.delete(key);
      for (const key of extraHeaders.keys()) if (key.startsWith(`${id}:`)) extraHeaders.delete(key);
      return;
    }
    if (!sessionId || !sessions.has(sessionId)) return;
    if (method === "Runtime.executionContextCreated") {
      const context = params.context as {
        id: number;
        auxData?: { isDefault?: boolean; frameId?: string };
      };
      if (pages.has(sessionId) && context.auxData?.isDefault) {
        if (contexts.size >= 64) failed = new ResolutionError("limit_exceeded");
        else
          contexts.set(`${sessionId}:${context.id}`, {
            session: sessionId,
            id: context.id,
            frame: context.auxData.frameId ?? "",
          });
      }
    } else if (method === "Runtime.executionContextDestroyed") {
      contexts.delete(`${sessionId}:${String(params.executionContextId)}`);
    } else if (method === "Runtime.executionContextsCleared") {
      for (const [key, context] of contexts)
        if (context.session === sessionId) contexts.delete(key);
    }
    const key = `${sessionId}:${String(params.requestId)}`;
    if (method === "Fetch.requestPaused") {
      const info = params.request as { url: string; headers: Record<string, unknown> };
      if (hls(info.url)) add(info.url, headersOf(info.headers), true);
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
      const row = {
        url: info.url,
        headers: { ...headersOf(info.headers), ...extraHeaders.get(key) },
        root: sessionId === rootSession && params.frameId === rootFrame,
      };
      requests.set(key, row);
      if (hls(row.url)) add(row.url, row.headers, true, row.root);
    } else if (method === "Network.requestWillBeSentExtraInfo") {
      const headers = headersOf(params.headers as Record<string, unknown>);
      if (extraHeaders.size >= 256) extraHeaders.delete(extraHeaders.keys().next().value!);
      extraHeaders.set(key, headers);
      const row = requests.get(key);
      if (row) {
        row.headers = { ...row.headers, ...headers };
        if (candidates.has(row.url)) add(row.url, row.headers, true);
      }
    } else if (method === "Network.responseReceived") {
      const response = params.response as {
        url: string;
        mimeType: string;
        status: number;
        headers?: Record<string, unknown>;
      };
      if (/mpegurl/i.test(response.mimeType) || hls(response.url))
        add(response.url, requests.get(key)?.headers, true, requests.get(key)?.root);
      if (response.url.startsWith("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/"))
        challengeSessions.add(sessionId);
      if (
        params.type === "Document" &&
        sessionId === rootSession &&
        (params.frameId === rootFrame || response.url === request.url)
      ) {
        documentSeen = true;
        challenged = Object.entries(response.headers ?? {}).some(
          ([key, value]) => key.toLowerCase() === "cf-mitigated" && value === "challenge",
        );
        if ([404, 410].includes(response.status)) failed = new ResolutionError("not_found");
        else if (response.status === 401 || (response.status === 403 && !challenged))
          failed = new ResolutionError("interaction_required");
        else if (response.status === 429) failed = new ResolutionError("rate_limited");
        // 源站宕机（如 Cloudflare 52x）不会自行恢复，立即换下一个来源；验证页的 503 除外。
        else if (response.status >= 500 && !challenged)
          failed = new ResolutionError("network_error");
      }
    } else if (method === "Network.loadingFinished") {
      const row = requests.get(key);
      if (row && candidates.has(webUrl(row.url)))
        void classify(sessionId, params.requestId, webUrl(row.url));
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
    const tree = await cdp.send("Page.getFrameTree", {}, rootSession);
    rootFrame = (tree.frameTree as { frame: { id: string } }).frame.id;
    // Page.navigate 要等主文档响应才返回；代理或自动验证常超过单条命令的 3 秒，
    // 因此与捕获循环并行，由隐藏实例的总期限统一截止。
    // 连接重置等瞬时错误在主文档到达前自动重试一次，仍失败才换下一个来源。
    const navigate = (attempt: number) => {
      navigatedAt = Date.now();
      void cdp.send("Page.navigate", { url: request.url }, rootSession, bounds.webviewMs).then(
        (navigation) => {
          // 脚本跳转会让首个导航返回 ERR_ABORTED；已收到主文档时继续观察新文档。
          if (!navigation.errorText || documentSeen || candidates.size || signal.aborted) return;
          if (attempt === 0 && Date.now() - navigatedAt < bounds.webviewMs / 2)
            setTimeout(() => {
              if (!signal.aborted) navigate(1);
            }, 1000);
          else failed ??= new ResolutionError("network_error");
        },
        (error: unknown) => {
          if (!(error instanceof ResolutionError && error.code === "timeout")) failed ??= error;
        },
      );
    };
    navigate(0);
    const rule = JSON.stringify(request.failRule ?? null);
    while (true) {
      check(signal);
      if (failed) throw failed;
      const usable = [...candidates.values()].filter((item) => !rejected(item.url));
      if (!usable.some((item) => preferred(item.url))) preferredAt = 0;
      else preferredAt ||= Date.now();
      // 正片出现后短暂收集主清单/变体；否则等到软期限，避免把广告直播当成资源返回。
      if (
        (preferredAt && Date.now() - preferredAt > 1000) ||
        (usable.length && navigatedAt && Date.now() - navigatedAt > bounds.webviewMs - 6000)
      )
        return usable.sort(
          (a, b) =>
            Number(preferred(b.url)) - Number(preferred(a.url)) ||
            Number(kinds.get(a.url) === "short") - Number(kinds.get(b.url) === "short") ||
            Number(observed.has(b.url)) - Number(observed.has(a.url)),
        );
      if (Date.now() >= nextInteractionProbe) {
        nextInteractionProbe = Date.now() + 1000;
        for (const id of challengeSessions)
          if ((await inspectChallengeInteraction(cdp, id, signal)) === "required")
            throw new ResolutionError("interaction_required");
      }
      let interacting = false;
      for (const [key, context] of contexts) {
        check(signal);
        let evaluated;
        try {
          const root = context.session === rootSession && context.frame === rootFrame;
          evaluated = await cdp.send(
            "Runtime.evaluate",
            {
              contextId: context.id,
              expression: `${installCapture};globalThis.__javmStreamCapture.read(${root ? rule : "null"},${root && challenged})`,
              returnByValue: true,
              userGesture: true,
              silent: true,
              timeout: 250,
            },
            context.session,
          );
        } catch (error) {
          check(signal);
          // 自动验证和重定向会销毁执行环境；首字节未到或脚本繁忙时单次执行超时，均继续等待。
          if (contexts.get(key) !== context) continue;
          if (error instanceof ResolutionError && error.code === "timeout") continue;
          throw error;
        }
        if (contexts.get(key) !== context) continue;
        const result = (
          evaluated.result as {
            value?: { missing?: boolean; interaction?: boolean; urls?: string[]; pageUrl?: string };
          }
        )?.value;
        if (result?.missing) throw new ResolutionError("not_found");
        for (const url of (result?.urls ?? []).slice(0, bounds.candidates)) {
          const row = [...requests.values()].find((item) => item.url === url);
          add(
            url,
            row?.headers ?? (result?.pageUrl ? { referer: result.pageUrl } : {}),
            !!row,
            context.session === rootSession && context.frame === rootFrame,
          );
        }
        if (result?.interaction) interacting = true;
      }
      // 页面常预置由脚本隐藏的登录框；仅在持续可见且始终没有候选时才判定需要人工操作。
      if (!interacting || candidates.size) interactionSince = 0;
      else if (!interactionSince) interactionSince = Date.now();
      else if (Date.now() - interactionSince > 6000)
        throw new ResolutionError("interaction_required");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    unsubscribe();
  }
}
