import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cocoaProtocolHelper, guardCocoaProtocols } from "./patch-neutralino.mjs";

const source = `class cocoa_wkwebview_engine {
  void setup() {
    class_addProtocol(cls, objc_getProtocol("NSTouchBarProvider"));
    class_addProtocol(cls, objc_getProtocol("NSApplicationDelegate"));
    class_addProtocol(cls, objc_getProtocol("WKScriptMessageHandler"));
    class_addProtocol(navcls, objc_getProtocol("WKNavigationDelegate"));
  }
};`;

void test("协议补丁拒绝缺失、重复及新增的未保护注册位置", () => {
  for (const changed of [
    source.replace("NSTouchBarProvider", "ChangedProtocol"),
    source + source,
    source + '\nclass_addProtocol(cls, objc_getProtocol("NewProtocol"));',
    guardCocoaProtocols(source),
  ]) {
    assert.throws(() => guardCocoaProtocols(changed), /协议注册|未保护/);
  }
});

void test("实际 Cocoa 注册辅助函数跳过空类和缺失协议并传递有效结果", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "javm-cocoa-protocol-test-"));
  try {
    const program = path.join(directory, "protocol.cpp");
    const binary = path.join(directory, process.platform === "win32" ? "protocol.exe" : "protocol");
    await writeFile(
      program,
      `
struct objc_class {};
struct Protocol {};
using Class = objc_class*;
static int lookups = 0, registrations = 0;
static Protocol present;
static Class expectedClass;
static bool registeredResult = true;
Protocol* objc_getProtocol(const char* name) {
  ++lookups;
  return name[0] == 'p' ? &present : nullptr;
}
bool class_addProtocol(Class cls, Protocol* protocol) {
  ++registrations;
  return cls == expectedClass && protocol == &present && registeredResult;
}
${cocoaProtocolHelper}
int main() {
  objc_class cls;
  expectedClass = &cls;
  if(javmAddCocoaProtocol(nullptr, "present") || lookups || registrations) return 1;
  if(javmAddCocoaProtocol(&cls, "missing") || lookups != 1 || registrations) return 2;
  if(!javmAddCocoaProtocol(&cls, "present") || registrations != 1) return 3;
  registeredResult = false;
  if(javmAddCocoaProtocol(&cls, "present") || registrations != 2) return 4;
  return 0;
}
`,
    );
    const build = spawnSync(
      process.env.JAVM_CLANGXX || "clang++",
      ["-std=c++17", program, "-o", binary],
      {
        encoding: "utf8",
        timeout: 30000,
        windowsHide: true,
      },
    );
    assert.ifError(build.error);
    assert.equal(build.status, 0, build.stderr);
    const result = spawnSync(binary, [], { encoding: "utf8", timeout: 5000, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `协议注册验证失败：${result.status} ${result.stderr}`);
  } finally {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.match(path.basename(directory), /^javm-cocoa-protocol-test-/);
    await rm(directory, { recursive: true, force: true });
  }
});
