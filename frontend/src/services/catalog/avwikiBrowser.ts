import type { CdpConnection, CdpEvent } from "../streamResolution/cdp";
import { CATALOG_BYTES } from "./catalogData";
import { isAvwikiWorksUrl } from "./avwikiWorks";
import { BrowserDiagnostics, CatalogBrowserError } from "./browserDiagnostics";
import type { BrowserDiagnosticDetail } from "./browserDiagnostics";
import { inspectChallengeInteraction } from "./challengeInteraction";

type BrowserConnection = Pick<CdpConnection, "send" | "on">;
type ResourceSource = "source" | "challenge" | "other" | "unknown";
interface ResourceRequest {
  type: string;
  source: ResourceSource;
  failed: boolean;
  pat401: boolean;
}
const isCanceled = (event: { canceled?: unknown; errorText?: unknown }) =>
  event.canceled === true ||
  event.errorText === "net::ERR_ABORTED" ||
  event.errorText === "ERR_ABORTED";
const isRelevantResource = (type: string) => ["Script", "XHR", "Fetch", "Document"].includes(type);
export interface AvwikiBrowserResponse {
  status: number;
  challenge: boolean;
}
export interface AvwikiBrowserDiagnostics {
  requests: number;
  workers: number;
  resumedWorkers: number;
  activePages: number;
  scriptErrors: number;
  failedResources: number;
  lastResourceType: string;
  lastNetworkError: string;
  canceledResources: number;
  blockedResources: number;
  lastCanceledType: string;
  lastCanceledSource: ResourceSource;
  lastCanceledAfterMs: number;
  lastFailureSource: ResourceSource;
  lastFailureAfterMs: number;
  pat401Responses: number;
  blockedChallengeResources: number;
  blockedResourceTypes: string;
  challengeInteraction?: "required";
  detail?: BrowserDiagnosticDetail;
}
export type AvwikiBrowserStage = "initializing" | "requesting" | "verifying" | "extracting";
const denied = () =>
  new CatalogBrowserError(
    "http_denied",
    "作品来源拒绝访问（HTTP 403），隐藏浏览器也未获准读取。请检查代理线路或稍后重试。",
  );
const interaction = (
  reason:
    | "interaction_required"
    | "authentication_required"
    | "dialog_required" = "interaction_required",
) => new CatalogBrowserError(reason, "作品来源需要人工验证，已自动结束隐藏读取。");

/** 只处理本次来源页面；不点击验证控件、导出 Cookie 或加载图片和媒体。 */
export async function readAvwikiBrowserPage(
  cdp: BrowserConnection,
  url: string,
  signal: AbortSignal,
  reportResponse?: (response: AvwikiBrowserResponse) => void,
  reportStage?: (stage: AvwikiBrowserStage) => void,
  reportDiagnostics?: (value: AvwikiBrowserDiagnostics) => void,
): Promise<string> {
  if (!isAvwikiWorksUrl(url)) throw new CatalogBrowserError("invalid_url", "作品来源地址无效。");
  signal.throwIfAborted();
  const detail = new BrowserDiagnostics(new URL(url).origin);
  const original = cdp;
  cdp = {
    on: (listener) => original.on(listener),
    send: async (method, params, id) => {
      try {
        return await original.send(method, params, id);
      } catch (error) {
        if (!signal.aborted) detail.commandFailed(method, id);
        throw error;
      }
    },
  };
  let session = "",
    frame = "",
    status = 0,
    requests = 0;
  let failed: unknown;
  let context: number | undefined;
  let generation = 0,
    responseLoader = "",
    committedLoader = "",
    documentRequest = "";
  let stage: AvwikiBrowserStage = "initializing";
  let challenged = false;
  let finished = false,
    interactionPending = false,
    nextInteractionProbe = 0;
  const challengeFrames = new Set<string>();
  const diagnostic: AvwikiBrowserDiagnostics = {
    requests: 0,
    workers: 0,
    resumedWorkers: 0,
    activePages: 0,
    scriptErrors: 0,
    failedResources: 0,
    lastResourceType: "",
    lastNetworkError: "",
    canceledResources: 0,
    blockedResources: 0,
    lastCanceledType: "",
    lastCanceledSource: "unknown",
    lastCanceledAfterMs: 0,
    lastFailureSource: "unknown",
    lastFailureAfterMs: 0,
    pat401Responses: 0,
    blockedChallengeResources: 0,
    blockedResourceTypes: "",
  };
  const started = performance.now();
  const resources = new Map<string, ResourceRequest>();
  const blockedTypes = new Set<string>();
  const recordFailure = (resource: ResourceRequest | undefined, error: unknown) => {
    if (!resource || !isRelevantResource(resource.type)) return;
    // 同一请求的错误响应和 loadingFailed 不能重复计数。
    if (!resource.failed) diagnostic.failedResources++;
    resource.failed = true;
    diagnostic.lastResourceType = resource.type;
    diagnostic.lastFailureSource = resource.source;
    diagnostic.lastFailureAfterMs = Math.round(performance.now() - started);
    diagnostic.lastNetworkError =
      typeof error === "string" && /^(?:net::ERR_[A-Z0-9_]{1,80}|HTTP_[1-5]\d\d)$/.test(error)
        ? error.replace(/^net::/, "")
        : "NETWORK_FAILED";
  };
  const advance = (value: AvwikiBrowserStage) => {
    if (stage !== value) reportStage?.(value);
    stage = value;
  };
  const networkFailure = (value: unknown) => {
    const code =
      typeof value === "string" && /^net::ERR_[A-Z0-9_]{1,80}$/.test(value)
        ? value.slice(5)
        : "NETWORK_FAILED";
    return new CatalogBrowserError(
      "network_error",
      `隐藏浏览器连接作品来源失败（${code}），请检查网络或代理。`,
    );
  };
  const sessions = new Set<string>();
  const expected = new URL(url);
  const isPatProbe = (value: unknown) => {
    if (typeof value !== "string" || value.length > 8192) return false;
    try {
      const target = new URL(value);
      // 只有已知挑战端点的 PAT 401 属于预期探测，不能忽略普通接口或其他状态的错误。
      return (
        target.protocol === "https:" &&
        !target.username &&
        !target.password &&
        !target.port &&
        (target.origin === expected.origin || target.hostname === "challenges.cloudflare.com") &&
        /^\/cdn-cgi\/challenge-platform\/(?:[a-zA-Z0-9_-]+\/)*pat\/[^/]+/.test(target.pathname)
      );
    } catch {
      return false;
    }
  };
  const resourceSource = (value: unknown): ResourceSource => {
    if (typeof value !== "string" || value.length > 8192) return "unknown";
    try {
      const target = new URL(value);
      if (
        target.hostname === "challenges.cloudflare.com" ||
        (target.origin === expected.origin && target.pathname.startsWith("/cdn-cgi/"))
      )
        return "challenge";
      return target.origin === expected.origin ? "source" : "other";
    } catch {
      return "unknown";
    }
  };
  const samePage = (value: string) => {
    try {
      if (value.length > 8192) return false;
      const actual = new URL(value);
      // 自动检查可能在同一作品页附加临时参数；不允许改变实体、页码或其他参数。
      for (const name of ["__cf_chl_tk", "__cf_chl_rt_tk", "__cf_chl_f_tk"])
        actual.searchParams.delete(name);
      return (
        actual.origin === expected.origin &&
        actual.pathname.replace(/\/$/, "") === expected.pathname.replace(/\/$/, "") &&
        actual.searchParams.toString() === expected.searchParams.toString() &&
        !actual.username &&
        !actual.password
      );
    } catch {
      return false;
    }
  };
  const send = (method: string, params: Record<string, unknown>, id = session) => {
    void cdp.send(method, params, id || undefined).catch((error: unknown) => {
      failed = error;
    });
  };
  const configure = async (id: string, kind = "page") => {
    const page = kind === "page" || kind === "iframe";
    if (sessions.has(id)) return;
    if (sessions.size >= 8)
      throw new CatalogBrowserError("target_limit", "作品页面请求过多，已自动结束读取。");
    sessions.add(id);
    if (kind === "iframe") challengeFrames.add(id);
    detail.target(id, kind);
    await cdp.send(
      "Network.enable",
      { maxTotalBufferSize: CATALOG_BYTES, maxResourceBufferSize: 65536 },
      id,
    );
    await cdp.send(
      "Network.setBlockedURLs",
      {
        // URLPattern 匹配 pathname，不把脚本查询参数里的图片名当成媒体请求。
        urls: [],
        urlPatterns: [
          "jpg",
          "jpeg",
          "png",
          "gif",
          "webp",
          "avif",
          "svg",
          "ico",
          "mp4",
          "m3u8",
          "mp3",
        ].map((extension) => ({ urlPattern: `*://*:*/*.${extension}`, block: true })),
      },
      id,
    );
    if (page)
      await cdp.send(
        "Fetch.enable",
        {
          patterns: ["Image", "Media", "Font", "Document"].map((resourceType) => ({
            resourceType,
            requestStage: "Request",
          })),
        },
        id,
      );
    if (page) {
      await cdp.send("Runtime.enable", {}, id);
      // 隐藏宿主会暂停动画帧。只激活页面运行状态，不显示、激活或聚焦原生窗口。
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, id);
      diagnostic.activePages++;
    }
    await cdp.send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      id,
    );
    await cdp.send("Runtime.runIfWaitingForDebugger", {}, id);
    if (!page) diagnostic.resumedWorkers++;
  };
  const onEvent = ({ method, params, sessionId }: CdpEvent) => {
    // 超时/取消会同时开始回收宿主；退出引发的请求取消不能反过来成为失败原因。
    if (signal.aborted) return;
    detail.event({ method, params, sessionId });
    if (method === "Target.attachedToTarget") {
      const info = params.targetInfo as { type: string; targetId: string };
      const id = String(params.sessionId);
      if (info.type === "page" && session && id !== session)
        send("Target.closeTarget", { targetId: info.targetId }, "");
      else if (["iframe", "worker", "shared_worker", "service_worker"].includes(info.type)) {
        if (info.type !== "iframe") diagnostic.workers++;
        void configure(id, info.type).catch((error: unknown) => {
          failed = error;
        });
      } else if (info.type !== "page") {
        // 不把不支持的自动附加目标永久留在等待调试器状态。
        send("Target.detachFromTarget", { sessionId: id }, "");
      }
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const id = String(params.sessionId);
      sessions.delete(id);
      challengeFrames.delete(id);
      for (const key of resources.keys()) if (key.startsWith(`${id}:`)) resources.delete(key);
      return;
    }
    if (!sessionId || !sessions.has(sessionId)) return;
    // 只统计异常数量，绝不记录页面异常文本、URL 或脚本内容。
    if (method === "Runtime.exceptionThrown") diagnostic.scriptErrors++;
    const resourceKey = `${sessionId}:${String(params.requestId)}`;
    if (method === "Network.responseReceived") {
      const response = params.response as { status: number; url?: string };
      const resource = resources.get(resourceKey);
      if (
        response.status >= 400 &&
        !(sessionId === session && params.requestId === documentRequest)
      ) {
        if (
          response.status === 401 &&
          resource &&
          ["XHR", "Fetch"].includes(resource.type) &&
          isPatProbe(response.url)
        ) {
          if (!resource.pat401) diagnostic.pat401Responses++;
          resource.pat401 = true;
        } else recordFailure(resource, `HTTP_${response.status}`);
      }
    }
    if (method === "Network.loadingFailed") {
      const resource = resources.get(resourceKey);
      if (
        params.blockedReason === "inspector" ||
        params.errorText === "net::ERR_BLOCKED_BY_CLIENT"
      ) {
        if (resource) {
          diagnostic.blockedResources++;
          if (resource.source === "challenge") diagnostic.blockedChallengeResources++;
          blockedTypes.add(
            ["Document", "Script", "XHR", "Fetch", "Image", "Media", "Font", "Stylesheet"].includes(
              resource.type,
            )
              ? resource.type
              : "Other",
          );
        }
      } else if (isCanceled(params)) {
        if (resource && isRelevantResource(resource.type)) {
          diagnostic.canceledResources++;
          diagnostic.lastCanceledType = resource.type;
          diagnostic.lastCanceledSource = resource.source;
          diagnostic.lastCanceledAfterMs = Math.round(performance.now() - started);
        }
      } else if (!(resource?.pat401 && params.errorText === "net::ERR_HTTP_RESPONSE_CODE_FAILURE"))
        recordFailure(resource, params.errorText);
    }
    if (method === "Network.loadingFailed" || method === "Network.loadingFinished")
      resources.delete(resourceKey);
    if (method === "Fetch.requestPaused") {
      const request = params.request as { url: string };
      let allow = params.resourceType === "Document" && samePage(request.url);
      if (params.resourceType === "Document" && params.frameId !== frame) {
        try {
          const target = new URL(request.url);
          allow =
            target.protocol === "https:" &&
            !target.username &&
            !target.password &&
            (target.origin === expected.origin || target.hostname === "challenges.cloudflare.com");
        } catch {
          /* 无效子文档保持拒绝。 */
        }
      }
      if (allow) send("Fetch.continueRequest", { requestId: params.requestId }, sessionId);
      else {
        send(
          "Fetch.failRequest",
          { requestId: params.requestId, errorReason: "BlockedByClient" },
          sessionId,
        );
        if (params.resourceType === "Document" && params.frameId === frame)
          failed = new CatalogBrowserError(
            "navigation_rejected",
            "作品来源跳转到了其他页面，已自动结束读取。",
          );
      }
    } else if (method === "Network.requestWillBeSent") {
      if (++requests > 128)
        failed = new CatalogBrowserError("request_limit", "作品页面请求过多，已自动结束读取。");
      if (requests <= 128)
        resources.set(resourceKey, {
          type: String(params.type),
          source: resourceSource((params.request as { url?: unknown } | undefined)?.url),
          failed: false,
          pat401: false,
        });
      if (sessionId === session && params.type === "Document" && params.frameId === frame) {
        documentRequest = typeof params.requestId === "string" ? params.requestId : "";
        generation++;
        status = 0;
        context = undefined;
        responseLoader = "";
      }
    } else if (
      method === "Network.loadingFailed" &&
      sessionId === session &&
      documentRequest &&
      params.requestId === documentRequest
    ) {
      if (isCanceled(params)) {
        // 自动重载可以先取消旧导航，再发起新文档。继续等待，但不能读取被取消的页面。
        generation++;
        status = 0;
        context = undefined;
        responseLoader = "";
      } else failed = networkFailure(params.errorText);
    } else if (method === "Page.frameNavigated" && sessionId === session) {
      const document = params.frame as { id: string; parentId?: string; loaderId: string };
      if (!document.parentId) {
        frame = document.id;
        committedLoader = document.loaderId;
        generation++;
        context = undefined;
      }
    } else if (
      sessionId === session &&
      (method === "Runtime.executionContextsCleared" ||
        (method === "Runtime.executionContextDestroyed" && params.executionContextId === context))
    ) {
      generation++;
      context = undefined;
    } else if (
      method === "Network.responseReceived" &&
      sessionId === session &&
      params.type === "Document" &&
      (params.frameId === frame || (documentRequest && params.requestId === documentRequest))
    ) {
      const response = params.response as {
        url: string;
        status: number;
        headers?: Record<string, unknown>;
      };
      if (!samePage(response.url)) {
        failed = new CatalogBrowserError(
          "navigation_rejected",
          "作品来源页面不匹配，已自动结束读取。",
        );
        return;
      }
      status = response.status;
      responseLoader = typeof params.loaderId === "string" ? params.loaderId : "";
      context = undefined;
      const challenge = Object.entries(response.headers ?? {}).some(
        ([key, value]) => key.toLowerCase() === "cf-mitigated" && value === "challenge",
      );
      challenged = challenge;
      reportResponse?.({ status, challenge });
      if (challenge) advance("verifying");
      if (status === 403 && !challenge) failed = denied();
      else if (status === 401) failed = interaction("authentication_required");
      else if (status === 429)
        failed = new CatalogBrowserError("rate_limited", "作品来源请求过于频繁，请稍后重试。");
      else if (status >= 400 && !challenge)
        failed = new CatalogBrowserError("http_error", `作品来源响应异常（HTTP ${status}）。`);
    } else if (method === "Page.javascriptDialogOpening") {
      send("Page.handleJavaScriptDialog", { accept: false }, sessionId);
      failed = interaction("dialog_required");
    }
  };
  const unsubscribe = cdp.on(onEvent);
  try {
    // 环境信息仅用于诊断，无法读取不影响作品流程。
    void original
      .send("Browser.getVersion")
      .then((value) => detail.engine(value.product))
      .catch(() => {});
    await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" });
    for (const name of ["geolocation", "notifications", "camera", "microphone"])
      await cdp.send("Browser.setPermission", { permission: { name }, setting: "denied" });
    const targets = (await cdp.send("Target.getTargets")).targetInfos as {
      type: string;
      targetId: string;
    }[];
    const target = targets.find((item) => item.type === "page");
    if (!target) throw new CatalogBrowserError("missing_target", "无法初始化隐藏作品窗口。");
    session = String(
      (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true }))
        .sessionId,
    );
    await configure(session);
    await cdp.send("Page.enable", {}, session);
    const tree = (await cdp.send("Page.getFrameTree", {}, session)).frameTree as {
      frame: { id: string };
    };
    frame = tree.frame.id;
    await cdp.send(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source:
          "window.open=()=>null;document.addEventListener('play',e=>{if(e.target instanceof HTMLMediaElement){e.target.muted=true;e.target.pause()}},true);",
      },
      session,
    );
    advance("requesting");
    const navigation = await cdp.send("Page.navigate", { url }, session);
    if (navigation.errorText && !isCanceled(navigation)) throw networkFailure(navigation.errorText);
    reading: while (true) {
      signal.throwIfAborted();
      if (failed) throw failed;
      if (challenged) {
        detail.sample(original, signal);
        if (
          !interactionPending &&
          performance.now() >= nextInteractionProbe &&
          challengeFrames.size
        ) {
          interactionPending = true;
          nextInteractionProbe = performance.now() + 1500;
          const checkingGeneration = generation;
          void (async () => {
            for (const id of [...challengeFrames].slice(0, 8)) {
              if (finished || signal.aborted || !challenged || generation !== checkingGeneration)
                return;
              const result = await inspectChallengeInteraction(original, id, signal);
              if (finished || signal.aborted || !challenged || generation !== checkingGeneration)
                return;
              if (result === "required" && challengeFrames.has(id)) {
                diagnostic.challengeInteraction = "required";
                failed = interaction();
                return;
              }
            }
          })().finally(() => {
            interactionPending = false;
          });
        }
      }
      const readingGeneration = generation;
      // 收到响应头不代表新文档已经提交；不能从上一张验证页的执行环境读取正文。
      if (
        (status === 200 || (status > 0 && challenged)) &&
        (!responseLoader || responseLoader === committedLoader)
      ) {
        if (!challenged) advance("extracting");
        try {
          if (context === undefined) {
            const created = await cdp.send(
              "Page.createIsolatedWorld",
              { frameId: frame, worldName: "JAVM catalog" },
              session,
            );
            if (generation !== readingGeneration) continue;
            context = Number(created.executionContextId);
          }
          const readingContext = context;
          const snapshot = await cdp.send(
            "Runtime.evaluate",
            {
              contextId: context,
              returnByValue: true,
              expression: `(()=>{
            const href=location.href.slice(0,8193);
            if(document.querySelector('input[type="password"],input[name="captcha"],.g-recaptcha,#challenge-form input[type="checkbox"]'))return {href,interaction:true};
            if(${challenged})return {href};
            if(document.readyState==='loading')return {href};
            const main=document.querySelector('main');
            if(!main)return {href};
            const data=document.querySelector('script#__NEXT_DATA__');
            globalThis.__javmCatalogPage=main.outerHTML+(data?data.outerHTML:'');
            return {href,length:globalThis.__javmCatalogPage.length,bytes:new TextEncoder().encode(globalThis.__javmCatalogPage).byteLength};
          })()`,
            },
            session,
          );
          if (generation !== readingGeneration) continue;
          const value = (
            snapshot.result as {
              value?: { href?: string; length?: number; bytes?: number; interaction?: boolean };
            }
          )?.value;
          if (value && (typeof value.href !== "string" || !samePage(value.href)))
            throw new CatalogBrowserError(
              "navigation_rejected",
              "作品来源页面不匹配，已自动结束读取。",
            );
          if (value?.interaction) throw interaction();
          if (!challenged && status === 200 && value?.length) {
            if (
              !Number.isSafeInteger(value.length) ||
              value.length > CATALOG_BYTES ||
              !Number.isSafeInteger(value.bytes) ||
              value.bytes! > CATALOG_BYTES
            )
              throw new CatalogBrowserError("response_too_large", "作品页面超过大小限制。");
            const chunks: string[] = [];
            // 分块传回，避免单条 CDP 消息超过 1 MiB；内容随后仍交给目录 Worker 解析。
            for (let offset = 0; offset < value.length; offset += 32768) {
              signal.throwIfAborted();
              if (failed) throw failed;
              const response = await cdp.send(
                "Runtime.evaluate",
                {
                  contextId: readingContext,
                  returnByValue: true,
                  expression: `globalThis.__javmCatalogPage.slice(${offset},${Math.min(offset + 32768, value.length)})`,
                },
                session,
              );
              if (generation !== readingGeneration) continue reading;
              const chunk = (response.result as { value?: unknown })?.value;
              if (
                typeof chunk !== "string" ||
                chunk.length !== Math.min(32768, value.length - offset)
              )
                throw new CatalogBrowserError("read_interrupted", "作品页面读取中断，请重试。");
              chunks.push(chunk);
            }
            signal.throwIfAborted();
            return chunks.join("");
          }
        } catch (error) {
          signal.throwIfAborted();
          if (failed) throw failed;
          // 验证完成时会重载并销毁旧执行环境；仅该情形继续等待新文档。
          if (generation === readingGeneration) throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    finished = true;
    unsubscribe();
    diagnostic.requests = requests;
    diagnostic.blockedResourceTypes = [...blockedTypes].sort().join(",");
    diagnostic.detail = detail.finish();
    reportDiagnostics?.({ ...diagnostic });
  }
}
