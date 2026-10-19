import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { completeRelease, requirePublishedRelease } from "./artifact.mjs";

await test("应用只接受公开且附件齐全的精确组件", () => {
  const spec = { tag: "deps-safe-linux-x64-test" };
  const release = {
    draft: false,
    prerelease: false,
    tag_name: spec.tag,
    assets: [".tar.gz", ".tar.gz.sha256", ".json"].map((suffix) => ({
      name: spec.tag + suffix,
      size: 1,
    })),
  };
  assert.equal(requirePublishedRelease(release, spec), release);
  for (const invalid of [
    null,
    { ...release, draft: true },
    { ...release, prerelease: true },
    { ...release, tag_name: "different" },
    { ...release, assets: release.assets.slice(1) },
    { ...release, assets: release.assets.map((asset) => ({ ...asset, size: 0 })) },
  ]) {
    assert.equal(completeRelease(invalid, spec), false);
    assert.throws(() => requirePublishedRelease(invalid, spec), /应用打包不会编译组件/);
  }
});

await test("缺包时实际安装入口终止且不执行任何构建或写入 GitHub 的命令", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    Object.defineProperty(process, "platform", { value: "linux" });
    Object.defineProperty(process, "arch", { value: "x64" });
    childProcess.execFileSync = (command, args) => {
      if (command !== "gh" || args[0] !== "release" || args[1] !== "view")
        throw new Error("Unexpected command: " + command + " " + args.join(" "));
      throw Object.assign(new Error("release not found"), { stderr: "HTTP 404" });
    };
    syncBuiltinESMExports();
    process.argv = [process.execPath, "resolve.mjs"];
    await import(${JSON.stringify(new URL("./resolve.mjs", import.meta.url).href)});
  `,
    ],
    { encoding: "utf8", timeout: 15000, windowsHide: true },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /缺少已发布且完整的组件/);
  assert.doesNotMatch(result.stderr, /Unexpected command/);
});

await test("应用工作流仅消费组件且无组件发布权限", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/desktop-posix.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /run: node scripts\/third-party\/posix\/resolve\.mjs\s*\n/);
  assert.doesNotMatch(workflow, /contents: write|--publish-missing|posix\/release\.mjs|setup-go/);
});
