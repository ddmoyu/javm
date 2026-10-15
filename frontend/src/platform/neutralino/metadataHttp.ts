import { filesystem, os } from "@neutralinojs/lib";
import { JsonHttpError } from "../../services/metadata/shared";
import type { JsonHttp, Store } from "../../services/metadata/shared";
import type { NetworkSettingsService } from "../../services/network/NetworkSettingsService";
import { encodedPowerShell } from "./process";
import { requestHttp } from "./http";
import { playbackStorage } from "./playbackSettings";
import { StopUnconfirmedError } from "../../services/downloads/ports";
import { NativeLibraryPort } from "./library";
import { toolPlatform } from "./toolPaths";

export const psString = (value: string) => `'${value.replaceAll("'", "''")}'`;
export async function runPowerShell(
  script: string,
  signal: AbortSignal,
  errors: Record<number, string> = {},
) {
  signal.throwIfAborted();
  // 有界的本地校验、解压与端口分配直接走官方异步 API。
  // Windows PowerShell 在无控制台的嵌套 ProcessStartInfo 中可能无法启动；
  // 这些短操作执行期间等待收尾，下载和常驻服务仍由可取消的监督器管理。
  const result = await os.execCommand(encodedPowerShell(script));
  signal.throwIfAborted();
  if (result.exitCode !== 0)
    throw new Error(errors[result.exitCode] ?? "本地工具操作失败，请检查目录权限和程序状态。");
  return result.stdOut.trim();
}
async function crypt(value: string, decrypt: boolean) {
  // 密钥经官方 stdIn 输入，既不放在命令行，也不写明文临时文件。
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $r=[Security.Cryptography.ProtectedData]::${decrypt ? "Unprotect" : "Protect"}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($r));`;
  const input = decrypt ? value : btoa(String.fromCharCode(...new TextEncoder().encode(value)));
  const result = await os.execCommand(encodedPowerShell(script), { stdIn: input });
  if (result.exitCode !== 0)
    throw new Error("无法读取或保护密钥，请使用原 Windows 用户，或重新保存配置。");
  const encoded = result.stdOut.trim();
  return decrypt
    ? new TextDecoder().decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)))
    : encoded;
}
export function protectedSettingsStore<T>(key: string): Store<T> {
  // macOS/Linux 只通过官方 Extension 访问系统密钥库，不回退明文 storage。
  const port = new NativeLibraryPort();
  const storage = playbackStorage<{ version: number; protected: string }>(key);
  return {
    async read() {
      if (toolPlatform() !== "Windows") {
        const value = await port.request<string | null>("platform.credentials.read", { key });
        if (value === null) return null;
        if (typeof value !== "string" || value.length > 80000) throw new Error("无效的服务配置。");
        return JSON.parse(value) as unknown;
      }
      const value = await storage.read();
      if (value === null) return null;
      const envelope = value as { version: number; protected: string };
      if (
        envelope.version !== 1 ||
        typeof envelope.protected !== "string" ||
        envelope.protected.length > 100000
      )
        throw new Error("无效的服务配置。");
      return JSON.parse(await crypt(envelope.protected, true)) as unknown;
    },
    async write(value) {
      const input = JSON.stringify(value);
      if (input.length > 20000) throw new Error("服务配置过大。");
      if (toolPlatform() !== "Windows") {
        await port.request("platform.credentials.write", { key, value: input });
        return;
      }
      await storage.write({ version: 1, protected: await crypt(input, false) });
    },
  };
}
export function createMetadataHttp(network: NetworkSettingsService): JsonHttp {
  let active = 0;
  return async (request, signal) => {
    if (active >= 4) throw new Error("服务请求已达并发上限，请稍后重试。");
    ++active;
    let directory = "";
    let deferredCleanup = false;
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      if (directory) await filesystem.remove(directory).catch(() => {});
      --active;
    };
    try {
      signal.throwIfAborted();
      directory = `${await os.getPath("temp")}/javm-metadata-${crypto.randomUUID()}`;
      await filesystem.createDirectory(directory);
      const headers = Object.entries({
        Accept: "application/json",
        "Content-Type": "application/json",
        ...request.headers,
      });
      if (headers.some(([key, value]) => /[\r\n]/.test(key + value)))
        throw new Error("请求头格式无效。");
      const url = new URL(request.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("服务地址无效。");
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      const proxy = local ? "" : await network.getProxy();
      const payload = request.body === undefined ? undefined : JSON.stringify(request.body);
      if (payload && payload.length > 64000) throw new Error("请求内容过长，请缩短资料后重试。");
      const result = await requestHttp(
        {
          purpose: "metadata",
          url: request.url,
          proxy,
          output: `${directory}/response`,
          method: request.method ?? "GET",
          body: payload,
          headers: Object.fromEntries(headers),
          maxBytes: 1048576,
          timeoutMs: (request.timeout ?? 45) * 1000,
        },
        signal,
      );
      signal.throwIfAborted();
      if (result.exitCode !== 0)
        throw new Error(
          result.exitCode === 28
            ? "服务请求超时，请检查网络或稍后重试。"
            : result.exitCode === 63
              ? "服务响应超过大小限制。"
              : "无法连接资料服务，请检查地址、网络与代理。",
        );
      const status = result.status;
      if (status === 401 || status === 403)
        throw new Error(
          request.headers?.Authorization
            ? "服务拒绝访问，请检查 API Key 或访问令牌。"
            : `服务拒绝访问（HTTP ${status}），请检查访问限制或稍后重试。`,
        );
      if (status === 429) throw new Error("服务请求限额已用尽或过于频繁，请稍后重试。");
      if (status < 200 || status >= 300 || !Number.isFinite(status))
        throw new JsonHttpError(
          status,
          `服务返回 HTTP ${status || "未知"}，请检查基础地址和服务状态。`,
        );
      const stat = await filesystem.getStats(`${directory}/response`);
      if (!stat.isFile || stat.size > 1048576) throw new Error("服务响应过大。");
      const body = await filesystem.readFile(`${directory}/response`);
      signal.throwIfAborted();
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new Error("服务未返回有效 JSON。");
      }
    } catch (error) {
      if (error instanceof StopUnconfirmedError) {
        deferredCleanup = true;
        throw new StopUnconfirmedError(async () => {
          await error.retry();
          await cleanup();
        });
      }
      throw error;
    } finally {
      if (!deferredCleanup) await cleanup();
    }
  };
}
