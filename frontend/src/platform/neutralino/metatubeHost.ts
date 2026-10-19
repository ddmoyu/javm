import { filesystem } from "@neutralinojs/lib";
import { record, text } from "../../services/metadata/shared";
import type { MetaTubeHost } from "../../services/metadata/MetaTubeService";
import type { NetworkSettingsService } from "../../services/network/NetworkSettingsService";
import { runNativeProcess } from "./process";
import { runPowerShell } from "./metadataHttp";
import { NativeLibraryPort } from "./library";
import { logEvent } from "../../services/logging/events";
import { OutputLines } from "../../services/downloads/progress";
import { metadataNetwork } from "../../services/metadata/diagnostics";
import {
  applicationToolPath,
  applicationResourcePath,
  executableExists,
  toolExecutableName,
  toolPlatform,
} from "./toolPaths";

/**
 * MetaTube 每次查询会输出一行各资料来源的耗时与结果（如 `FANZA(9s):<invalid id>`），
 * 不含标题等内容。只把这类汇总行和错误行写入应用日志，便于排查“未找到资料”。
 */
export function metatubeDiagnostic(line: string) {
  const engine = /Search keyword|Get movie|Search movie/i.test(line);
  const failure = /\b(error|panic|fatal|failed)\b/i.test(line) && !/\[GORM\]/.test(line);
  if (!engine && !failure) return undefined;
  const message = line.replace(/^\[ENGINE\]\s+\S+\s+\S+\s+\S+:\d+:\s*/, "").slice(0, 2000);
  return { level: failure && !engine ? ("warn" as const) : ("info" as const), message };
}

export function createMetaTubeHost(network: NetworkSettingsService): MetaTubeHost {
  const portService = new NativeLibraryPort();
  const root = () => `${window.NL_DATAPATH}/metatube`;
  const directory = async () => {
    try {
      await filesystem.getStats(root());
    } catch {
      await filesystem.createDirectory(root());
    }
    return root();
  };
  return {
    async bundled() {
      // The executable belongs to the application package; user data holds only its database.
      const base = applicationToolPath("tools", "metatube");
      const path = `${base}/${toolExecutableName("metatube-server")}`;
      try {
        const stats = await filesystem.getStats(path);
        if (!stats.isFile) throw new Error("内置 MetaTube 程序无效，请重新获取 JAVM 运行包。");
        if (!(await executableExists(path))) return;
        const manifestPath = applicationResourcePath("tools", "metatube", "installed.json");
        const manifest = await filesystem.getStats(manifestPath);
        if (!manifest.isFile || manifest.size > 4096)
          throw new Error("内置 MetaTube 版本记录无效，请重新获取 JAVM 运行包。");
        const entry = record(JSON.parse(await filesystem.readFile(manifestPath)) as unknown);
        const version = text(entry.version, 80);
        if (!/^v\d+\.\d+\.\d+$/.test(version))
          throw new Error("内置 MetaTube 版本记录无效，请重新获取 JAVM 运行包。");
        return { path, version };
      } catch (error) {
        if ((error as { code?: string }).code === "NE_FS_NOPATHE") return;
        throw error;
      }
    },
    async start(path, signal) {
      if (!(await filesystem.getStats(path)).isFile)
        throw new Error("内置 MetaTube 组件缺失，请完整解压或重新获取 JAVM 运行包。");
      const base = await directory();
      const port =
        toolPlatform() === "Windows"
          ? Number(
              await runPowerShell(
                "$l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); try { $l.Start(); [Console]::Write($l.LocalEndpoint.Port) } finally { $l.Stop() }",
                signal,
              ),
            )
          : (await portService.request<{ port: number }>("platform.loopbackPort")).port;
      if (!Number.isInteger(port) || port < 1024 || port > 65535)
        throw new Error("无法分配 MetaTube 本地端口。");
      const token = crypto.randomUUID() + crypto.randomUUID(),
        abort = new AbortController();
      const proxy = await network.getProxy();
      signal.throwIfAborted();
      const lines = new OutputLines();
      // 记录本次启动是否走代理（不记录代理地址与凭据），对照来源请求结果。
      logEvent(
        "info",
        "metatube",
        "network",
        proxy ? "MetaTube 通过网络代理访问资料来源" : "MetaTube 直连访问资料来源",
      );
      const exited = runNativeProcess(
        path,
        [
          "-bind",
          "127.0.0.1",
          "-port",
          String(port),
          "-token",
          token,
          "-dsn",
          `${base}/metatube.db`,
          "-request-timeout",
          "20s",
        ],
        abort.signal,
        (chunk) => {
          for (const line of lines.push(chunk)) {
            const diagnostic = metatubeDiagnostic(line);
            // stdout 不具备可靠的请求关联；新组件的逐来源诊断由对应 HTTP 响应提供。
            if (diagnostic)
              logEvent(diagnostic.level, "metatube", "legacy_engine", diagnostic.message);
          }
        },
        true,
        { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: "", NO_PROXY: "127.0.0.1,localhost" },
      ).then(() => {});
      // 进程 Promise 覆盖全部运行期，外部取消只停止本次创建的进程树。
      void exited.catch(() => {});
      return {
        endpoint: `http://127.0.0.1:${port}`,
        token,
        network: metadataNetwork(proxy),
        exited,
        isNetworkCurrent: async () => proxy === (await network.getProxy()),
        async stop() {
          abort.abort();
          await exited;
        },
      };
    },
  };
}
