import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, copyFile, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Node 24 的类型擦除用于复用应用的验证器，不引入第二套 CSV 格式。
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error.code === "ERR_MODULE_NOT_FOUND" &&
        /^\.\.?\//.test(specifier) &&
        !/\.[a-z]+$/i.test(specifier)
      )
        return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});
const {
  javbusEntryKey,
  javbusEntryUrl,
  mergeJavbusEntries,
  parseJavbusCsv,
  serializeJavbusCsv,
  parseJavbusActresses,
  parseJavbusGenres,
  parseJavbusRelations,
  javbusActressesUrl,
} = await import("../frontend/src/services/catalog/javbusCatalog.ts");
const {
  readJavbusVideoCount,
  sourceUrl,
  attribute,
  anchors,
  hasClass,
  JAVBUS_ACTRESSES_PAGE_LIMIT,
} = await import("../frontend/src/services/catalog/javbusWorks.ts");

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(workspace, "data", "catalogs", "javbus");
const temporary = join(workspace, ".tmp", "javm-catalog");
const args = process.argv.slice(2);
const argument = (name, fallback) => {
  const at = args.indexOf(name);
  return at < 0 ? fallback : args[at + 1];
};
const relationPages = Number(argument("--relations-pages", "0"));
const priorityIds = argument("--priority-ids", "").split(",").filter(Boolean);
if (priorityIds.length > 20 || priorityIds.some((id) => !/^[a-z0-9_-]{1,100}$/i.test(id)))
  throw new Error("优先演员身份无效。");
const runtimeOutput = args.includes("--install")
  ? resolve(process.env.LOCALAPPDATA || "", "JAVM", "catalogs", "javbus")
  : null;
if (runtimeOutput && !/^[a-z]:[\\/]/i.test(process.env.LOCALAPPDATA || ""))
  throw new Error("软件目录位置无效。");
if (!Number.isSafeInteger(relationPages) || relationPages < 0 || relationPages > 1000)
  throw new Error("关系名单分页上限必须为 0～1000。");
const filenames = {
  actresses: "actresses.csv",
  maleActors: "male-actors.csv",
  directors: "directors.csv",
  studios: "studios.csv",
  labels: "labels.csv",
  series: "series.csv",
  genres: "genres.csv",
};
await mkdir(output, { recursive: true });
await mkdir(temporary, { recursive: true });
// 用户已确认现有演员名单足够。暂停标记只在再次明确授权采集后移除。
const pausePath = join(temporary, "collection.paused");
if (
  await readFile(pausePath).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  )
) {
  console.log("演员名单采集已暂停，保留当前数据及断点。");
  process.exit(0);
}
const lockPath = join(temporary, "collection.lock");
try {
  await writeFile(lockPath, String(process.pid), { flag: "wx" });
} catch {
  console.error("采集已在运行或上次锁未清理，请检查 .tmp/javm-catalog/collection.lock。");
  process.exit(1);
}
let stopping = false;
const abort = new AbortController();
let cancellationOrigin;
const stop = (origin) => {
  stopping = true;
  cancellationOrigin ??= origin;
  abort.abort();
};
const cancelPath = join(temporary, "cancel.request");
await rm(cancelPath, { force: true });
const cancellationPoll = setInterval(() => {
  void readFile(cancelPath)
    .then(() => {
      stop("cancel_file");
    })
    .catch(() => {});
}, 1000);
cancellationPoll.unref();
process.once("SIGINT", () => {
  stop("SIGINT");
});
process.once("SIGTERM", () => {
  stop("SIGTERM");
});
const count = (entries) => entries.filter((entry) => entry.videoCount !== undefined).length;
let records = [];
let loaded = false;
const pages = { censored: 1, uncensored: 1 };
const unnamedActors = new Map();
const checkpointPath = join(temporary, "checkpoint.json");
const now = Date.now();
const manifest = {
  version: 1,
  source: "javbus",
  started_at: new Date(now).toISOString(),
  status: "running",
  requested_fields: ["entity_id", "entity_name", "video_count"],
  requests: 0,
  details_inspected: 0,
  directory_pages: [],
  files: {},
  coverage: "已保存身份及已有影片资料的制作商、发行商；并非全站完整名单",
};
class ReadFailure extends Error {
  constructor(reason, status = 0, path) {
    super(reason);
    this.reason = reason;
    this.status = status;
    this.path = path;
  }
}
let nextRequest = 0;
const cookiePath = join(temporary, "session.cookies");
let cookieHeader = "";
async function prepareSession() {
  const external = argument("--cookie-file", "");
  if (external) {
    const input = resolve(external);
    if (input !== cookiePath) await copyFile(input, cookiePath);
  }
  let cookies;
  try {
    cookies = await readFile(cookiePath, "utf8");
  } catch {
    throw new ReadFailure("verified_session_required");
  }
  const rows = cookies
    .split(/\r?\n/)
    .filter((line) => {
      if (!line || (line.startsWith("#") && !line.startsWith("#HttpOnly_"))) return false;
      const fields = line.replace(/^#HttpOnly_/, "").split("\t");
      return (
        fields.length === 7 &&
        /^\.?(?:www\.)?javbus\.com$/i.test(fields[0]) &&
        (fields[4] === "0" || Number(fields[4]) * 1000 > Date.now()) &&
        !/[\r\n;]/.test(fields[5] + fields[6])
      );
    })
    .filter((line) => line.split("\t")[5] !== "existmag");
  rows.push("www.javbus.com\tFALSE\t/\tTRUE\t2147483647\texistmag\tall");
  await writeFile(cookiePath, "# Netscape HTTP Cookie File\n" + rows.join("\n") + "\n", {
    mode: 0o600,
  });
  cookieHeader = rows
    .map((line) => line.replace(/^#HttpOnly_/, "").split("\t"))
    .map((fields) => `${fields[5]}=${fields[6]}`)
    .join("; ");
}
async function readHtml(url) {
  try {
    const response = await fetch(url, {
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "zh-CN,zh;q=0.9",
        Cookie: cookieHeader,
      },
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(25000)]),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return {
        status: response.status,
        location: response.headers.get("location"),
        retryAfter: response.headers.get("retry-after"),
        html: "",
      };
    }
    if (!/^text\/html\b/i.test(response.headers.get("content-type") || "")) {
      await response.body?.cancel();
      throw new ReadFailure("invalid_response", response.status);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new ReadFailure("response_too_large");
      }
      chunks.push(value);
    }
    return { status: response.status, html: Buffer.concat(chunks).toString("utf8") };
  } catch (error) {
    if (error instanceof ReadFailure) throw error;
    throw new ReadFailure(stopping ? "cancelled" : "network_error");
  }
}
async function request(input) {
  let url = new URL(input);
  const identity = url.pathname.replace(/\/$/, "") || "/";
  const visited = new Set();
  for (let hop = 0; hop < 6; hop++) {
    if (stopping) throw new ReadFailure("cancelled");
    if (url.origin !== "https://www.javbus.com" || url.username || url.password || url.hash)
      throw new ReadFailure("untrusted_redirect");
    if (/\/(?:doc\/driver-verify|verify|captcha|login)(?:[./?]|$)/i.test(url.pathname))
      throw new ReadFailure("human_verification_required");
    if ((url.pathname.replace(/\/$/, "") || "/") !== identity || url.search)
      throw new ReadFailure("identity_changed");
    if (visited.has(url.href)) throw new ReadFailure("redirect_loop");
    visited.add(url.href);
    // 四个固定工作者共享限频器，不为每个条目创建网络任务。
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      const scheduled = Math.max(Date.now(), nextRequest);
      nextRequest = scheduled + 650;
      await delay(Math.max(0, scheduled - Date.now()), undefined, { signal: abort.signal });
      manifest.requests++;
      try {
        response = await readHtml(url.href);
        if (response.status === 429 && attempt === 0) {
          const seconds = /^\d+$/.test(response.retryAfter || "")
            ? Number(response.retryAfter)
            : 60;
          if (seconds <= 60) {
            manifest.rate_limit_pauses = (manifest.rate_limit_pauses || 0) + 1;
            nextRequest = Math.max(nextRequest, Date.now() + Math.max(1, seconds) * 1000);
            console.log(
              JSON.stringify({ phase: "rate_limit", pause_seconds: Math.max(1, seconds) }),
            );
            await delay(Math.max(1, seconds) * 1000, undefined, { signal: abort.signal });
            continue;
          }
        }
        if (![408, 500, 502, 503, 504].includes(response.status) || attempt === 2) break;
      } catch (error) {
        if (error.reason !== "network_error" || attempt === 2) throw error;
      }
      await delay(1000 * 2 ** attempt, undefined, { signal: abort.signal });
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.location) throw new ReadFailure("invalid_redirect", response.status);
      url = new URL(response.location, url);
      if (url.hostname === "javbus.com") url.hostname = "www.javbus.com";
      continue;
    }
    if (response.status !== 200)
      throw new ReadFailure("http_denied", response.status, url.pathname);
    if (
      /challenge-platform|challenge-(?:stage|running)|Just a moment|userAnswers(?:\[|%5b|&#91;)|<form\b[^>]*driver-verify|<link\b[^>]*href\s*=\s*["'][^"']*\/doc\/driver-verify/i.test(
        response.html,
      )
    )
      throw new ReadFailure("human_verification_required", response.status);
    if (/^\/(?:uncensored\/)?(?:star|studio|label|genre)\/[a-z0-9_-]+$/i.test(identity)) {
      const canonical = [...response.html.matchAll(/<link\b([^>]{0,4096})>/gi)].find((match) =>
        attribute(match[1], "rel").toLowerCase().split(/\s+/).includes("canonical"),
      );
      if (canonical) {
        const target = sourceUrl(attribute(canonical[1], "href"), url.href);
        if (!target || target.pathname !== identity)
          throw new ReadFailure("identity_changed", 200, identity);
      }
    }
    return response.html;
  }
  throw new ReadFailure("redirect_limit");
}
async function atomic(path, text, backup = false) {
  const part = `${path}.${process.pid}.part`;
  await writeFile(part, text, "utf8");
  try {
    if (backup)
      await retryFileOperation(() => copyFile(path, `${path}.bak`)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    await retryFileOperation(() => rename(part, path));
  } finally {
    await rm(part, { force: true });
  }
}
async function retryFileOperation(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= 5) throw error;
      await delay(100 * 2 ** attempt);
    }
  }
}
async function save() {
  for (const [dimension, filename] of Object.entries(filenames)) {
    const entries = records.filter((entry) => entry.dimension === dimension);
    const csv = serializeJavbusCsv(entries, Date.now());
    if (csv !== (await readFile(join(output, filename), "utf8").catch(() => "")))
      await atomic(join(output, filename), csv, true);
    manifest.files[filename] = {
      rows: entries.length,
      known_counts: count(entries),
      sha256: createHash("sha256").update(csv, "utf8").digest("hex"),
    };
  }
  if (runtimeOutput) {
    await mkdir(runtimeOutput, { recursive: true });
    for (const dimension of Object.keys(filenames)) {
      const entries = records.filter((entry) => entry.dimension === dimension);
      if (!entries.length) continue;
      const path = join(runtimeOutput, `${dimension}.csv`);
      const old = await readFile(path, "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const merged =
        old === null
          ? entries
          : mergeJavbusEntries(parseJavbusCsv(old, dimension, Date.now()), entries, Date.now());
      const csv = serializeJavbusCsv(merged, Date.now());
      if (old !== csv) await atomic(path, csv, old !== null);
    }
    manifest.runtime_csv_updated_at = new Date().toISOString();
  }
  manifest.updated_at = new Date().toISOString();
  manifest.unnamed_actor_ids = [...unnamedActors.values()];
  await atomic(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await atomic(
    checkpointPath,
    JSON.stringify({
      version: 1,
      pages,
      unnamedActors: manifest.unnamed_actor_ids,
      updatedAt: Date.now(),
    }) + "\n",
  );
}
function merge(entries) {
  records = mergeJavbusEntries(records, entries, Date.now());
}
function summary(html) {
  return html
    .replace(/<!--[^]*?-->|<(script|style|template|nav|aside)\b[^>]*>[^]*?<\/\1\s*>/gi, "")
    .replace(
      /<a\b[^>]*class\s*=\s*["'][^"']*\b(?:movie-box|avatar-box)\b[^"']*["'][^>]*>[^]*?<\/a\s*>/gi,
      "",
    )
    .replace(/<img\b[^>]*>|<h3\b[^>]*>[^]*?<\/h3>/gi, "");
}
async function directories() {
  for (const lane of ["censored", "uncensored"]) {
    while (pages[lane] !== null) {
      const page = pages[lane];
      const html = await request(javbusActressesUrl(lane, page));
      const parsed = parseJavbusActresses(html, lane, page, Date.now());
      for (const id of parsed.unnamedIds ?? []) unnamedActors.set(`${lane}:${id}`, { lane, id });
      merge(parsed.entries);
      pages[lane] = parsed.nextPage;
      manifest.directory_pages.push({ lane, page, rows: parsed.entries.length });
      if (page % 10 === 0 || parsed.nextPage === null) await save();
      if (page % 10 === 0 || parsed.nextPage === null)
        console.log(
          JSON.stringify({
            phase: "directory",
            lane,
            page,
            rows: parsed.entries.length,
            entries: records.length,
          }),
        );
    }
    const html = await request(
      `https://www.javbus.com${lane === "uncensored" ? "/uncensored" : ""}/genre`,
    );
    const known = JSON.parse(
      await readFile(join(workspace, "frontend/src/services/catalog/builtin-genres.json"), "utf8"),
    ).entries;
    merge(parseJavbusGenres(html, lane, known, Date.now()));
    await save();
  }
}
async function relations() {
  const visited = new Set();
  for (const lane of ["censored", "uncensored"]) {
    let listing = `https://www.javbus.com${lane === "uncensored" ? "/uncensored" : "/"}`;
    for (let page = 1; page <= relationPages && listing; page++) {
      const html = await request(listing);
      let next;
      for (const match of anchors(html)) {
        const url = sourceUrl(attribute(match[1], "href"), listing);
        if (!url) continue;
        if (url.pathname === `${lane === "uncensored" ? "/uncensored" : ""}/page/${page + 1}`)
          next = url.href;
        if (!hasClass(match[1], "movie-box") || visited.has(url.href)) continue;
        if (!/^\/(?:uncensored\/)?(?=[a-z0-9_-]*\d)[a-z0-9][a-z0-9_-]{2,100}$/i.test(url.pathname))
          continue;
        visited.add(url.href);
        const detail = await request(url.href);
        merge(
          parseJavbusRelations(detail, Date.now()).filter((entry) =>
            ["studios", "labels"].includes(entry.dimension),
          ),
        );
        manifest.details_inspected++;
        if (manifest.details_inspected % 50 === 0) await save();
      }
      listing = next;
      console.log(
        JSON.stringify({ phase: "relations", lane, page, details: manifest.details_inspected }),
      );
    }
  }
}
const inspectedCounts = new Set();
async function quantities(dimensions, ids) {
  // 固定四个请求工作者；数量按身份更新，人工维护的其他字段保持原值。
  let completed = 0;
  const targets = records.filter(
    (entry) =>
      (!dimensions || dimensions.includes(entry.dimension)) &&
      (!ids || ids.includes(entry.id)) &&
      !inspectedCounts.has(javbusEntryKey(entry)) &&
      (entry.videoCount === undefined || args.includes("--refresh-counts")),
  );
  const indexes = new Map(records.map((entry, index) => [javbusEntryKey(entry), index]));
  let cursor = 0;
  let failure;
  let saving = Promise.resolve();
  const worker = async () => {
    while (cursor < targets.length && !failure) {
      const entry = targets[cursor++];
      const key = javbusEntryKey(entry);
      try {
        const html = await request(javbusEntryUrl(entry));
        const videoCount = readJavbusVideoCount(summary(html));
        inspectedCounts.add(key);
        if (videoCount !== undefined) {
          const index = indexes.get(key);
          records[index] = { ...records[index], videoCount, countUpdatedAt: Date.now() };
        }
      } catch (error) {
        if (
          error instanceof ReadFailure &&
          (error.status === 404 || error.reason === "identity_changed")
        ) {
          inspectedCounts.add(key);
          manifest.missing_entities = (manifest.missing_entities || 0) + 1;
        } else {
          failure ??= error;
          abort.abort();
          break;
        }
      }
      completed++;
      manifest.count_progress = { completed, total: targets.length };
      if (completed % 100 === 0) {
        saving = saving.then(save);
        await saving;
      }
      if (completed % 100 === 0 || completed === targets.length)
        console.log(
          JSON.stringify({
            phase: "counts",
            completed,
            total: targets.length,
            known: count(records),
          }),
        );
    }
  };
  await Promise.allSettled(Array.from({ length: 4 }, worker));
  await saving;
  await save();
  if (failure) throw failure;
}
try {
  for (const [dimension, filename] of Object.entries(filenames)) {
    const csv = await readFile(join(output, filename), "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (csv !== null) merge(parseJavbusCsv(csv, dimension, now));
  }
  try {
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    if (
      checkpoint.version !== 1 ||
      !["censored", "uncensored"].every(
        (lane) =>
          checkpoint.pages[lane] === null ||
          (Number.isInteger(checkpoint.pages[lane]) &&
            checkpoint.pages[lane] > 0 &&
            checkpoint.pages[lane] <= JAVBUS_ACTRESSES_PAGE_LIMIT),
      )
    )
      throw new Error("采集断点无效，未覆盖数据。");
    Object.assign(pages, checkpoint.pages);
    if (Array.isArray(checkpoint.unnamedActors) && checkpoint.unnamedActors.length <= 100_000) {
      for (const entry of checkpoint.unnamedActors) {
        if (
          !["censored", "uncensored"].includes(entry.lane) ||
          !/^[a-z0-9_-]{1,100}$/i.test(entry.id)
        )
          throw new Error("采集断点身份无效，未覆盖数据。");
        unnamedActors.set(`${entry.lane}:${entry.id}`, entry);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (args.includes("--refresh-directories")) Object.assign(pages, { censored: 1, uncensored: 1 });
  const builtin = JSON.parse(
    await readFile(join(workspace, "frontend/src/services/catalog/builtin-entities.json"), "utf8"),
  );
  merge(
    builtin.entries
      .filter((entry) => ["studios", "labels"].includes(entry.dimension))
      .map((entry) => ({
        ...entry,
        label: entry.name,
        aliases: [],
        translationStatus: "pending",
        category: "",
      })),
  );
  loaded = true;
  await save();
  if (args.includes("--seed-only")) {
    manifest.status = "existing_metadata_only";
    manifest.origin_captured_at = builtin.capturedAt;
  } else {
    await prepareSession();
    // 优先补齐制作商、发行商的少量已有身份，再读取演员、分类目录。
    await quantities(["studios", "labels"]);
    if (priorityIds.length) await quantities(["actresses"], priorityIds);
    await directories();
    if (relationPages) await relations();
    await quantities(["studios", "labels", "genres"]);
    await quantities();
    manifest.status =
      count(records) === records.length ? "completed" : "completed_with_unknown_counts";
    manifest.coverage = "两个演员目录和分类目录；制作商、发行商限于已有及指定分页的影片资料";
  }
  await save();
  console.log(JSON.stringify({ status: manifest.status, files: manifest.files }));
} catch (error) {
  manifest.status = stopping ? "cancelled" : "incomplete";
  manifest.failure = {
    ...(cancellationOrigin ? { cancellation_origin: cancellationOrigin } : {}),
    reason: stopping
      ? "cancelled"
      : error instanceof ReadFailure
        ? error.reason
        : "validation_failed",
    status: error.status || 0,
    ...(error instanceof ReadFailure && error.path ? { path: error.path } : {}),
    ...(typeof error.code === "string" && /^[A-Z_0-9]+$/.test(error.code)
      ? { system_code: error.code }
      : {}),
    ...(typeof error.message === "string" && /^JavBus [\u4e00-\u9fff，。]+$/.test(error.message)
      ? { validation_hint: error.message.replace("JavBus ", "") }
      : {}),
  };
  if (loaded) await save().catch(() => {});
  console.error(
    JSON.stringify({
      status: manifest.status,
      failure: manifest.failure,
      known_counts: count(records),
      output: relative(workspace, output),
    }),
  );
  process.exitCode = 1;
} finally {
  clearInterval(cancellationPoll);
  await rm(cancelPath, { force: true });
  await rm(lockPath, { force: true });
}
