// 下载规划只处理点播 HLS：选出一条视频与一条音频，生成 curl 清单和本地播放列表。
export const hlsLimits = {
  playlistBytes: 16 * 1024 * 1024,
  resources: 50_000,
  variants: 64,
  /** 主播放列表的清晰度不可用时，最多再尝试的候选数。 */
  candidates: 3,
};

export class HlsPlanError extends Error {}

export interface HlsVariant {
  url: string;
  bandwidth: number;
  /** 用于估算大小的码率（bit/s）：优先 AVERAGE-BANDWIDTH，其次 BANDWIDTH，未声明为 0。 */
  estimateBandwidth: number;
  audioGroup?: string;
  /** 只声明音频编码的变体不能作为视频轨。 */
  audioOnly: boolean;
}
export interface HlsAudio {
  group: string;
  url?: string;
  preferred: boolean;
}
export type HlsPlaylist =
  | { kind: "master"; variants: HlsVariant[]; audio: HlsAudio[] }
  | { kind: "media"; text: string };

export interface HlsResource {
  url: string;
  /** 相对 HLS 工作目录的文件名，只由规划器生成。 */
  file: string;
  /** 播放列表内嵌的 data: 密钥，直接写入本地，不经 curl 下载。 */
  inline?: Uint8Array;
  /** 该文件承载的播放时长（秒）；密钥和初始化段为 0。字节范围共用文件时累加。 */
  duration: number;
}
export interface HlsTrackPlan {
  /** 改写为本地文件后的播放列表。 */
  playlist: string;
  resources: HlsResource[];
  duration: number;
  encrypted: boolean;
}

function lines(text: string) {
  const values = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (values[0] !== "#EXTM3U")
    throw new HlsPlanError(
      /<html|<!doctype/i.test(text.slice(0, 2048))
        ? "服务器返回了网页而不是 HLS 播放列表，链接可能已失效或被网站拦截。"
        : "下载到的内容不是 HLS 播放列表。",
    );
  return values;
}
/** 宽松读取属性列表：容忍逗号后的空格和小写属性名，重复属性以最后一次为准。 */
export function attributes(line: string): Record<string, string> {
  const values: Record<string, string> = {};
  const body = line.slice(line.indexOf(":") + 1);
  for (const match of body.matchAll(/\s*([A-Za-z0-9-]+)\s*=\s*("[^"]*"|[^,]*)\s*(?:,|$)/g))
    values[match[1]!.toUpperCase()] = match[2]!.trim().replace(/^"|"$/g, "");
  return values;
}
function resolve(value: string, base: string) {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new HlsPlanError("HLS 播放列表包含无效地址。");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new HlsPlanError("HLS 播放列表包含不支持的地址。");
  url.hash = "";
  return url.href;
}
/** AES-128 密钥固定 16 字节；data: 地址可为 base64 或百分号编码。 */
/**
 * data: URL 的非 base64 正文编码的是字节：%HH 直接还原为一个字节，
 * 不能先按 UTF-8 解码成文本，否则 %FF 这类合法密钥字节会解析失败。
 */
function percentBytes(text: string) {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "%") {
      const hex = text.slice(index + 1, index + 3);
      if (!/^[\da-f]{2}$/i.test(hex)) throw new HlsPlanError("HLS 内嵌密钥格式无效。");
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else bytes.push(...encoder.encode(char));
  }
  return Uint8Array.from(bytes);
}
function inlineKey(uri: string) {
  const match = /^data:([^,]*),(.*)$/is.exec(uri);
  if (!match) return undefined;
  let bytes: Uint8Array;
  try {
    if (/;base64$/i.test(match[1]!)) {
      const binary = atob(match[2]!.replace(/\s+/g, ""));
      bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    } else bytes = percentBytes(match[2]!);
  } catch {
    throw new HlsPlanError("HLS 内嵌密钥格式无效。");
  }
  if (bytes.length !== 16) throw new HlsPlanError("HLS 内嵌密钥长度无效。");
  return bytes;
}
const audioCodecs = /^(mp4a|ac-3|ec-3|ac-4|opus|flac|mp3|alac)/i;

export function readPlaylist(text: string, url: string): HlsPlaylist {
  const source = lines(text);
  if (!source.some((line) => line.startsWith("#EXT-X-STREAM-INF:"))) return { kind: "media", text };
  const variants: HlsVariant[] = [];
  const audio: HlsAudio[] = [];
  let pending: Omit<HlsVariant, "url"> | undefined;
  for (const line of source.slice(1)) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const data = attributes(line);
      const declared = Number(data.BANDWIDTH || data["AVERAGE-BANDWIDTH"]);
      const size = /^(\d+)x(\d+)$/i.exec(data.RESOLUTION ?? "");
      // 码率缺失时按分辨率排序，仍保证有确定的选择顺序。
      const bandwidth =
        Number.isFinite(declared) && declared > 0
          ? declared
          : size
            ? Number(size[1]) * Number(size[2])
            : 0;
      const average = Number(data["AVERAGE-BANDWIDTH"]);
      const peak = Number(data.BANDWIDTH);
      const codecs = (data.CODECS ?? "").split(",").map((item) => item.trim());
      if (variants.length >= hlsLimits.variants) throw new HlsPlanError("HLS 清晰度数量超出限制。");
      pending = {
        bandwidth,
        estimateBandwidth: average > 0 ? average : peak > 0 ? peak : 0,
        audioGroup: data.AUDIO,
        audioOnly: !size && codecs[0] !== "" && codecs.every((item) => audioCodecs.test(item)),
      };
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      const data = attributes(line);
      if (data.TYPE !== "AUDIO" || !data["GROUP-ID"]) continue;
      if (audio.length >= hlsLimits.variants) throw new HlsPlanError("HLS 音轨数量超出限制。");
      audio.push({
        group: data["GROUP-ID"],
        url: data.URI ? resolve(data.URI, url) : undefined,
        preferred: data.DEFAULT === "YES",
      });
    } else if (line && !line.startsWith("#") && pending) {
      variants.push({ ...pending, url: resolve(line, url) });
      pending = undefined;
    }
  }
  if (!variants.length) throw new HlsPlanError("HLS 主播放列表没有可用清晰度。");
  return { kind: "master", variants: variants.sort((a, b) => b.bandwidth - a.bandwidth), audio };
}

/** 按码率从高到低给出候选；每个候选带上同组的默认独立音轨。纯音频变体不作为视频。 */
export function selectTracks(playlist: Extract<HlsPlaylist, { kind: "master" }>) {
  const videos = playlist.variants.filter((item) => !item.audioOnly);
  const unique = [
    ...new Map(
      (videos.length ? videos : playlist.variants).map((item) => [item.url, item]),
    ).values(),
  ];
  return unique.slice(0, hlsLimits.candidates).map((video) => {
    // 先在完整音轨组里选默认项；没有 URI 的音轨封装在视频里，是合法情况，
    // 此时不另外下载音频，也不能改用组内其他独立音轨。
    const group = playlist.audio.filter((item) => item.group === video.audioGroup);
    return {
      video: video.url,
      audio: (group.find((item) => item.preferred) ?? group[0])?.url,
      bandwidth: video.estimateBandwidth,
    };
  });
}

const segmentExtensions = /\.(ts|aac|ac3|eac3|ec3|mp3|m4s|m4a|m4v|mp4)$/i;
function extensionOf(url: string, fallback: string) {
  return segmentExtensions.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? fallback;
}

/**
 * 把媒体播放列表改写成指向本地文件的版本。相同地址只下载一次，
 * 字节范围标记保留给 FFmpeg 读取本地文件时使用。
 */
export function planTrack(text: string, url: string, prefix: "v" | "a"): HlsTrackPlan {
  const source = lines(text);
  const output: string[] = [];
  const resources: HlsResource[] = [];
  const files = new Map<string, HlsResource>();
  let duration = 0,
    segmentDuration = 0,
    encrypted = false,
    ended = false,
    segments = 0,
    fragmented = false,
    pendingDuration = false;
  const local = (target: string, kind: "seg" | "init" | "key", inline?: Uint8Array) => {
    const existing = files.get(target);
    if (existing) return existing;
    if (resources.length >= hlsLimits.resources) throw new HlsPlanError("HLS 分片数量超出限制。");
    const index = String(resources.length).padStart(5, "0");
    const extension =
      kind === "key" ? "key" : extensionOf(target, kind === "init" || fragmented ? "m4s" : "ts");
    const file = `${prefix}-${kind}-${index}.${extension}`;
    const resource: HlsResource = inline
      ? { url: target, file, inline, duration: 0 }
      : { url: target, file, duration: 0 };
    files.set(target, resource);
    resources.push(resource);
    return resource;
  };
  const replaceUri = (line: string, file: string) => line.replace(/URI="[^"]*"/i, `URI="${file}"`);
  for (const line of source) {
    if (line.startsWith("#EXT-X-STREAM-INF:") || line.startsWith("#EXT-X-I-FRAMES-ONLY"))
      throw new HlsPlanError("HLS 播放列表结构无效。");
    if (/^#EXT-X-(?:SESSION-)?KEY:/.test(line)) {
      const data = attributes(line);
      if (data.METHOD === "NONE") {
        output.push(line);
        continue;
      }
      if (data.METHOD !== "AES-128" || (data.KEYFORMAT && data.KEYFORMAT !== "identity"))
        throw new HlsPlanError("该视频使用 DRM 或不支持的加密方式，无法下载。");
      if (!data.URI) throw new HlsPlanError("HLS 加密信息缺少密钥地址。");
      if (data.IV && !/^0x[\da-f]{1,32}$/i.test(data.IV))
        throw new HlsPlanError("HLS 加密初始向量格式无效。");
      encrypted = true;
      const key = inlineKey(data.URI);
      output.push(
        replaceUri(
          line,
          (key ? local(data.URI, "key", key) : local(resolve(data.URI, url), "key")).file,
        ),
      );
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const data = attributes(line);
      if (!data.URI) throw new HlsPlanError("HLS 初始化分片缺少地址。");
      fragmented = true;
      output.push(replaceUri(line, local(resolve(data.URI, url), "init").file));
    } else if (line.startsWith("#EXTINF:")) {
      const value = Number(line.slice(8).split(",")[0]);
      if (!Number.isFinite(value) || value < 0) throw new HlsPlanError("HLS 分片时长无效。");
      duration += value;
      segmentDuration = value;
      pendingDuration = true;
      output.push(line);
    } else if (line === "#EXT-X-ENDLIST") {
      ended = true;
      output.push(line);
    } else if (line && !line.startsWith("#")) {
      if (!pendingDuration) throw new HlsPlanError("HLS 分片缺少时长信息。");
      pendingDuration = false;
      segments++;
      const segment = local(resolve(line, url), "seg");
      // 字节范围共用一个文件时，该文件承载多个分片的时长。
      segment.duration += segmentDuration;
      output.push(segment.file);
    } else if (line) output.push(line);
  }
  if (!ended) throw new HlsPlanError("这是直播流或未结束的播放列表，暂不支持下载。");
  if (!segments || duration <= 0) throw new HlsPlanError("HLS 播放列表没有可下载的分片。");
  return { playlist: `${output.join("\n")}\n`, resources, duration, encrypted };
}

/** 读取本地播放列表的总时长，用于合并后核对。 */
export function playlistDuration(text: string) {
  let duration = 0;
  for (const line of text.split(/\r?\n/))
    if (line.startsWith("#EXTINF:")) duration += Number(line.slice(8).split(",")[0]) || 0;
  return duration;
}

/** 本地播放列表引用的全部文件名，用于合并前确认分片仍然齐全。 */
export function playlistFiles(text: string) {
  const names = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const uri = /URI="([^"]*)"/i.exec(line)?.[1];
      if (uri) names.add(uri);
    } else names.add(line);
  }
  return [...names];
}

/**
 * 只忽略含义明确的签名与时效参数：它们每次读取播放列表都会变化，但不改变资源本身。
 * e、t、st、ts、time、hash 这类泛用短名可能就是清晰度、时间点或内容哈希，宁可不复用
 * 也不能把不同资源当成同一个，因此不在名单内。
 */
const volatileParameters =
  /^(token|access_token|auth_token|signature|sign|auth_key|expires|hdnts|hdntl|key-pair-id|policy|wmsauthsign|wstime|wssecret|txtime|txsecret|x-amz-[\w-]+|x-goog-[\w-]+|x-oss-[\w-]+)$/i;
/** 地址身份：域名、路径与非签名查询参数。 */
export function urlIdentity(value: string) {
  const url = new URL(value);
  const query = [...url.searchParams]
    .filter(([name]) => !volatileParameters.test(name))
    .map(([name, value]) => `${name}=${value}`)
    .sort();
  return `${url.origin}${url.pathname}?${query.join("&")}`;
}
/** 资源身份：地址身份；内嵌密钥按内容区分。 */
export function resourceIdentity(item: HlsResource) {
  return item.inline ? `inline:${[...item.inline].join(",")}` : urlIdentity(item.url);
}

/**
 * 同步的 FNV-1a 指纹：只用于判断续传记录是否属于同一组分片，不作安全用途。
 * 除每个分片外，还包含所选清晰度与音轨的子播放列表地址，避免不同清晰度共用分片名时混淆。
 */
export function hlsFingerprint(resources: HlsResource[], playlists: string[] = []) {
  let first = 0x811c9dc5,
    second = 0x01000193 ^ resources.length;
  const items = [
    ...playlists.map((url) => `playlist\t${urlIdentity(url)}\n`),
    ...resources.map((item) => `${item.file}\t${resourceIdentity(item)}\n`),
  ];
  for (const text of items) {
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193);
      second = Math.imul(second ^ code, 0x5bd1e995);
    }
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}-${resources.length}`;
}

/** 解析 curl --write-out 的单行结果；字段以制表符分隔，文件路径放在末尾。 */
export function parseTransfer(line: string) {
  const match = /^javm-transfer\t(\d+)\t(\d+)\t(\d+)\t([^\t]*)\t(.+)$/.exec(line);
  if (!match) return undefined;
  return {
    exitCode: Number(match[1]),
    status: Number(match[2]),
    bytes: Number(match[3]),
    contentType: match[4]!.toLowerCase(),
    file: match[5]!.split(/[\\/]/).at(-1)!,
  };
}
// stdout 写入管道时会被缓冲；stderr 不缓冲，分片完成后能立即更新进度。
export const transferFormat =
  "%{stderr}javm-transfer\\t%{exitcode}\\t%{response_code}\\t%{size_download}\\t%{content_type}\\t%{filename_effective}\\n";

/**
 * 判断一次分片传输是否可用。拦截页通常是很小的 HTML；
 * 真实分片即使被错误标为 text/html，体积一般也远超 64 KiB。
 */
export function transferAccepted(transfer: NonNullable<ReturnType<typeof parseTransfer>>) {
  if (transfer.exitCode !== 0 || transfer.status < 200 || transfer.status >= 300) return false;
  if (transfer.bytes <= 0) return false;
  return !(transfer.contentType.startsWith("text/html") && transfer.bytes < 64 * 1024);
}

const trackOf = (resource: HlsResource) => resource.file.slice(0, 1);

/**
 * 下载顺序：先取密钥与初始化段，再按位反转序列在整部影片中均匀取样，
 * 视频和音频按播放位置交错。前几个百分点的分片就能覆盖全片，大小估算更快稳定；
 * 合并只依赖本地播放列表，与下载顺序无关。
 */
export function spreadOrder(resources: HlsResource[]) {
  const support = resources.filter((item) => !item.duration);
  const tracks = new Map<string, HlsResource[]>();
  for (const item of resources) {
    if (!item.duration) continue;
    const items = tracks.get(trackOf(item));
    if (items) items.push(item);
    else tracks.set(trackOf(item), [item]);
  }
  const keyed: { resource: HlsResource; key: number }[] = [];
  for (const items of tracks.values()) {
    const bits = Math.max(1, Math.ceil(Math.log2(items.length)));
    const slots = 2 ** bits;
    for (let step = 0; step < slots; step++) {
      let position = 0;
      for (let bit = 0; bit < bits; bit++) position |= ((step >> bit) & 1) << (bits - 1 - bit);
      if (position < items.length) keyed.push({ resource: items[position]!, key: step / slots });
    }
  }
  keyed.sort((a, b) => a.key - b.key);
  return [...support, ...keyed.map((item) => item.resource)];
}

/** 早期样本覆盖到全片这么大比例的时长后，完全采用实测估算。 */
const trustedCoverage = 0.03;

/**
 * 估算 HLS 总大小。每条轨道用“已下载字节 ÷ 已下载时长 × 总时长”推算，
 * 视频和音频分别计算后相加；样本很少时与主播放列表声明的码率混合。
 * 结果不会低于已下载字节数，全部完成后即为精确值。每个分片完成时增量更新。
 */
export class HlsSizeEstimate {
  private tracks = new Map<string, { total: number; done: number; bytes: number }>();
  private byFile = new Map<string, HlsResource>();
  private completed = new Map<string, number>();
  private downloaded = 0;
  private support = 0;
  private totalDuration = 0;
  private doneDuration = 0;
  constructor(
    resources: HlsResource[] = [],
    private priorBytes = 0,
  ) {
    this.addResources(resources);
  }
  /** 分批加入计划中的文件，调用方可在批次之间让出事件循环。 */
  addResources(resources: HlsResource[]) {
    for (const item of resources) {
      if (this.byFile.has(item.file)) continue;
      this.byFile.set(item.file, item);
      if (!item.duration) continue;
      const track = this.tracks.get(trackOf(item)) ?? { total: 0, done: 0, bytes: 0 };
      track.total += item.duration;
      this.totalDuration += item.duration;
      this.tracks.set(trackOf(item), track);
    }
  }
  /** 记录或更新一个文件的实际字节数。 */
  record(file: string, bytes: number) {
    const item = this.byFile.get(file);
    if (!item || !(bytes >= 0)) return;
    const previous = this.completed.get(file);
    const delta = bytes - (previous ?? 0);
    this.completed.set(file, bytes);
    this.downloaded += delta;
    if (!item.duration) {
      this.support += delta;
      return;
    }
    const track = this.tracks.get(trackOf(item))!;
    track.bytes += delta;
    if (previous === undefined) {
      track.done += item.duration;
      this.doneDuration += item.duration;
    }
  }
  snapshot() {
    const downloaded = this.downloaded;
    const remaining = this.byFile.size - this.completed.size;
    if (!remaining) return { downloaded, total: downloaded, progress: 100, estimated: false };
    let observed = this.support,
      unsampled = false;
    for (const track of this.tracks.values()) {
      if (track.done > 0) observed += (track.bytes / track.done) * track.total;
      else unsampled = true;
    }
    let total: number;
    if (this.priorBytes > 0) {
      // 尚无样本的轨道（通常是刚开始的音频）用声明码率补足差额。
      const sampled = unsampled ? Math.max(observed, this.priorBytes) : observed;
      const coverage = this.totalDuration ? this.doneDuration / this.totalDuration : 0;
      const weight = Math.min(1, coverage / trustedCoverage);
      total = weight * sampled + (1 - weight) * this.priorBytes;
    } else total = this.doneDuration > 0 ? observed : 0;
    total = Math.max(Math.round(total), downloaded);
    const fallback = this.byFile.size ? (this.completed.size / this.byFile.size) * 100 : 0;
    return {
      downloaded,
      total,
      progress: Math.min(99.99, total ? (downloaded / total) * 100 : fallback),
      estimated: true,
    };
  }
}

/**
 * 部分来源把 TS 分片伪装成图片：在真正的视频数据前拼接一段 PNG、JPEG、GIF 或 BMP 文件头。
 * FFmpeg 会按图片识别，合并时报 “dimensions not set”。这里只识别文件头，不解码图片。
 */
export function imageSignature(bytes: Uint8Array) {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "PNG";
  if (starts(0xff, 0xd8, 0xff)) return "JPEG";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "GIF";
  if (starts(0x42, 0x4d)) return "BMP";
  return undefined;
}

/** MPEG-TS 包长 188 字节，每包以 0x47 开头；连续命中几次才视为找到了真正的 TS 起点。 */
export const tsPacket = 188;
export const tsSyncPackets = 4;
export function isTransportStreamAt(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + (tsSyncPackets - 1) * tsPacket >= bytes.length) return false;
  for (let packet = 0; packet < tsSyncPackets; packet++)
    if (bytes[offset + packet * tsPacket] !== 0x47) return false;
  return true;
}
/** 在字节片段中查找第一个可信的 TS 起点；找不到返回 -1。 */
export function transportStreamOffset(bytes: Uint8Array) {
  for (let offset = 0; offset + (tsSyncPackets - 1) * tsPacket < bytes.length; offset++)
    if (bytes[offset] === 0x47 && isTransportStreamAt(bytes, offset)) return offset;
  return -1;
}

/**
 * 给本地播放列表中的指定分片加上字节范围，让 FFmpeg 从真正的视频数据开始读取。
 * 已经带有字节范围的分片保持原样（来源本身使用字节范围时不做处理）。
 */
export function applySegmentRanges(
  text: string,
  ranges: Record<string, { offset: number; length: number }>,
) {
  const output: string[] = [];
  let ranged = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#EXT-X-BYTERANGE:")) ranged = true;
    else if (trimmed && !trimmed.startsWith("#")) {
      const range = ranges[trimmed];
      if (range && !ranged) output.push(`#EXT-X-BYTERANGE:${range.length}@${range.offset}`);
      ranged = false;
    }
    output.push(line);
  }
  return output.join("\n");
}
