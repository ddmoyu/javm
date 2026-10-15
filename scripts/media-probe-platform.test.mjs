import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const build = process.env.JAVM_PROBE_BUILD && path.resolve(process.env.JAVM_PROBE_BUILD);
const paths =
  build && JSON.parse(await readFile(path.join(build, "probe-fixtures/paths.json"), "utf8"));
const options = { skip: !build, timeout: 18000 };
const libraryName =
  process.platform === "win32"
    ? "MediaInfo.dll"
    : process.platform === "darwin"
      ? "libmediainfo.0.dylib"
      : "libmediainfo.so.0";
async function until(read, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(25);
  }
  throw new Error("Safe media probe fixture timed out");
}
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
async function fixture(t, data = {}, library = paths?.full) {
  const root = await mkdtemp(path.join(tmpdir(), "javm-probe-safe-"));
  const executable = path.join(root, `探测 空格😀${process.platform === "win32" ? ".exe" : ""}`);
  const file = path.join(root, "安全 空格 & 100% 样例.json");
  const processes = [];
  t.after(async () => {
    for (const child of processes) {
      if (child.exitCode === null && child.signalCode === null) {
        const end = once(child, "close");
        child.kill("SIGKILL");
        await end;
      }
    }
    // Windows Job / POSIX supervisor 应在调用者返回前回收工作进程；异常宿主另有监护。
    let pid;
    try {
      pid = Number(await readFile(`${file}.pid`, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (pid) await until(() => !running(pid));
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("javm-probe-safe-"));
    await rm(root, { recursive: true, force: true });
  });
  await copyFile(paths.worker, executable);
  if (process.platform !== "win32") {
    await chmod(executable, 0o755);
    await copyFile(path.join(build, "bin/javm_process"), path.join(root, "javm_process"));
    await chmod(path.join(root, "javm_process"), 0o755);
  }
  if (library) await copyFile(library, path.join(root, libraryName));
  await writeFile(file, JSON.stringify(data));
  function start({ mode = "--probe", timeout = 5000, cancelAfter } = {}) {
    const args = [mode, file];
    if (mode === "--probe") {
      args.push(String(timeout));
      if (cancelAfter !== undefined) args.push(String(cancelAfter));
    }
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: root,
    });
    processes.push(child);
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-32768);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    const completed = once(child, "close").then(([code, signal]) => ({
      code,
      signal,
      stdout,
      stderr,
    }));
    return { child, completed };
  }
  const pid = () =>
    until(async () => {
      try {
        return Number(await readFile(`${file}.pid`, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    });
  return { root, file, start, pid };
}
const expected = {
  video: true,
  audio: true,
  videoTracks: 1,
  audioTracks: 1,
  durationMs: 2001,
  audioChannels: 2,
  audioLanguage: "safe",
  width: 320,
  height: 240,
  codec: "安全模拟编码",
};

test("跨平台探测动态加载并保留既有结果字段与 Unicode 路径", options, async (t) => {
  const sample = await fixture(t);
  const result = await sample.start().completed;
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.equal(running(await sample.pid()), false);
});
test("探测输出超过旧管道容量仍完整返回，Unicode 不被分块截断", options, async (t) => {
  const fields = { codec: "中".repeat(1000), language: "文".repeat(1000) };
  const sample = await fixture(t, fields);
  const result = await sample.start().completed;
  assert.equal(result.code, 0, result.stdout);
  assert.ok(Buffer.byteLength(result.stdout) > 4096);
  assert.equal(JSON.parse(result.stdout).codec, fields.codec);
  assert.equal(JSON.parse(result.stdout).audioLanguage, fields.language);
});
test("数值按固定小数点解析，非法或溢出数值不会产生未定义转换", options, async (t) => {
  const sample = await fixture(t, {
    videoDuration: "NaN",
    generalDuration: "1e100",
    audioDuration: "1234.5",
    width: "1e100",
    height: "-3",
    channels: "inf",
  });
  const result = await sample.start().completed;
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    ...expected,
    durationMs: 1235,
    width: 0,
    height: 0,
    audioChannels: 0,
  });
});
test("缺失动态库不会回退到其他位置", options, async (t) => {
  const sample = await fixture(t, {}, null);
  const result = await sample.start({ mode: "--media-probe" }).completed;
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stdout).error, /动态库加载失败/);
});
test("动态库缺失必需 C API 时明确失败", options, async (t) => {
  const sample = await fixture(t, {}, paths.incomplete);
  const result = await sample.start({ mode: "--media-probe" }).completed;
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stdout).error, /接口不完整/);
});
for (const mode of ["bad-count", "null-field", "open-error", "exit"]) {
  test(`异常动态库 ${mode} 不返回成功结果`, options, async (t) => {
    const sample = await fixture(t, { mode });
    const result = await sample.start().completed;
    assert.equal(result.code, 1);
    assert.equal(typeof JSON.parse(result.stdout).error, "string");
    assert.equal(running(await sample.pid()), false);
  });
}
test("工作进程过量输出立即失败并被回收", options, async (t) => {
  const sample = await fixture(t, { mode: "flood" });
  const result = await sample.start().completed;
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stdout).error, /输出过长/);
  assert.equal(running(await sample.pid()), false);
});
test("探测超时前先回收工作进程再返回", options, async (t) => {
  const sample = await fixture(t, { mode: "hang" });
  const result = await sample.start({ timeout: 1200 }).completed;
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stdout).error, /超时/);
  assert.equal(running(await sample.pid()), false);
});
test("进行中的取消回收工作进程，预先取消不启动工作进程", options, async (t) => {
  const sample = await fixture(t, { mode: "hang" });
  const early = await sample.start({ cancelAfter: 0 }).completed;
  assert.match(JSON.parse(early.stdout).error, /取消/);
  await assert.rejects(readFile(`${sample.file}.pid`), { code: "ENOENT" });
  const result = await sample.start({ cancelAfter: 1200 }).completed;
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stdout).error, /取消/);
  assert.equal(running(await sample.pid()), false);
});
test("原生探测调用者异常退出后工作进程不残留", options, async (t) => {
  const sample = await fixture(t, { mode: "hang" });
  const instance = sample.start();
  const pid = await sample.pid();
  instance.child.kill("SIGKILL");
  await instance.completed;
  await until(() => !running(pid));
});
test("多个独立探测并行时标准流与取消互不串扰", options, async (t) => {
  const first = await fixture(t, { mode: "hang" });
  const second = await fixture(t, { codec: "safe-second" });
  const [cancelled, finished] = await Promise.all([
    first.start({ cancelAfter: 1200 }).completed,
    second.start().completed,
  ]);
  assert.match(JSON.parse(cancelled.stdout).error, /取消/);
  assert.equal(finished.code, 0, finished.stdout);
  assert.equal(JSON.parse(finished.stdout).codec, "safe-second");
});
test(
  "真实 MediaInfo 读取仅含静音的合成 WAV",
  {
    ...options,
    skip: !build || !process.env.JAVM_MEDIAINFO_LIBRARY,
  },
  async (t) => {
    const sample = await fixture(t, {}, path.resolve(process.env.JAVM_MEDIAINFO_LIBRARY));
    const dataLength = 48000 * 2;
    const wav = Buffer.alloc(44 + dataLength);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(36 + dataLength, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(48000, 24);
    wav.writeUInt32LE(96000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(dataLength, 40);
    await writeFile(sample.file, wav);
    const result = await sample.start().completed;
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const probe = JSON.parse(result.stdout);
    assert.equal(probe.video, false);
    assert.equal(probe.audio, true);
    assert.equal(probe.audioTracks, 1);
    assert.equal(probe.audioChannels, 1);
    assert.equal(probe.durationMs, 1000);
  },
);
