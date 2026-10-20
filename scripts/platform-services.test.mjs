import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { createServer } from "node:net";
import { ExtensionFixture } from "../tests/fixtures/core-extension/host.mjs";

const binary = process.env.JAVM_CORE_EXE && path.resolve(process.env.JAVM_CORE_EXE);
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "javm-safe-platform-"));
  const host = new ExtensionFixture(binary, path.join(root, "unused.sqlite3"));
  t.after(async () => {
    await host.close();
    assert.match(path.basename(root), /^javm-safe-platform-/);
    await rm(root, { recursive: true, force: true });
  });
  await host.start();
  return { host, root };
}
describe("原生平台服务", { skip: !binary }, () => {
  test("通过官方扩展分配回环端口，不打开数据库", async (t) => {
    const { host, root } = await fixture(t);
    const result = await host.request("platform.loopbackPort");
    assert.ok(result.port >= 1024 && result.port <= 65535);
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(result.port, "127.0.0.1", resolve);
    });
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(await readdir(root), []);
  });
  test("拒绝其他应用凭据、过大值和未知方法，响应不泄露输入", async (t) => {
    const { host } = await fixture(t);
    for (const [method, params] of [
      ["platform.credentials.read", { key: "other-application" }],
      [
        "platform.credentials.write",
        { key: "javm-ai-settings-v1", value: '"' + "safe".repeat(21000) + '"' },
      ],
      [
        "platform.credentials.write",
        { key: "javm-ai-settings-v1", value: "SAFE-SECRET-invalid-json" },
      ],
      ["platform.unknown", {}],
    ]) {
      const reply = await host.reply(method, params);
      assert.equal(reply.ok, false);
      assert.ok(!reply.error.includes("SAFE-SECRET"));
    }
    assert.equal((await host.request("capabilities")).database, true);
  });
});
