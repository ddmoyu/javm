import { events, filesystem, os } from "@neutralinojs/lib";
import { StopUnconfirmedError } from "../../services/downloads/ports";
import { keepTextTail } from "../../services/downloads/text";
import { logEvent } from "../../services/logging/events";

export interface ProcessResult {
  exitCode: number;
  stdOut: string;
  stdErr: string;
}
export type ProcessRunner = (
  file: string,
  args: string[],
  signal: AbortSignal,
  output?: (chunk: string, stream: "stdout" | "stderr") => void,
  cooperativeCancel?: boolean,
  envs?: Record<string, string>,
) => Promise<ProcessResult>;

// ProcessStartInfo bypasses cmd.exe; Windows argument escaping is separate from
// PowerShell string quoting. User URLs/headers/paths never become shell syntax.
export function quoteWindowsArgument(value: string) {
  if (value.includes("\0")) throw new Error("进程参数包含无效字符。");
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}
const psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
export function encodedPowerShell(script: string) {
  script = `$ProgressPreference='SilentlyContinue'; ${script}`;
  const units = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i++) {
    units[i * 2] = script.charCodeAt(i) & 255;
    units[i * 2 + 1] = script.charCodeAt(i) >> 8;
  }
  let binary = "";
  for (const byte of units) binary += String.fromCharCode(byte);
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${btoa(binary)}`;
}
export function processCommand(
  file: string,
  args: string[],
  ownerPid?: number,
  payloadPath?: string,
  cooperativeCancel = false,
) {
  const managed = Number.isSafeInteger(ownerPid) && ownerPid! > 0;
  const owner = managed
    ? `$javmOwner=[System.Diagnostics.Process]::GetProcessById(${ownerPid});`
    : "";
  const stopping = [
    managed ? "$javmOwner.HasExited" : "",
    cooperativeCancel ? "$javmStop.IsCompleted" : "",
  ]
    .filter(Boolean)
    .join(" -or ");
  // EOF 仅表示取消进程；不传业务消息。由持有实际子进程句柄的监督器结束子进程，
  // 避免 taskkill 外层 shell 时与 curl 刚启动形成竞态、遗留占用管道的 curl。
  const cancellation = cooperativeCancel
    ? "$javmInput=[Console]::OpenStandardInput(); $javmStop=$javmInput.ReadAsync([byte[]]::new(1),0,1);"
    : "";
  const wait = stopping
    ? `while (!$child.WaitForExit(500)) { if (${stopping}) { & "$env:SystemRoot\\System32\\taskkill.exe" /PID $child.Id /T /F | Out-Null; $child.WaitForExit(); break; } };`
    : "$child.WaitForExit();";
  const argumentsText = args.map(quoteWindowsArgument).join(" ");
  if (argumentsText.length > 30000) throw new Error("下载参数过长，请精简请求头。");
  const setup = payloadPath
    ? `$javmInput=Get-Content -LiteralPath ${psLiteral(payloadPath)} -Raw -Encoding UTF8 | ConvertFrom-Json; Remove-Item -LiteralPath ${psLiteral(payloadPath)}; $p.FileName=$javmInput.file; $p.Arguments=$javmInput.arguments; if ($null -ne $javmInput.envs) { foreach ($entry in $javmInput.envs.PSObject.Properties) { $p.EnvironmentVariables[$entry.Name]=[string]$entry.Value } };`
    : `$p.FileName=${psLiteral(file)}; $p.Arguments=${psLiteral(argumentsText)};`;
  return encodedPowerShell(
    `$ErrorActionPreference='Stop'; ${owner} ${cancellation} [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $p=[System.Diagnostics.ProcessStartInfo]::new(); ${setup} $p.UseShellExecute=$false; $p.CreateNoWindow=$true; $p.RedirectStandardOutput=$true; $p.RedirectStandardError=$true; $p.RedirectStandardInput=$true; $child=[System.Diagnostics.Process]::Start($p); $child.StandardInput.Close(); $javmOut=$child.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput()); $javmErr=$child.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError()); ${wait} [void]$javmOut.GetAwaiter().GetResult(); [void]$javmErr.GetAwaiter().GetResult(); exit $child.ExitCode`,
  );
}

interface OwnedProcess {
  id: number;
  pid: number;
  cooperativeCancel?: boolean;
}
const ownerPid = () => Number((window as unknown as { NL_PID: string }).NL_PID);
const registryKey = () => `javm:download-processes:${ownerPid()}`;
function rememberedProcesses(): OwnedProcess[] {
  return JSON.parse(sessionStorage.getItem(registryKey()) || "[]") as OwnedProcess[];
}
function remember(process: OwnedProcess, add: boolean) {
  const remaining = rememberedProcesses().filter(
    (item) => item.id !== process.id || item.pid !== process.pid,
  );
  sessionStorage.setItem(registryKey(), JSON.stringify(add ? [...remaining, process] : remaining));
}
// A frontend reload must stop this session's old workers before restoring rows.
// Runtime ids + pids exclude the database extension and unrelated processes.
export async function recoverNativeProcesses() {
  const live = await os.getSpawnedProcesses();
  for (const process of rememberedProcesses()) {
    if (!live.some((item) => item.id === process.id && item.pid === process.pid)) continue;
    if (process.cooperativeCancel) {
      // 重载后的旧监听器已不存在，通过宿主进程清单确认监督器已回收子进程。
      await os.updateSpawnedProcess(process.id, "stdInEnd").catch(() => {});
      const deadline = performance.now() + 5000;
      while (
        (await os.getSpawnedProcesses()).some(
          (item) => item.id === process.id && item.pid === process.pid,
        )
      ) {
        if (performance.now() >= deadline)
          throw new Error("上次页面的下载进程尚未停止，请重试恢复下载服务。");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      continue;
    }
    const result = await os.execCommand(`taskkill.exe /PID ${process.pid} /T /F`);
    if (
      result.exitCode !== 0 &&
      (await os.getSpawnedProcesses()).some(
        (item) => item.id === process.id && item.pid === process.pid,
      )
    ) {
      throw new Error("上次页面的下载进程尚未停止，请退出并重新启动应用。");
    }
  }
  sessionStorage.removeItem(registryKey());
}

interface ProcessEvent {
  id: number;
  action: "stdOut" | "stdErr" | "exit";
  data: string | number;
}
export const runNativeProcess: ProcessRunner = async (
  file,
  args,
  signal,
  output,
  cooperativeCancel = false,
  envs,
) => {
  signal.throwIfAborted();
  let process: { id: number; pid: number } | undefined;
  let completed = false;
  let stdOut = "";
  let stdErr = "";
  const early: ProcessEvent[] = [];
  let resolve!: (value: ProcessResult) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<ProcessResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A tool may finish before spawnProcess's response arrives.
  const accept = (detail: ProcessEvent) => {
    if (!process) {
      if (early.length < 128 || detail.action === "exit") early.push(detail);
      return;
    }
    if (detail.id !== process.id || completed) return;
    if (detail.action === "exit") {
      completed = true;
      resolve({ exitCode: Number(detail.data), stdOut, stdErr });
    } else {
      const chunk = String(detail.data);
      if (detail.action === "stdOut") stdOut = keepTextTail(stdOut + chunk, 512_000);
      else stdErr = keepTextTail(stdErr + chunk, 32_000);
      output?.(chunk, detail.action === "stdOut" ? "stdout" : "stderr");
    }
  };
  const listener = (event: CustomEvent<ProcessEvent>) => accept(event.detail);
  await events.on("spawnedProcess", listener);
  let terminating = false;
  let payloadPath: string | undefined;
  const confirmStop = async () => {
    if (!process || completed) return;
    const owned = process;
    try {
      const live = await os.getSpawnedProcesses();
      if (completed || !live.some((item) => item.id === owned.id && item.pid === owned.pid)) return;
      if (cooperativeCancel) {
        await os.updateSpawnedProcess(owned.id, "stdInEnd").catch(() => {});
        const deadline = performance.now() + 5000;
        while (performance.now() < deadline) {
          if (completed) return;
          if (
            !(await os.getSpawnedProcesses()).some(
              (item) => item.id === owned.id && item.pid === owned.pid,
            )
          ) {
            completed = true;
            resolve({ exitCode: -1, stdOut, stdErr });
            return;
          }
          await new Promise((done) => setTimeout(done, 100));
        }
        throw new StopUnconfirmedError(confirmStop);
      }
      const killed = await os.execCommand(`taskkill.exe /PID ${owned.pid} /T /F`);
      if (killed.exitCode !== 0 && !completed) {
        const remaining = await os.getSpawnedProcesses();
        if (remaining.some((item) => item.id === owned.id && item.pid === owned.pid)) {
          throw new StopUnconfirmedError(confirmStop);
        }
      }
    } catch {
      throw new StopUnconfirmedError(confirmStop);
    }
  };
  const abort = () => {
    if (!process || completed || terminating) return;
    terminating = true;
    void confirmStop().catch((error: unknown) => reject(error));
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    // Avoid cmd.exe's command length limit for long signed URLs and Cookies.
    // PowerShell reads JSON as data and removes the private argument file itself.
    payloadPath = `${await os.getPath("temp")}/javm-download-${crypto.randomUUID()}.json`;
    const command = processCommand(file, args, ownerPid(), payloadPath, cooperativeCancel);
    await filesystem.writeFile(
      payloadPath,
      JSON.stringify({ file, arguments: args.map(quoteWindowsArgument).join(" "), envs }),
    );
    signal.throwIfAborted();
    // 官方 envs 会替换整个环境；仅在实际子进程上覆盖指定项，保留 PATH/SystemRoot。
    process = await os.spawnProcess(command);
    logEvent("info", "process", "started", "受管工具已启动", {
      tool: file.split(/[\\/]/).at(-1) ?? "工具",
      pid: process.pid,
    });
    remember({ ...process, cooperativeCancel }, true);
    for (const detail of early) accept(detail);
    early.length = 0;
    if (signal.aborted) abort();
    const finished = await result;
    logEvent(
      finished.exitCode && !signal.aborted ? "warn" : "info",
      "process",
      signal.aborted ? "cancelled" : "exited",
      signal.aborted ? "受管工具已停止" : "受管工具已退出",
      { tool: file.split(/[\\/]/).at(-1) ?? "工具", exitCode: finished.exitCode },
    );
    return finished;
  } catch (error) {
    logEvent(
      signal.aborted && !(error instanceof StopUnconfirmedError) ? "info" : "error",
      "process",
      "interrupted",
      "工具执行中断或未能确认停止",
      { tool: file.split(/[\\/]/).at(-1) ?? "工具" },
    );
    throw error;
  } finally {
    if (payloadPath) await filesystem.remove(payloadPath).catch(() => {});
    if (process && completed) remember(process, false);
    signal.removeEventListener("abort", abort);
    await events.off("spawnedProcess", listener);
  }
};

export async function findOnPath(name: string) {
  // 离线包优先使用随包工具；开发环境仍可使用 PATH 中的工具。
  if (!/^[a-z0-9_.-]+$/i.test(name)) throw new Error("工具名称无效。");
  const root = (window as unknown as { NL_PATH: string }).NL_PATH;
  const bundled = `${root}/bin/tools/${name}`;
  try {
    if ((await filesystem.getStats(bundled)).isFile) return bundled;
  } catch (error) {
    if ((error as { code?: string }).code !== "NE_FS_NOPATHE") throw error;
  }
  const command = encodedPowerShell(
    `$p=Get-Command -Name ${psLiteral(name)} -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::Write($p.Source) } else { exit 1 }`,
  );
  const found = await os.execCommand(command);
  return found.exitCode === 0 ? found.stdOut.trim() : "";
}
