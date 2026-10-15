import { filesystem, os } from "@neutralinojs/lib";
import hiddenLauncher from "./hiddenProcess.ps1?raw";
import { encodedPowerShell, quoteWindowsArgument, runNativeProcess } from "./process";
import { StopUnconfirmedError } from "../../services/downloads/ports";
import { bounds, check, ResolutionError } from "../../services/streamResolution/shared";
import type { ResolutionWebviewPort } from "../../services/streamResolution/ports";
import { CdpConnection } from "../../services/streamResolution/cdp";
import { captureStreams } from "../../services/streamResolution/capture";

export type HiddenWebviewStage = "launch" | "connect" | "read";
export class HiddenWebviewError extends ResolutionError {
  constructor(
    code: ResolutionError["code"],
    readonly stage: HiddenWebviewStage,
  ) {
    super(code);
    this.name = "HiddenWebviewError";
  }
}

export function hiddenWebviewConfig(origin: string, proxy: string) {
  // Browser arguments are data in a generated JSON configuration, never shell fragments.
  if (proxy && !/^(https?|socks5?):\/\/[a-z0-9.:[\]-]+(?::\d+)?\/?$/i.test(proxy))
    throw new ResolutionError("invalid_input");
  if (!/^https?:\/\/[a-z0-9.:[\]-]+(?::\d+)?$/i.test(origin))
    throw new ResolutionError("unavailable");
  return {
    applicationId: "net.ddmoyu.javm.resolver",
    defaultMode: "window",
    url: "about:blank",
    enableServer: false,
    enableNativeAPI: false,
    enableExtensions: false,
    exportAuthInfo: false,
    dataLocation: "app",
    storageLocation: "app",
    logging: { enabled: false },
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
        exitProcessOnClose: true,
        newWindowPolicy: "custom",
        // 0 仅为启动模板；hiddenProcess 在创建进程前分配非零端口，核对所属 Job 后发布端点。
        webviewArgs: `--remote-debugging-port=0 --remote-debugging-address=127.0.0.1 --remote-allow-origins=${origin} --mute-audio --blink-settings=imagesEnabled=false --autoplay-policy=no-user-gesture-required ${proxy ? `--proxy-server=${proxy} --proxy-bypass-list=localhost;127.0.0.1` : "--no-proxy-server"}`,
      },
    },
  };
}

export function createHiddenWebview(): ResolutionWebviewPort {
  return (request, signal, proxy) =>
    withHiddenWebview(signal, proxy, (cdp, boundedSignal) =>
      captureStreams(cdp, request, boundedSignal),
    );
}

// 调用方仅定义读取操作；隐藏启动、超时、取消和进程回收继续由同一宿主管理。
export async function withHiddenWebview<T>(
  signal: AbortSignal,
  proxy: string,
  read: (cdp: CdpConnection, signal: AbortSignal) => Promise<T>,
  reportStage?: (stage: HiddenWebviewStage) => void,
): Promise<T> {
  check(signal);
  const ownerPid = Number((window as unknown as { NL_PID: number }).NL_PID);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw new ResolutionError("unavailable");
  const executable = await os.execCommand(
    encodedPowerShell(
      `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::Write([Diagnostics.Process]::GetProcessById(${ownerPid}).MainModule.FileName)`,
    ),
  );
  check(signal);
  if (executable.exitCode || !(await filesystem.getStats(executable.stdOut.trim())).isFile)
    throw new ResolutionError("unavailable");
  const root = `${await os.getPath("temp")}/javm-webview-${crypto.randomUUID()}`;
  await filesystem.createDirectory(root);
  const abort = new AbortController();
  const cancel = () => abort.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  let stage: HiddenWebviewStage = "launch";
  const advance = (value: HiddenWebviewStage) => {
    stage = value;
    reportStage?.(value);
  };
  const timer = setTimeout(
    () => abort.abort(new HiddenWebviewError("timeout", stage)),
    bounds.webviewMs,
  );
  let cdp: CdpConnection | undefined,
    run: ReturnType<typeof runNativeProcess> | undefined,
    finished = false;
  let processError: unknown,
    deferred = false;
  const cleanup = async () => {
    // Profile files can remain briefly locked while the WebView2 job exits.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await filesystem.remove(root);
        return;
      } catch (error) {
        if ((error as { code?: string }).code === "NE_FS_NOPATHE") return;
        if (attempt === 19) throw new StopUnconfirmedError(cleanup);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  };
  try {
    await filesystem.writeFile(
      `${root}/neutralino.config.json`,
      JSON.stringify(hiddenWebviewConfig(location.origin, proxy)),
    );
    await filesystem.writeFile(`${root}/launch.ps1`, hiddenLauncher);
    await filesystem.writeFile(
      `${root}/launch.json`,
      JSON.stringify({
        file: executable.stdOut.trim(),
        arguments: ["--res-mode=directory", `--path=${root}`].map(quoteWindowsArgument).join(" "),
        profile: `${root}/profile`,
        ownerPid,
        timeoutMs: bounds.webviewMs,
      }),
    );
    check(abort.signal);
    advance("launch");
    run = runNativeProcess(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        `${root}/launch.ps1`,
        "-Config",
        `${root}/launch.json`,
      ],
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
    while (!cdp) {
      check(abort.signal);
      if (finished) throw processError ?? new ResolutionError("unavailable");
      for (const relative of [
        "profile/EBWebView/DevToolsActivePort",
        "profile/DevToolsActivePort",
      ]) {
        const path = `${root}/${relative}`;
        let active = "";
        try {
          const stat = await filesystem.getStats(path);
          if (stat.size > 512) throw new ResolutionError("unavailable");
          active = await filesystem.readFile(path);
        } catch (error) {
          if ((error as { code?: string }).code === "NE_FS_NOPATHE") continue;
          throw error;
        }
        const [port, endpoint] = active.trim().split(/\r?\n/);
        if (!/^\d{1,5}$/.test(port ?? "") || Number(port) < 1 || Number(port) > 65535 || !endpoint)
          throw new ResolutionError("unavailable");
        advance("connect");
        cdp = await CdpConnection.connect(`ws://127.0.0.1:${port}${endpoint}`, abort.signal);
        break;
      }
      if (!cdp) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    advance("read");
    return await read(cdp, abort.signal);
  } catch (error) {
    check(abort.signal);
    if (error instanceof ResolutionError && !(error instanceof HiddenWebviewError))
      throw new HiddenWebviewError(error.code, stage);
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    cdp?.close();
    abort.abort();
    try {
      await run;
    } catch (error) {
      if (error instanceof StopUnconfirmedError) {
        deferred = true;
        // oxlint-disable-next-line no-unsafe-finally -- 未确认回收时必须覆盖成功结果并保留清理所有权。
        throw new StopUnconfirmedError(async () => {
          await error.retry();
          await cleanup();
        });
      }
    } finally {
      if (!deferred) await cleanup();
    }
  }
}
