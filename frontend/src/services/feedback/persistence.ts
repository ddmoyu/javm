import { restoreFeedbackState } from "./FeedbackService";
import type { FeedbackSession, FeedbackState } from "./FeedbackService";

export interface FeedbackFiles {
  list(): Promise<string[]>;
  read(name: string): Promise<string>;
  write(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
}
const reportName = /^report-(\d{16})-[a-f\d-]{36}\.json$/;
const sessionName = /^session-(\d{13})-([a-f\d-]{36})\.json$/;
export const feedbackFileLimit = 2 * 1024 * 1024;
async function digest(text: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}
async function decode(text: string) {
  if (text.length > feedbackFileLimit) throw new Error("反馈文件过大");
  const record = JSON.parse(text) as { payload?: unknown; checksum?: unknown };
  if (typeof record.payload !== "string" || record.checksum !== (await digest(record.payload)))
    throw new Error("反馈文件校验失败");
  const state = restoreFeedbackState(JSON.parse(record.payload));
  if (!state) throw new Error("反馈文件为空");
  return state;
}

/** 每次写新文件并读回校验，始终保留最近两份完整快照；运行标记独立于报告。 */
export class FeedbackJournal {
  private sequence = 0;
  private valid: string[] = [];
  private incomplete: string[] = [];
  private previousMarkers: string[] = [];
  private marker?: string;
  private message = "";
  constructor(
    private files: FeedbackFiles,
    private legacy: () => Promise<unknown> = async () => null,
  ) {}
  warning = () => this.message;
  read = async (): Promise<FeedbackState | null> => {
    const names = await this.files.list();
    this.valid = [];
    this.incomplete = [];
    this.message = "";
    const snapshots = names
      .filter((name) => reportName.test(name))
      .sort()
      .reverse();
    this.sequence = Number(reportName.exec(snapshots[0] ?? "")?.[1] ?? 0);
    this.previousMarkers = names
      .filter((name) => sessionName.test(name))
      .sort()
      .reverse();
    let latest: FeedbackState | null = null;
    // 正常写入最多留下两份完整记录和一份中断记录；限制异常目录的读取工作量。
    for (const name of snapshots.slice(0, 16)) {
      try {
        const state = await decode(await this.files.read(name));
        latest ??= state;
        this.valid.push(name);
      } catch {
        this.incomplete.push(name);
        this.message = "检测到不完整的反馈文件，已读取可恢复记录；存在完整快照时会清理损坏文件。";
      }
    }
    if (!snapshots.length && !this.previousMarkers.length) {
      try {
        latest = restoreFeedbackState(await this.legacy());
      } catch {
        this.message = "旧版反馈无法读取，原文件已保留；新的反馈将独立保存。";
      }
      return latest;
    }
    const marker = this.previousMarkers[0];
    if (marker) {
      const match = sessionName.exec(marker)!;
      // 即使标记正文写到一半，文件名仍足以证明上一会话未正常退出。
      let session: FeedbackSession = {
        id: match[2]!,
        startedAt: new Date(Number(match[1])).toISOString(),
        clean: false,
        system: latest && latest.session.id === match[2] ? latest.session.system : {},
      };
      try {
        const saved = restoreFeedbackState(JSON.parse(await this.files.read(marker)));
        if (saved?.session.id === session.id)
          session = {
            ...saved.session,
            system: { ...saved.session.system, ...session.system },
            clean: false,
          };
      } catch {
        /* 文件名中的会话信息仍然有效。 */
      }
      return { schema: 1, session, reports: latest?.reports ?? [] };
    }
    // 正常退出删除标记即可，不依赖最后一份大快照是否成功写入。
    return latest ? { ...latest, session: { ...latest.session, clean: true } } : null;
  };
  begin = async (session: FeedbackSession) => {
    const name = `session-${Date.parse(session.startedAt)}-${session.id}.json`;
    if (!sessionName.test(name)) throw new Error("反馈会话标记无效");
    if (this.marker === name) return;
    await this.files.write(
      name,
      JSON.stringify({ schema: 1, session: { ...session, clean: false }, reports: [] }),
    );
    this.marker = name;
  };
  end = async () => {
    const markers = new Set(this.previousMarkers);
    if (this.marker) markers.add(this.marker);
    for (const name of markers) {
      await this.files.remove(name);
      if (name === this.marker) this.marker = undefined;
      this.previousMarkers = this.previousMarkers.filter((item) => item !== name);
    }
  };
  write = async (state: FeedbackState) => {
    if (!state.session.clean) await this.begin(state.session);
    try {
      // 上一次写入中断的文件不覆盖任何有效快照；有完整备份时再回收。
      if (this.valid.length) await this.removeIncomplete();
      const payload = JSON.stringify(state);
      const text = JSON.stringify({ payload, checksum: await digest(payload) });
      if (text.length > feedbackFileLimit) throw new Error("反馈文件超过大小上限");
      const name = `report-${String(++this.sequence).padStart(16, "0")}-${crypto.randomUUID()}.json`;
      this.incomplete.push(name);
      await this.files.write(name, text);
      await decode(await this.files.read(name));
      this.incomplete = this.incomplete.filter((item) => item !== name);
      this.valid.unshift(name);
      for (const old of this.valid.slice(2)) await this.files.remove(old);
      this.valid = this.valid.slice(0, 2);
      await this.removeIncomplete();
      // 恢复报告已落盘，才清理上次会话的标记。
      for (const old of this.previousMarkers) await this.files.remove(old);
      this.previousMarkers = [];
    } finally {
      if (state.session.clean && this.marker) {
        await this.files.remove(this.marker);
        this.marker = undefined;
      }
    }
  };
  private async removeIncomplete() {
    for (const name of this.incomplete) await this.files.remove(name);
    this.incomplete = [];
  }
}
