import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CdpConnection } from "../../frontend/src/services/streamResolution/cdp";
import type { CdpEvent } from "../../frontend/src/services/streamResolution/cdp";
import { hiddenWebviewConfig } from "../../frontend/src/platform/neutralino/hiddenWebview";
import { quoteWindowsArgument } from "../../frontend/src/platform/neutralino/process";

export interface SafeBrowserReply {
  status?: number;
  type?: string;
  headers?: Record<string, string>;
  body: string;
  failure?: "Aborted" | "ConnectionFailed";
}
type Pattern = { resourceType?: string; requestStage?: string };
type Paused = { requestId: string; request: { url: string }; resourceType: string };

/** 真正的隐藏 WebView2，但所有请求均由安全 fixture 响应；DNS 失败是第二道隔离。 */
export async function withSafeCatalogBrowser<T>(
  route: (url: URL) => SafeBrowserReply | undefined,
  run: (browser: Pick<CdpConnection, "send" | "on">, signal: AbortSignal) => Promise<T>,
) {
  const project = path.resolve(import.meta.dirname, "../..");
  const root = await mkdtemp(path.join(project, ".tmp/catalog-browser-safe-"));
  const config = hiddenWebviewConfig("http://127.0.0.1:1", "");
  config.modes.window.webviewArgs +=
    ' --host-resolver-rules="MAP * ~NOTFOUND" --disable-background-networking';
  await writeFile(path.join(root, "neutralino.config.json"), JSON.stringify(config));
  // 在正式启动器的挂起/恢复之间安装只读观察器，覆盖创建初期的短暂显示。
  const launcherSource = await readFile(
    path.join(project, "frontend/src/platform/neutralino/hiddenProcess.ps1"),
    "utf8",
  );
  const monitor = await readFile(
    path.join(project, "tests/helpers/hiddenWindowMonitor.cs"),
    "utf8",
  );
  await writeFile(
    path.join(root, "launch.ps1"),
    "\uFEFF" +
      launcherSource
        .replace(
          "process=info.process;",
          "process=info.process; SafeWindowMonitor.Start(info.pid);",
        )
        .replace(
          "return WaitForSingleObject(process,milliseconds)==0;",
          "SafeWindowMonitor.Sample(); return WaitForSingleObject(process,milliseconds)==0;",
        )
        .replace(
          "public sealed class JavmHiddenJob",
          `${monitor.replace(/using System(?:\.Runtime\.InteropServices)?;\r?\n/g, "")}\npublic sealed class JavmHiddenJob`,
        )
        .replace(
          "while (!$javmBrowser.Wait(100)) {",
          `while (!$javmBrowser.Wait(100)) {
    [IO.File]::WriteAllText((Join-Path (Split-Path -LiteralPath $Config) 'visibility.json'), (@{samples=[SafeWindowMonitor]::Samples;visible=[SafeWindowMonitor]::VisibleSamples;shows=[SafeWindowMonitor]::ShowEvents} | ConvertTo-Json -Compress))`,
        )
        .replace(
          "$javmOwner.Dispose()",
          `
  [SafeWindowMonitor]::Stop()
  [IO.File]::WriteAllText((Join-Path (Split-Path -LiteralPath $Config) 'visibility.json'), (@{samples=[SafeWindowMonitor]::Samples;visible=[SafeWindowMonitor]::VisibleSamples;shows=[SafeWindowMonitor]::ShowEvents} | ConvertTo-Json -Compress))
  $javmOwner.Dispose()`,
        ),
  );
  await writeFile(
    path.join(root, "launch.json"),
    JSON.stringify({
      file: process.env.JAVM_WEBVIEW_EXE || path.join(project, "bin/neutralino-win_x64.exe"),
      arguments: ["--res-mode=directory", `--path=${root}`].map(quoteWindowsArgument).join(" "),
      profile: path.join(root, "profile"),
      ownerPid: process.pid,
      timeoutMs: 16000,
    }),
  );
  const launcher = spawn(
    path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "launch.ps1"),
      "-Config",
      path.join(root, "launch.json"),
    ],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  let launchError = "";
  launcher.stderr.on("data", (value) => {
    launchError = (launchError + String(value)).slice(-4000);
  });
  let exited = false;
  const exit = new Promise<void>((resolve, reject) => {
    launcher.once("error", reject);
    launcher.once("exit", () => {
      exited = true;
      resolve();
    });
  });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("Safe browser deadline")), 14000);
  let connection: CdpConnection | undefined;
  try {
    while (!connection) {
      abort.signal.throwIfAborted();
      if (exited) throw new Error("Safe browser exited before connecting");
      for (const relative of [
        "profile/EBWebView/DevToolsActivePort",
        "profile/DevToolsActivePort",
      ]) {
        const active = await readFile(path.join(root, relative), "utf8").catch(() => "");
        if (!active) continue;
        const [port, endpoint] = active.trim().split(/\r?\n/);
        connection = await CdpConnection.connect(`ws://127.0.0.1:${port}${endpoint}`, abort.signal);
        break;
      }
      if (!connection) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const cdp = connection;
    const patterns = new Map<string | undefined, Pattern[]>();
    const targetTypes = new Map<string, string>();
    const pending = new Map<string, { event: CdpEvent; request: Paused }>();
    const fulfill = async (event: CdpEvent, request: Paused) => {
      const reply = route(new URL(request.request.url));
      if (!reply)
        throw new Error(
          `Unexpected safe fixture request: ${new URL(request.request.url).pathname}`,
        );
      if (reply.failure)
        return cdp.send(
          "Fetch.failRequest",
          { requestId: request.requestId, errorReason: reply.failure },
          event.sessionId,
        );
      return cdp.send(
        "Fetch.fulfillRequest",
        {
          requestId: request.requestId,
          responseCode: reply.status ?? 200,
          responseHeaders: Object.entries({
            "Content-Type": reply.type ?? "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            ...reply.headers,
          }).map(([name, value]) => ({ name, value })),
          body: Buffer.from(reply.body).toString("base64"),
        },
        event.sessionId,
      );
    };
    const listeners = new Set<(event: CdpEvent) => void>();
    const unsubscribe = cdp.on((event) => {
      if (event.method === "Target.attachedToTarget")
        targetTypes.set(
          String(event.params.sessionId),
          String((event.params.targetInfo as { type: string }).type),
        );
      if (event.method === "Fetch.requestPaused") {
        const request = event.params as unknown as Paused;
        const intercepted = (patterns.get(event.sessionId) ?? []).some(
          (pattern) =>
            (!pattern.requestStage || pattern.requestStage === "Request") &&
            (!pattern.resourceType || pattern.resourceType === request.resourceType),
        );
        if (!intercepted) {
          void fulfill(event, request).catch((error: unknown) => abort.abort(error));
          return;
        }
        pending.set(`${event.sessionId}:${request.requestId}`, { event, request });
      }
      for (const listener of listeners) listener(event);
    });
    try {
      return await run(
        {
          on(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async send(method, params = {}, sessionId) {
            if (method === "Fetch.enable") {
              patterns.set(sessionId, (params.patterns ?? []) as Pattern[]);
              return cdp.send(method, { patterns: [{ requestStage: "Request" }] }, sessionId);
            }
            if (method === "Fetch.continueRequest") {
              const key = `${sessionId}:${String(params.requestId)}`;
              const paused = pending.get(key);
              if (!paused) throw new Error("Missing safe fixture interception");
              pending.delete(key);
              return fulfill(paused.event, paused.request);
            }
            if (method === "Fetch.failRequest")
              pending.delete(`${sessionId}:${String(params.requestId)}`);
            // 初始 Worker 脚本在父页面拦截；Worker 内不注入其不支持的 Fetch 域。
            if (
              method === "Network.enable" &&
              !["worker", "shared_worker", "service_worker"].includes(
                targetTypes.get(sessionId ?? "") ?? "",
              )
            ) {
              await cdp.send(
                "Fetch.enable",
                { patterns: [{ requestStage: "Request" }] },
                sessionId,
              );
            }
            return cdp.send(method, params, sessionId);
          },
        },
        abort.signal,
      );
    } finally {
      unsubscribe();
    }
  } finally {
    clearTimeout(timer);
    await connection?.send("Browser.close").catch(() => {});
    connection?.close();
    abort.abort();
    const stop = setTimeout(() => launcher.kill(), 3000);
    try {
      await exit;
    } finally {
      clearTimeout(stop);
    }
    const temporary = path.resolve(project, ".tmp");
    if (
      path.dirname(root) !== temporary ||
      !path.basename(root).startsWith("catalog-browser-safe-")
    )
      // oxlint-disable-next-line no-unsafe-finally -- 路径校验失败必须阻止递归清理及测试成功。
      throw new Error("Unsafe temporary root");
    try {
      const visibility = JSON.parse(
        await readFile(path.join(root, "visibility.json"), "utf8").catch(() => {
          throw new Error(`Missing hidden window observation: ${launchError}`);
        }),
      ) as {
        samples: number;
        visible: number;
        shows: number;
      };
      if (!visibility.samples || visibility.visible || visibility.shows)
        // oxlint-disable-next-line no-unsafe-finally -- 即使读取成功，也不能接受显示过窗口的测试结果。
        throw new Error(`Hidden window observation failed: ${JSON.stringify(visibility)}`);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
}
