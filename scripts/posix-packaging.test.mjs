import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { inside, inventory, specification, verifyInventory } from "./third-party/posix/common.mjs";
import { binaryArchitecture } from "./third-party/posix/verify.mjs";

test("组件只接受目标 ELF / Mach-O 架构，短文件不会越界读取", () => {
  for (let length = 0; length < 20; ++length)
    assert.equal(binaryArchitecture(Buffer.alloc(length)), "unknown");
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf);
  bytes.writeUInt32LE(0x100000c, 4);
  assert.equal(binaryArchitecture(bytes), "macos-arm64");
  bytes.writeUInt32LE(0x1000007, 4);
  assert.equal(binaryArchitecture(bytes), "macos-x64");
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  bytes.writeUInt16LE(62, 18);
  assert.equal(binaryArchitecture(bytes), "linux-x64");
  bytes.writeUInt16LE(183, 18);
  assert.equal(binaryArchitecture(bytes), "unknown");
});
test("归档路径拒绝逃逸、空组件和反斜杠", () => {
  for (const invalid of ["../escape", "/absolute", "a/../b", "a\\b", "a//b", "a/./b", "a\n", ""])
    assert.throws(() => inside(tmpdir(), invalid));
  assert.equal(inside(tmpdir(), "runtime/安全工具"), path.join(tmpdir(), "runtime/安全工具"));
});
test("清单校验识别篡改、额外文件和重复记录", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "javm-safe-inventory-"));
  try {
    await writeFile(path.join(directory, "safe"), "fixture");
    const manifest = { files: await inventory(directory) };
    await verifyInventory(directory, manifest);
    await writeFile(path.join(directory, "safe"), "changed");
    await assert.rejects(verifyInventory(directory, manifest), /不匹配/);
    await writeFile(path.join(directory, "safe"), "fixture");
    await writeFile(path.join(directory, "extra"), "fixture");
    await assert.rejects(verifyInventory(directory, manifest), /未记录/);
    await assert.rejects(
      verifyInventory(directory, { files: [...manifest.files, ...manifest.files] }),
      /重复/,
    );
  } finally {
    assert.match(path.basename(directory), /^javm-safe-inventory-/);
    await rm(directory, { recursive: true, force: true });
  }
});
test("组件指纹包含平台基线，架构之间不能错误复用", async () => {
  const mac = await specification("curl", "macos-arm64");
  const intel = await specification("curl", "macos-x64");
  const linux = await specification("curl", "linux-x64");
  assert.equal(mac.inputs.baseline, "macOS 13.0");
  assert.equal(linux.inputs.baseline, "Ubuntu 24.04");
  assert.equal(new Set([mac.fingerprint, intel.fingerprint, linux.fingerprint]).size, 3);
  assert.match(mac.tag, /^deps-curl-macos-arm64-[a-f0-9]{16}$/);
});
