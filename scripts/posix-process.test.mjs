import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const binary = process.env.JAVM_PROCESS_EXE && path.resolve(process.env.JAVM_PROCESS_EXE);
const fixture = fileURLToPath(new URL("../tests/fixtures/posix-process/tool.mjs", import.meta.url));
const ownerFixture = fileURLToPath(
  new URL("../tests/fixtures/posix-process/owner.mjs", import.meta.url),
);
const options = {
  skip: !binary || !["linux", "darwin"].includes(process.platform),
  timeout: 12000,
};
const cleanupTasks = new WeakMap();
async function until(read, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(30);
  }
  throw new Error("Safe process fixture timed out");
}
function live(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
async function marker(path) {
  return until(async () => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  });
}
async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), "javm-posix-safe-"));
  await chmod(root, 0o700);
  const cleanups = [];
  cleanupTasks.set(t, cleanups);
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("javm-posix-safe-"));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
async function payload(root, mode, changes = {}) {
  const privateDir = path.join(root, "private");
  await mkdir(privateDir, { mode: 0o700 });
  const file = path.join(privateDir, "process.json");
  await writeFile(
    file,
    JSON.stringify({
      schema: 1,
      file: process.execPath,
      args: [fixture, mode, path.join(root, "started")],
      envs: {},
      ...changes,
    }),
    { mode: 0o600 },
  );
  return file;
}
function managed(t, file, { owner = process.pid, drain = true, env = process.env } = {}) {
  const child = spawn(binary, ["--owner", String(owner), "--payload", file], {
    stdio: "pipe",
    env,
  });
  const exit = once(child, "exit");
  let stdout = "",
    stderr = "";
  if (drain)
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-512000);
    });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-32000);
  });
  cleanupTasks.get(t).push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await until(() => child.exitCode !== null || child.signalCode !== null, 5000);
    }
  });
  return { child, exit, output: () => ({ stdout, stderr }) };
}
test("POSIX 原样传递中文与 shell 符号，保留环境并转发双流和退出码", options, async (t) => {
  const root = await directory(t);
  const args = ["中文 空格😀", "'\"", "$(touch /never-create)", "a\nb", ""];
  const file = await payload(root, "echo", {
    args: [fixture, "echo", "unused", ...args],
    envs: { JAVM_SAFE_OVERRIDE: "new", JAVM_SAFE_EMPTY: "" },
  });
  const running = managed(t, file, {
    env: { ...process.env, JAVM_SAFE_INHERITED: "kept", JAVM_SAFE_OVERRIDE: "old" },
  });
  assert.equal((await running.exit)[0], 23);
  await until(() => running.output().stdout.includes("inherited"));
  assert.deepEqual(JSON.parse(running.output().stdout), {
    args,
    inherited: "kept",
    override: "new",
    empty: "",
  });
  assert.equal(running.output().stderr, "safe stderr\n");
  await assert.rejects(readFile(file), { code: "ENOENT" });
});
test("POSIX EOF 取消忽略 TERM 的整组进程，保留无关兄弟进程", options, async (t) => {
  const root = await directory(t);
  const unrelated = spawn(process.execPath, [fixture, "leaf", path.join(root, "unrelated")], {
    stdio: "ignore",
  });
  cleanupTasks.get(t).push(async () => {
    if (unrelated.exitCode === null && unrelated.signalCode === null) {
      const end = once(unrelated, "exit");
      unrelated.kill("SIGKILL");
      await end;
    }
  });
  const running = managed(t, await payload(root, "tree"));
  const pids = JSON.parse(await marker(path.join(root, "started")));
  await marker(path.join(root, "started.leaf"));
  running.child.stdin.end();
  assert.equal((await running.exit)[0], 130);
  await until(() => !live(pids.leader) && !live(pids.descendant));
  assert.ok(live(unrelated.pid));
});
test("POSIX leader 正常退出仍清理同组后代，保留原退出码", options, async (t) => {
  const root = await directory(t);
  const running = managed(t, await payload(root, "natural"));
  const pids = JSON.parse(await marker(path.join(root, "started")));
  assert.equal((await running.exit)[0], 7);
  await until(() => !live(pids.descendant));
});
test("POSIX 超时回收返回 124", options, async (t) => {
  const root = await directory(t);
  const running = managed(t, await payload(root, "leaf", { timeoutMs: 300 }));
  const pid = Number(await marker(path.join(root, "started")));
  assert.equal((await running.exit)[0], 124);
  await until(() => !live(pid));
});
test("POSIX SIGTERM 监督器会回收子进程", options, async (t) => {
  const root = await directory(t);
  const running = managed(t, await payload(root, "leaf"));
  const pid = Number(await marker(path.join(root, "started")));
  running.child.kill("SIGTERM");
  assert.equal((await running.exit)[0], 130);
  await until(() => !live(pid));
});
test("POSIX 输出管道阻塞不阻塞取消监护", options, async (t) => {
  const root = await directory(t);
  const running = managed(t, await payload(root, "flood"), { drain: false });
  const pid = Number(await marker(path.join(root, "started")));
  await delay(100);
  running.child.stdin.end();
  assert.equal((await running.exit)[0], 130);
  running.child.stdout.destroy();
  await until(() => !live(pid));
});
test("POSIX 错误所有者、共享参数目录、符号链接和非可执行文件均拒绝启动", options, async (t) => {
  const root = await directory(t);
  const file = await payload(root, "leaf");
  assert.equal((await managed(t, file, { owner: process.pid + 1 }).exit)[0], 125);
  await chmod(path.dirname(file), 0o755);
  assert.equal((await managed(t, file).exit)[0], 125);
  await chmod(path.dirname(file), 0o700);
  const body = await readFile(file);
  await rm(file);
  const external = path.join(root, "not-consumed.json");
  await writeFile(external, body, { mode: 0o600 });
  await symlink(external, file);
  assert.equal((await managed(t, file).exit)[0], 125);
  assert.deepEqual(await readFile(external), body);
  await rm(file);
  await writeFile(file, JSON.stringify({ schema: 1, file: external, args: [] }), { mode: 0o600 });
  assert.equal((await managed(t, file).exit)[0], 125);
  await assert.rejects(readFile(path.join(root, "started")), { code: "ENOENT" });
});
test("POSIX 宿主异常退出触发独立监护和进程组回收", options, async (t) => {
  const root = await directory(t);
  const file = await payload(root, "tree");
  const host = spawn(process.execPath, [ownerFixture, binary, file], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const hostExit = once(host, "exit");
  cleanupTasks.get(t).push(async () => {
    if (host.exitCode === null && host.signalCode === null) {
      host.kill("SIGKILL");
      await hostExit;
    }
  });
  const [{ pid: supervisor }] = await once(host, "message");
  const pids = JSON.parse(await marker(path.join(root, "started")));
  await marker(path.join(root, "started.leaf"));
  host.kill("SIGKILL");
  await hostExit;
  await until(() => !live(supervisor) && !live(pids.leader) && !live(pids.descendant));
});
