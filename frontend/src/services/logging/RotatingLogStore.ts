import type { LogEntry } from "./events";

export const logPolicy = { fileBytes: 5 * 1024 * 1024, files: 10, days: 7 };
export interface LogFile {
  name: string;
  size: number;
}
export interface LogFilePort {
  directory: string;
  list: () => Promise<LogFile[]>;
  append: (name: string, content: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
  tail: (name: string, bytes: number) => Promise<string>;
  openDirectory: () => Promise<void>;
}
const filename = /^javm-(\d{13})-[a-f\d]{8}-\d+\.jsonl$/;
export function isLogFile(name: string) {
  return filename.test(name);
}
const createdAt = (file: LogFile) => Number(filename.exec(file.name)?.[1] ?? 0);

export class RotatingLogStore {
  private serial: Promise<unknown> = Promise.resolve();
  private files?: LogFile[];
  private current?: LogFile;
  private sequence = 0;
  private session = crypto.randomUUID().slice(0, 8);
  constructor(
    readonly port: LogFilePort,
    readonly policy = logPolicy,
    private now = Date.now,
  ) {
    if (
      !Number.isInteger(policy.fileBytes) ||
      policy.fileBytes < 256 ||
      !Number.isInteger(policy.files) ||
      policy.files < 1 ||
      !Number.isFinite(policy.days) ||
      policy.days <= 0
    )
      throw new Error("日志保留策略无效。");
  }
  private exclusive<T>(operation: () => Promise<T>) {
    const next = this.serial.then(operation);
    this.serial = next.catch(() => {});
    return next;
  }
  private async load() {
    this.files ??= (await this.port.list())
      .filter((file) => isLogFile(file.name))
      .sort((a, b) => createdAt(a) - createdAt(b) || a.name.localeCompare(b.name));
  }
  private async prune(reserve = 0) {
    await this.load();
    const cutoff = this.now() - this.policy.days * 86400000;
    // 自己生成的名称才允许清理，目录中的其他文件永不触碰。
    for (const file of [...this.files!]) {
      if (
        createdAt(file) >= cutoff &&
        file.size <= this.policy.fileBytes &&
        this.files!.length + reserve <= this.policy.files
      )
        continue;
      await this.port.remove(file.name);
      this.files = this.files!.filter((item) => item !== file);
      if (this.current === file) this.current = undefined;
    }
  }
  maintain() {
    return this.exclusive(() => this.prune());
  }
  append(entries: LogEntry[]) {
    return this.exclusive(async () => {
      await this.prune();
      let chunk = "";
      let chunkBytes = 0;
      const write = async () => {
        if (!chunk || !this.current) return;
        try {
          await this.port.append(this.current.name, chunk);
          this.current.size += chunkBytes;
          chunk = "";
          chunkBytes = 0;
        } catch (error) {
          // 可能存在部分写入；重新读取文件大小，下一次写入换新文件。
          this.files = undefined;
          this.current = undefined;
          throw error;
        }
      };
      for (const entry of entries) {
        const line = JSON.stringify(entry) + "\n";
        const bytes = new TextEncoder().encode(line).byteLength;
        if (bytes > this.policy.fileBytes) throw new Error("单条日志超过文件上限。");
        const day = Math.floor(this.now() / 86400000);
        if (
          !this.current ||
          this.current.size + chunkBytes + bytes > this.policy.fileBytes ||
          Math.floor(createdAt(this.current) / 86400000) !== day
        ) {
          await write();
          await this.prune(1);
          this.current = {
            name: `javm-${this.now()}-${this.session}-${++this.sequence}.jsonl`,
            size: 0,
          };
          this.files!.push(this.current);
        }
        chunk += line;
        chunkBytes += bytes;
        if (chunkBytes >= 64 * 1024) await write();
      }
      await write();
    });
  }
  recent() {
    return this.exclusive(async () => {
      await this.prune();
      const entries: LogEntry[] = [];
      const seen = new Set<string>();
      // 最多读取 10 个文件的各 128 KiB 尾部，容纳带完整链接的诊断行。
      for (const file of [...this.files!].reverse()) {
        const text = await this.port.tail(file.name, 128 * 1024);
        for (const line of text.split("\n").reverse()) {
          if (!line || line.length > 96000) continue;
          try {
            const entry = JSON.parse(line) as LogEntry;
            const key = `${entry.session}:${entry.sequence}`;
            if (
              typeof entry.time === "string" &&
              Number.isFinite(Date.parse(entry.time)) &&
              typeof entry.module === "string" &&
              typeof entry.message === "string" &&
              typeof entry.session === "string" &&
              Number.isInteger(entry.sequence) &&
              ["debug", "info", "warn", "error"].includes(entry.level) &&
              !seen.has(key)
            ) {
              seen.add(key);
              entries.push(entry);
            }
          } catch {
            /* 尾部读取可能从半条记录开始；意外退出也可能留下不完整末行。 */
          }
          if (entries.length >= 200) return entries;
        }
      }
      return entries;
    });
  }
}
