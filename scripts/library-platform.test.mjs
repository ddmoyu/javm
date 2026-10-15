import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test } from "node:test";
import { ExtensionFixture } from "../tests/fixtures/core-extension/host.mjs";

const build = process.env.JAVM_LIBRARY_BUILD && path.resolve(process.env.JAVM_LIBRARY_BUILD);
const executable = (name) => name + (process.platform === "win32" ? ".exe" : "");
async function fixture(t) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(path.join(parent, "javm-safe-library-"));
  const hosts = [];
  t.after(async () => {
    for (const host of hosts) await host.close();
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith("javm-safe-library-"));
    await rm(root, { recursive: true, force: true });
  });
  const bin = path.join(root, "应用 空格😀");
  await mkdir(bin);
  const binary = path.join(bin, executable("javm_library_fixture"));
  await copyFile(path.join(build, "bin", executable("javm_library_fixture")), binary);
  const paths = JSON.parse(await readFile(path.join(build, "probe-fixtures/paths.json"), "utf8"));
  const library =
    process.platform === "win32"
      ? "MediaInfo.dll"
      : process.platform === "darwin"
        ? "libmediainfo.0.dylib"
        : "libmediainfo.so.0";
  await copyFile(paths.full, path.join(bin, library));
  if (process.platform !== "win32")
    await copyFile(path.join(build, "bin/javm_process"), path.join(bin, "javm_process"));
  const media = path.join(root, "安全媒体😀");
  const data = path.join(root, "隔离数据");
  await mkdir(media);
  await mkdir(data);
  const database = path.join(data, "downloads.sqlite3");
  return {
    root,
    media,
    data,
    database,
    async host() {
      const host = new ExtensionFixture(binary, database);
      hosts.push(host);
      await host.start();
      return host;
    },
    async mediaFile(name, content = {}) {
      const file = path.join(media, name);
      await writeFile(file, JSON.stringify(content));
      return file;
    },
  };
}
async function until(read, done) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await delay(30);
  }
  throw new Error("安全媒体夹具未在时限内完成");
}
async function scan(host, directory) {
  await host.request("library.add", { path: directory, recursive: true, formats: ["mp4"] });
  const result = await until(
    () => host.request("library.status"),
    (state) => state.scan && state.scan.state !== "scanning",
  );
  assert.equal(result.scan.state, "completed", JSON.stringify(result.scan));
  return host.request("library.videos", { limit: 50 });
}
async function backup(host, operation, params) {
  await host.request("library.backup.start", { id: randomUUID(), operation, ...params });
  const value = await until(
    () => host.request("library.backup.status"),
    (state) => state.state !== "running",
  );
  assert.equal(value.state, "completed", value.error);
  return value.result;
}
describe("完整媒体服务的跨平台安全夹具", { skip: !build, timeout: 30000 }, () => {
  test("扫描 Unicode 目录并读取 NFO，保留自然排序", async (t) => {
    const f = await fixture(t);
    await f.mediaFile("安全2.mp4");
    await f.mediaFile("安全10.mp4");
    await writeFile(path.join(f.media, "安全2.nfo"), "<movie><title>安全山林2</title></movie>");
    await writeFile(path.join(f.media, "安全10.nfo"), "<movie><title>安全山林10</title></movie>");
    const host = await f.host();
    assert.equal((await host.request("capabilities")).media, true);
    const records = await scan(host, f.media);
    assert.equal(records.length, 2);
    assert.deepEqual(
      new Set(records.map((row) => row.title)),
      new Set(["安全山林2", "安全山林10"]),
    );
    assert.ok(records.every((row) => row.duration_ms === 2001 && row.width === 320));
    const queried = await host.request("library.query", {
      sort: "title",
      direction: "asc",
      limit: 50,
    });
    assert.equal(queried.items[0].title, "安全山林2");
    assert.equal(queried.items[1].title, "安全山林10");
  });
  test("主实例转发启动请求，退出后可以重新取得主实例锁", async (t) => {
    const f = await fixture(t);
    const main = await f.host();
    assert.equal((await main.request("library.instance.claim", { args: [] })).primary, true);
    const second = await f.host();
    assert.equal(
      (await second.request("library.instance.claim", { args: ["safe-launch"] })).primary,
      false,
    );
    assert.deepEqual(await main.request("library.instance.take"), [["safe-launch"]]);
    await second.close();
    await main.close();
    const replacement = await f.host();
    assert.equal((await replacement.request("library.instance.claim", { args: [] })).primary, true);
  });
  test("改名冲突保留源文件与记录，重启后恢复到新路径", async (t) => {
    const f = await fixture(t);
    const source = await f.mediaFile("safe-source.mp4");
    const target = path.join(f.media, "安全 new.mp4");
    const host = await f.host();
    await scan(host, f.media);
    const operation = await host.request("library.files.prepare", { source, target, rename: true });
    await writeFile(target, "independent safe file");
    await assert.rejects(host.request("library.files.commit", { id: operation.id }));
    assert.equal(await readFile(source, "utf8"), "{}");
    assert.equal(await readFile(target, "utf8"), "independent safe file");
    await rm(target);
    await host.close();
    const resumed = await f.host();
    assert.equal(
      (await resumed.request("library.files.commit", { id: operation.id })).state,
      "done",
    );
    assert.equal(await readFile(target, "utf8"), "{}");
    await assert.rejects(readFile(source));
    assert.equal((await resumed.request("library.files.list")).length, 0);
  });
  test("跨目录复制逐块核对后提交，源与目标关联一致", async (t) => {
    const f = await fixture(t);
    const source = await f.mediaFile("safe-copy.mp4", { codec: "安全编码" });
    const destination = path.join(f.root, "destination");
    await mkdir(destination);
    const target = path.join(destination, "safe-copy.mp4");
    const host = await f.host();
    await scan(host, f.media);
    const operation = await host.request("library.files.prepare", { source, target });
    await writeFile(operation.temporary, await readFile(source));
    const verified = await host.request("library.files.verify", { id: operation.id });
    assert.equal(verified.verified, verified.size);
    assert.equal((await host.request("library.files.commit", { id: operation.id })).state, "done");
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { codec: "安全编码" });
    await assert.rejects(readFile(source));
  });
  test("备份恢复保留资料，损坏片库恢复保留原始字节", async (t) => {
    const f = await fixture(t);
    const host = await f.host();
    await f.mediaFile("safe-backup.mp4");
    await scan(host, f.media);
    const saved = await backup(host, "create", { directory: f.root });
    assert.equal(saved.works, 1);
    assert.equal((await backup(host, "inspect", { path: saved.path })).works, 1);
    await backup(host, "restore", { path: saved.path });
    await host.close();
    const damaged = "safe synthetic damaged SQLite bytes";
    await writeFile(path.join(f.data, "library.sqlite3"), damaged);
    const recovery = await f.host();
    assert.ok((await recovery.request("library.status")).recoveryError);
    const restored = await backup(recovery, "restore", { path: saved.path });
    assert.equal(
      await readFile(path.join(restored.rollbackPath, "library.sqlite3"), "utf8"),
      damaged,
    );
    assert.equal((await recovery.request("library.videos")).length, 1);
  });
  test(
    "POSIX 字面路径不会把反斜杠当目录分隔符",
    { skip: process.platform === "win32" },
    async (t) => {
      const f = await fixture(t);
      const file = await f.mediaFile("safe: literal\\name.mp4");
      const host = await f.host();
      const records = await scan(host, f.media);
      assert.equal(records.length, 1);
      assert.equal(records[0].video_path, file);
    },
  );
  test("Linux 区分大小写的两个文件各自入库", { skip: process.platform !== "linux" }, async (t) => {
    const f = await fixture(t);
    await f.mediaFile("Case.mp4");
    await f.mediaFile("case.mp4");
    const records = await scan(await f.host(), f.media);
    assert.equal(records.length, 2);
    assert.equal(new Set(records.map((row) => row.video_path)).size, 2);
  });
  test("扫描跳过链接循环和链接媒体", async (t) => {
    const f = await fixture(t);
    const outside = path.join(f.root, "outside.mp4");
    await writeFile(outside, "{}");
    try {
      await symlink(f.media, path.join(f.media, "loop"), "junction");
      await symlink(outside, path.join(f.media, "linked.mp4"));
    } catch (error) {
      if (error.code !== "EPERM") throw error;
      t.skip("当前 Windows 账户没有创建符号链接的权限");
      return;
    }
    assert.equal((await scan(await f.host(), f.media)).length, 0);
  });
  test("扫描取消会回收正在挂起的探测进程", async (t) => {
    const f = await fixture(t);
    const file = await f.mediaFile("slow.mp4", { mode: "hang" });
    const host = await f.host();
    await host.request("library.add", { path: f.media, recursive: true, formats: ["mp4"] });
    await until(() => readFile(`${file}.pid`, "utf8").catch(() => ""), Boolean);
    const pid = Number(await readFile(`${file}.pid`, "utf8"));
    await host.request("library.cancel");
    const result = await until(
      () => host.request("library.status"),
      (state) => state.scan?.state !== "scanning",
    );
    assert.equal(result.scan.state, "cancelled");
    assert.throws(() => process.kill(pid, 0));
  });
});
