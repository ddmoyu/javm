import { filesystem, os } from "@neutralinojs/lib";
import type { ResolutionRequest } from "../../contracts/streamResolution";
import type { ResolutionWebviewPort, StreamCandidate } from "../../services/streamResolution/ports";
import { installCapture } from "../../services/streamResolution/capturePage";
import {
  bounds,
  check,
  normalizeRequest,
  ResolutionError,
  webUrl,
} from "../../services/streamResolution/shared";
import { StopUnconfirmedError } from "../../services/downloads/ports";
import { runNativeProcess } from "./process";
import { executableExists } from "./toolPaths";

// The isolated page receives no auth globals or official client library. Its
// WebKit message channel emits bounded candidates through the host's existing
// official event channel, without adding a business server or an extension.
export function posixHiddenConfig(url: string) {
  return {
    applicationId: "net.ddmoyu.javm.resolver",
    defaultMode: "window",
    url: webUrl(url),
    port: 0,
    enableServer: true,
    enableNativeAPI: true,
    enableExtensions: false,
    exportAuthInfo: true,
    tokenSecurity: "one-time",
    dataLocation: "app",
    storageLocation: "app",
    logging: { enabled: false },
    nativeAllowList: ["app.exit"],
    modes: {
      window: {
        title: "JAVM",
        width: 800,
        height: 600,
        hidden: true,
        skipTaskbar: true,
        useSavedState: false,
        enableInspector: false,
        injectGlobals: false,
        injectClientLibrary: false,
        injectScript: "/capture.js",
        exitProcessOnClose: true,
        newWindowPolicy: "custom",
        webviewArgs: "--javm-isolated",
      },
    },
  };
}

export function posixCaptureScript(request: ResolutionRequest) {
  const rule = JSON.stringify(request.failRule ?? null);
  return `${installCapture};\n(()=>{
    const channel=globalThis.webkit?.messageHandlers?.javmCapture;
    if(!channel)return;
    const started=Date.now(); let count=0;
    const timer=setInterval(()=>{
      if(Date.now()-started>19000||count++>80){clearInterval(timer);return}
      try {
        const result=globalThis.__javmStreamCapture.read(${rule},false);
        if(!result.missing&&!result.interaction&&!result.urls?.length)return;
        const text=JSON.stringify({...result,userAgent:navigator.userAgent.slice(0,1024)});
        if(text.length<=160000)channel.postMessage(text);
      } catch {}
    },250);
    addEventListener('pagehide',()=>{clearInterval(timer)},{once:true});
  })();`;
}

/** Remote page messages are untrusted; only bounded public URL context crosses the boundary. */
export function readPosixCandidates(raw: unknown): {
  candidates: StreamCandidate[];
  failure?: "not_found" | "interaction_required";
} {
  if (!raw || typeof raw !== "object") return { candidates: [] };
  const value = raw as Record<string, unknown>;
  if (value.missing === true) return { candidates: [], failure: "not_found" };
  if (value.interaction === true) return { candidates: [], failure: "interaction_required" };
  const page = typeof value.pageUrl === "string" ? webUrl(value.pageUrl) : undefined;
  if (!page || !Array.isArray(value.urls)) return { candidates: [] };
  const userAgent =
    typeof value.userAgent === "string" &&
    value.userAgent.length <= 1024 &&
    !/[\r\n\0]/.test(value.userAgent)
      ? value.userAgent
      : "";
  const candidates: StreamCandidate[] = [];
  for (const rawUrl of value.urls.slice(0, bounds.candidates)) {
    try {
      if (typeof rawUrl !== "string") continue;
      const url = webUrl(rawUrl);
      if (candidates.some((item) => item.url === url)) continue;
      candidates.push({
        url,
        publicHeaders: {
          referer: page,
          origin: new URL(page).origin,
          ...(userAgent ? { "user-agent": userAgent } : {}),
        },
      });
    } catch {
      /* Malformed page data never becomes a tool argument. */
    }
  }
  return { candidates };
}

export const createPosixHiddenWebview =
  (): ResolutionWebviewPort => async (input, signal, proxy) => {
    check(signal);
    const request = normalizeRequest(input);
    if (!(window as unknown as { NL_COMMIT: string }).NL_COMMIT?.endsWith("+javm-posix"))
      throw new ResolutionError("unavailable");
    // macOS 13 WKWebView has no public per-view proxy API. Do not silently bypass it.
    if (proxy) {
      const error = new ResolutionError("unavailable");
      error.message = "当前系统隐藏浏览器不支持独立代理，请使用 HTTP 解析或关闭应用代理后重试。";
      throw error;
    }
    if (
      Object.keys(request.headers ?? {}).length ||
      Object.keys(request.publicHeaders ?? {}).length
    )
      throw new ResolutionError("session_required");
    const appPath = (window as unknown as { NL_PATH: string }).NL_PATH;
    if (!appPath?.startsWith("/") || /[\0\r\n]/.test(appPath))
      throw new ResolutionError("unavailable");
    const architecture = (window as unknown as { NL_ARCH: string }).NL_ARCH;
    const name =
      window.NL_OS === "Linux"
        ? "neutralino-linux_x64"
        : `neutralino-mac_${architecture === "arm64" || architecture === "arm" ? "arm64" : "x64"}`;
    let executable = "";
    for (const candidate of [`${appPath}/JAVM-host`, `${appPath}/bin/${name}`]) {
      if (await executableExists(candidate)) {
        executable = candidate;
        break;
      }
    }
    if (!executable) throw new ResolutionError("unavailable");
    const root = `${await os.getPath("temp")}/javm-webview-${crypto.randomUUID()}`;
    await filesystem.createDirectory(root);
    await filesystem.chmod(root, 0o700);
    const abort = new AbortController();
    const cancel = () => abort.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const timer = setTimeout(() => abort.abort(new ResolutionError("timeout")), bounds.webviewMs);
    let socket: WebSocket | undefined;
    let run: ReturnType<typeof runNativeProcess> | undefined;
    let finished = false,
      processError: unknown;
    const candidates: StreamCandidate[] = [];
    let candidateAt = 0,
      failed: unknown;
    let deferred = false;
    const cleanup = async () => {
      try {
        await filesystem.remove(root);
      } catch (error) {
        if ((error as { code?: string }).code !== "NE_FS_NOPATHE")
          throw new StopUnconfirmedError(cleanup);
      }
    };
    try {
      await filesystem.createDirectory(`${root}/.tmp`);
      await filesystem.writeFile(
        `${root}/neutralino.config.json`,
        JSON.stringify(posixHiddenConfig(request.url)),
      );
      await filesystem.writeFile(`${root}/capture.js`, posixCaptureScript(request));
      check(abort.signal);
      run = runNativeProcess(
        executable,
        ["--res-mode=directory", `--path=${root}`],
        abort.signal,
        undefined,
        true,
      );
      void run.then(
        () => {
          finished = true;
        },
        (error: unknown) => {
          finished = true;
          processError = error;
        },
      );
      while (!socket) {
        check(abort.signal);
        if (finished) throw processError ?? new ResolutionError("unavailable");
        let auth: { nlPort: number; nlConnectToken: string } | undefined;
        try {
          const file = `${root}/.tmp/auth_info.json`;
          if ((await filesystem.getStats(file)).size > 4096)
            throw new ResolutionError("unavailable");
          auth = JSON.parse(await filesystem.readFile(file)) as typeof auth;
        } catch (error) {
          if (
            !(error instanceof SyntaxError) &&
            (error as { code?: string }).code !== "NE_FS_NOPATHE"
          )
            throw error;
        }
        if (
          auth &&
          Number.isInteger(auth.nlPort) &&
          auth.nlPort > 0 &&
          auth.nlPort <= 65535 &&
          typeof auth.nlConnectToken === "string"
        ) {
          socket = new WebSocket(
            `ws://127.0.0.1:${auth.nlPort}/?connectToken=${encodeURIComponent(auth.nlConnectToken)}`,
          );
          socket.addEventListener("message", (event: MessageEvent<unknown>) => {
            if (typeof event.data !== "string" || event.data.length > 160_000) return;
            try {
              const message = JSON.parse(event.data) as { event?: string; data?: unknown };
              if (message.event !== "javmResolutionCandidate") return;
              const result = readPosixCandidates(message.data);
              if (result.failure) {
                failed = new ResolutionError(result.failure);
                return;
              }
              for (const candidate of result.candidates)
                if (
                  candidates.length < bounds.candidates &&
                  !candidates.some((item) => item.url === candidate.url)
                )
                  candidates.push(candidate);
              if (candidates.length && !candidateAt) candidateAt = performance.now();
            } catch {
              /* Ignore malformed remote frames. */
            }
          });
          socket.addEventListener("error", () => {
            failed = new ResolutionError("unavailable");
          });
        }
        if (!socket) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      while (!candidateAt || performance.now() - candidateAt < 1500) {
        check(abort.signal);
        if (failed) throw failed;
        if (finished) throw processError ?? new ResolutionError("unavailable");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return candidates;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      socket?.close();
      abort.abort();
      try {
        await run;
      } catch (error) {
        if (error instanceof StopUnconfirmedError) {
          deferred = true;
          // oxlint-disable-next-line no-unsafe-finally -- Do not report success before owned processes are reaped.
          throw new StopUnconfirmedError(async () => {
            await error.retry();
            await cleanup();
          });
        }
      } finally {
        if (!deferred) await cleanup();
      }
    }
  };
