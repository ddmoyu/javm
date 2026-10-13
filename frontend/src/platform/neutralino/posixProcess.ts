import { filesystem, os } from "@neutralinojs/lib";
import { applicationToolPath, executableExists } from "./toolPaths";

export function quotePosixArgument(value: string) {
  if (value.includes("\0")) throw new Error("进程参数包含无效字符。");
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function posixProcessPayload(file: string, args: string[], envs?: Record<string, string>) {
  if (!file.startsWith("/") || [file, ...args].some((value) => value.includes("\0")))
    throw new Error("工具路径或进程参数无效。");
  if (args.length > 1024 || Object.keys(envs ?? {}).length > 64)
    throw new Error("工具参数或环境变量过多。");
  for (const [key, value] of Object.entries(envs ?? {})) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(key) || value.includes("\0"))
      throw new Error("工具环境变量无效。");
  }
  const encoder = new TextEncoder();
  const strings = [file, ...args, ...Object.entries(envs ?? {}).flat()];
  if (strings.reduce((sum, value) => sum + encoder.encode(value).length + 1, 0) > 128 * 1024)
    throw new Error("工具参数过长，请精简请求头。");
  const payload = JSON.stringify({ schema: 1, file, args, envs: envs ?? {} });
  if (encoder.encode(payload).length > 256 * 1024) throw new Error("工具参数过长。");
  return payload;
}
export async function preparePosixProcess(
  file: string,
  args: string[],
  owner: number,
  signal: AbortSignal,
  envs?: Record<string, string>,
) {
  if (!Number.isSafeInteger(owner) || owner <= 1) throw new Error("无法确认工具所属的应用进程。");
  const payload = posixProcessPayload(file, args, envs);
  const supervisor = applicationToolPath("javm_process");
  if (!(await executableExists(supervisor)))
    throw new Error("POSIX 工具监督器缺失，请检查软件包。");
  if (!(await executableExists(file))) throw new Error("媒体工具不存在，请检查程序路径。");
  const temp = await os.getPath("temp");
  if (!temp.startsWith("/") || /[\0\r\n]/.test(temp)) throw new Error("临时目录无效。");
  const directory = `${temp.replace(/\/+$/, "")}/javm-process-${crypto.randomUUID()}`;
  const path = `${directory}/process.json`;
  let created = false;
  const cleanup = async () => {
    if (created) await filesystem.remove(directory).catch(() => {});
  };
  try {
    signal.throwIfAborted();
    await filesystem.createDirectory(directory);
    created = true;
    // 空目录先限制权限，再写入可能含令牌的参数。监督器还会检查所有者和文件类型。
    await filesystem.chmod(directory, 0o700);
    await filesystem.writeFile(path, payload);
    await filesystem.chmod(path, 0o600);
    signal.throwIfAborted();
    return {
      command: `exec ${quotePosixArgument(supervisor)} --owner ${owner} --payload ${quotePosixArgument(path)}`,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
