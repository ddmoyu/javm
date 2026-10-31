import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fixCocoaRectReturns } from "./patch-neutralino.mjs";

// Minimal excerpts of the two CGRect-returning calls in locked Neutralino 6.10.0.
// No Cocoa SDK is needed: Clang still applies each target's real return ABI.
const source = `
struct CGPoint { double x, y; };
struct CGSize { double width, height; };
struct CGRect { CGPoint origin; CGSize size; };
using id = void*;
using SEL = void*;
extern id windowHandle;
extern "C" void objc_msgSend();
#if defined(__arm64__)
extern "C" void objc_msgSend_stret() __attribute__((unavailable));
#else
extern "C" void objc_msgSend_stret();
#endif
SEL operator ""_sel(const char*, __SIZE_TYPE__);
#if defined(__APPLE__)
CGRect __getWindowRect() {
    CGRect winPos = ((CGRect (*)(id, SEL))objc_msgSend)(
        (id) windowHandle, "frame"_sel);
    return winPos;
}
CGRect snapshotContentRect(CGRect frameRect) {
    return ((CGRect (*)(id, SEL, CGRect))objc_msgSend)(windowHandle, "contentRectForFrameRect:"_sel, frameRect);
}
void moveWindow(CGPoint point) {
    ((void (*)(id, SEL, CGPoint))objc_msgSend)(windowHandle, "setFrameTopLeftPoint:"_sel, point);
}
#endif
`;

void test("CGRect 补丁在上游位置缺失、重复或已修补时拒绝继续", () => {
  for (const changed of [
    source.replace("CGRect __getWindowRect() {", "CGRect changed() {"),
    source.replace("CGRect (*)(id, SEL, CGRect)", "CGRect (*)(id, SEL, const CGRect&)"),
    source + source,
    fixCocoaRectReturns(source),
  ]) {
    assert.throws(() => fixCocoaRectReturns(changed), /macOS CGRect ABI/);
  }
});

for (const architecture of ["x86_64", "arm64"]) {
  void test(`macOS ${architecture} 编译后窗口与截图调用采用正确的 CGRect 返回 ABI`, () => {
    const compiled = spawnSync(
      process.env.JAVM_CLANGXX || "clang++",
      [
        "-target",
        `${architecture}-apple-macos13`,
        "-x",
        "c++",
        "-std=c++17",
        "-S",
        "-emit-llvm",
        "-O0",
        "-o",
        "-",
        "-",
      ],
      { input: fixCocoaRectReturns(source), encoding: "utf8", timeout: 15000, windowsHide: true },
    );
    assert.ifError(compiled.error);
    assert.equal(compiled.status, 0, compiled.stderr);
    const calls = compiled.stdout
      .split("\n")
      .filter((line) => /\bcall\b.*@objc_msgSend/.test(line));
    assert.equal(calls.length, 3, "必须检查两个结构体返回调用和一个普通调用");
    if (architecture === "x86_64") {
      assert.equal(calls.filter((line) => /@objc_msgSend_stret\(.*sret\(/.test(line)).length, 2);
      assert.equal(calls.filter((line) => /@objc_msgSend\(/.test(line)).length, 1);
    } else {
      assert.doesNotMatch(compiled.stdout, /@objc_msgSend_stret/);
      assert.equal(calls.filter((line) => /call (?!void).*@objc_msgSend\(/.test(line)).length, 2);
    }
  });
}
