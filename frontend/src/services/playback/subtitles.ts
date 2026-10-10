/** 转为纯文本 WebVTT；排版标签、脚本和 ASS 绘图均不执行。只接受 UTF-8/UTF-16 字幕。 */
export function subtitleVtt(bytes: ArrayBuffer, filename: string) {
  if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("字幕超过 5 MiB");
  const header = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  const encoding =
    header[0] === 255 && header[1] === 254
      ? "utf-16le"
      : header[0] === 254 && header[1] === 255
        ? "utf-16be"
        : "utf-8";
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes).replaceAll("\r", "");
  const plain = (value: string) =>
    value
      .replace(/\{[^}]*\}/g, "")
      .replace(/<[^>]*>/g, "")
      .replace(/\\[Nn]/g, "\n")
      .replaceAll("\\h", " ")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const time = (value: string) => {
    const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(value.trim());
    if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60)
      throw new Error("字幕时间格式无效");
    return (
      Number(match[1] ?? 0) * 3600 +
      Number(match[2]) * 60 +
      Number(match[3]) +
      Number(`0.${match[4]}`)
    );
  };
  const stamp = (seconds: number) =>
    `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${(seconds % 60).toFixed(3).padStart(6, "0")}`;
  const cues: { start: number; end: number; text: string }[] = [];
  if (/\.(ass|ssa)$/i.test(filename)) {
    let events = false,
      format = [
        "Layer",
        "Start",
        "End",
        "Style",
        "Name",
        "MarginL",
        "MarginR",
        "MarginV",
        "Effect",
        "Text",
      ];
    for (const line of text.split("\n")) {
      if (line.startsWith("[")) events = line.trim().toLowerCase() === "[events]";
      if (!events) continue;
      if (/^Format:/i.test(line))
        format = line
          .slice(7)
          .split(",")
          .map((v) => v.trim());
      if (!/^Dialogue:/i.test(line)) continue;
      const at = (name: string) => format.findIndex((v) => v.toLowerCase() === name);
      if (at("text") !== format.length - 1 || at("start") < 0 || at("end") < 0)
        throw new Error("ASS 字幕字段格式无效");
      const values = line.slice(9).split(",");
      const content = values.slice(at("text")).join(",");
      if (/\\p[1-9]/.test(content)) continue;
      cues.push({
        start: time(values[at("start")] ?? ""),
        end: time(values[at("end")] ?? ""),
        text: plain(content),
      });
      if (cues.length > 20000) throw new Error("字幕条目过多");
    }
  } else {
    for (const block of text.trim().split(/\n[\t ]*\n/)) {
      const lines = block.split("\n"),
        i = lines.findIndex((line) => line.includes(" --> "));
      if (i < 0) continue;
      const match = /^(\S+)\s+-->\s+(\S+)/.exec(lines[i]!);
      if (!match) throw new Error("字幕时间格式无效");
      cues.push({
        start: time(match[1]!),
        end: time(match[2]!),
        text: plain(lines.slice(i + 1).join("\n")),
      });
      if (cues.length > 20000) throw new Error("字幕条目过多");
    }
  }
  if (!cues.length || cues.some((c) => c.end <= c.start)) throw new Error("字幕没有有效条目");
  return (
    "WEBVTT\n\n" +
    cues.map((c) => `${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}`).join("\n\n") +
    "\n"
  );
}
