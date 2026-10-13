import assert from "node:assert/strict";
import test from "node:test";
import { nativeBuildPlan } from "./build-native.mjs";

test("Windows 保留 MSVC 发现与旧参数写法，核心构建明确隔离", () => {
  const [defaultBuild] = nativeBuildPlan("win32");
  assert.equal(defaultBuild.command, "powershell.exe");
  assert.ok(defaultBuild.args.some((arg) => arg.endsWith("build-native.ps1")));
  const [core] = nativeBuildPlan("win32", ["--core-only", "--curl-transport", "-Fresh"]);
  assert.deepEqual(core.args.slice(-3), ["-CoreOnly", "-CurlTransport", "-Fresh"]);
  assert.equal(nativeBuildPlan("win32", ["--Release"])[0].args.at(-1), "-Release");
});

test("Linux 与两种 macOS 架构使用当前工具链的独立核心 preset", () => {
  for (const [platform, preset] of [
    ["linux", "linux-core"],
    ["darwin", "macos-core"],
  ]) {
    const plan = nativeBuildPlan(platform, ["--core-only", "--fresh"]);
    assert.deepEqual(plan, [
      { command: "cmake", args: ["--fresh", "--preset", preset] },
      { command: "cmake", args: ["--build", "--preset", preset] },
    ]);
  }
});

test("所有平台支持隔离基础夹具，不隐式启用应用构建", () => {
  for (const platform of ["linux", "darwin"]) {
    const plan = nativeBuildPlan(platform, ["-PortabilityChecks"]);
    assert.ok(plan[0].args.includes("tests/native"));
    assert.deepEqual(plan[1].args, ["--build", "build/native/portability-checks"]);
  }
});

test("完整桌面构建使用相应开发或已验证组件发布 preset", () => {
  for (const platform of ["linux", "darwin"]) {
    const name = platform === "darwin" ? "macos" : "linux";
    assert.equal(nativeBuildPlan(platform)[0].args.at(-1), `${name}-app`);
    assert.equal(nativeBuildPlan(platform, ["--release"])[0].args.at(-1), `${name}-release`);
  }
});
test("拒绝未支持的平台、冲突参数和未知选项", () => {
  for (const args of [
    ["--release", "--core-only"],
    ["--portability-checks", "--core-only"],
    ["--curl-transport"],
    ["--nonsense"],
    ["core-only"],
  ]) {
    assert.throws(() => nativeBuildPlan("win32", args));
  }
  assert.throws(() => nativeBuildPlan("freebsd", ["--core-only"]), /Unsupported platform/);
});
