import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonical, safePath, sha256, inventory, verifyPayload } from "./components.mjs";

test("构建输入不受 JSON 键顺序影响", () => {
  assert.equal(canonical({ b: 2, a: { y: 2, x: 1 } }), canonical({ a: { x: 1, y: 2 }, b: 2 }));
});
test("拒绝绝对路径、回溯、盘符和 Windows 分隔符", () => {
  for (const name of ["../a", "/a", "C:/a", "runtime/../a", "runtime\\a", "runtime//a"]) {
    assert.throws(() => safePath(tmpdir(), name));
  }
});
test("验证真实文件内容、配方及未列入的文件", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "javm-component-test-"));
  await mkdir(path.join(directory, "runtime"));
  await writeFile(path.join(directory, "runtime/safe.txt"), "safe fixture");
  const spec = {
    component: "sample",
    version: "1",
    tag: "deps-sample",
    fingerprint: sha256("recipe"),
  };
  const manifest = {
    schema: 1,
    ...spec,
    platform: "windows-x64",
    files: await inventory(directory),
  };
  await verifyPayload(directory, manifest, spec, "windows-x64");
  await assert.rejects(
    verifyPayload(directory, manifest, { ...spec, fingerprint: sha256("changed") }, "windows-x64"),
  );
  await assert.rejects(verifyPayload(directory, manifest, spec, "linux-x64"));
  await writeFile(path.join(directory, "runtime/safe.txt"), "tampered data");
  await assert.rejects(verifyPayload(directory, manifest, spec, "windows-x64"));
  await writeFile(path.join(directory, "runtime/safe.txt"), "safe fixture");
  await writeFile(path.join(directory, "runtime/extra.txt"), "unexpected");
  await assert.rejects(verifyPayload(directory, manifest, spec, "windows-x64"));
});
test("拒绝大小写重名条目", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "javm-component-case-"));
  await mkdir(path.join(directory, "runtime"));
  await writeFile(path.join(directory, "runtime/safe.txt"), "safe");
  const spec = {
    component: "sample",
    version: "1",
    tag: "deps-sample",
    fingerprint: sha256("recipe"),
  };
  const files = await inventory(directory);
  const manifest = {
    schema: 1,
    ...spec,
    platform: "windows-x64",
    files: [...files, { ...files[0], path: "runtime/SAFE.txt" }],
  };
  await assert.rejects(verifyPayload(directory, manifest, spec, "windows-x64"));
});
