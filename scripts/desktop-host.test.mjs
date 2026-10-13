import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { desktopHostFile, installDesktopHost } from "./desktop-host.mjs";

const targets = [
  ["win32", "x64", "neutralino-win_x64.exe"],
  ["linux", "x64", "neutralino-linux_x64"],
  ["darwin", "x64", "neutralino-mac_x64"],
  ["darwin", "arm64", "neutralino-mac_arm64"],
];
for (const [platform, arch, filename] of targets) {
  await test(`${platform}-${arch} 仅安装对应宿主，保留已有组件`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "javm-safe-host-"));
    try {
      const source = path.join(root, "source"),
        destination = path.join(root, "bin");
      await mkdir(source);
      await mkdir(destination);
      for (const [, , name] of targets)
        await writeFile(path.join(source, name), `Safe mock: ${name}`, { mode: 0o644 });
      await writeFile(path.join(destination, "existing-component"), "Preserved safe fixture");
      assert.equal(desktopHostFile(platform, arch), filename);
      const output = await installDesktopHost(source, destination, platform, arch);
      assert.equal(await readFile(output, "utf8"), `Safe mock: ${filename}`);
      assert.deepEqual(
        (await readdir(destination)).sort(),
        [filename, "existing-component"].sort(),
      );
      assert.equal(
        await readFile(path.join(destination, "existing-component"), "utf8"),
        "Preserved safe fixture",
      );
      if (process.platform !== "win32" && platform !== "win32")
        assert.equal((await stat(output)).mode & 0o777, 0o755);
    } finally {
      // mkdtemp 返回的独立目录，先确认边界再递归清理。
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()), "宿主测试清理路径越界");
      assert.ok(path.basename(root).startsWith("javm-safe-host-"), "宿主测试目录前缀无效");
      await rm(root, { recursive: true, force: true });
    }
  });
}
await test("未适配的系统或架构不能借用 x64 宿主", () => {
  for (const [platform, arch] of [
    ["win32", "arm64"],
    ["linux", "arm64"],
    ["darwin", "ia32"],
    ["freebsd", "x64"],
  ])
    assert.throws(() => desktopHostFile(platform, arch), /尚未适配/);
});
