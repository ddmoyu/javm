import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ExtensionFixture } from "../tests/fixtures/core-extension/host.mjs";
import { root, run } from "./third-party/posix/common.mjs";

assert.equal(process.platform, "linux");
const directory = await mkdtemp(path.join(tmpdir(), "javm-safe-protocol-"));
const home = path.join(directory, "home");
const application = path.join(directory, "安全 空格 ' 百分%", "JAVM");
const receipt = path.join(directory, "received.json");
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local/share"),
  XDG_DATA_DIRS: path.join(directory, "system-data"),
};
await mkdir(path.dirname(application), { recursive: true });
await mkdir(env.XDG_DATA_DIRS);
await mkdir(home);
await writeFile(
  application,
  `#!/usr/bin/env python3\nimport json,sys,pathlib\npathlib.Path(${JSON.stringify(receipt)}).write_text(json.dumps(sys.argv[1:]))\n`,
);
await chmod(application, 0o755);
const fixture = new ExtensionFixture(
  path.join(root, "bin/javm_database"),
  path.join(directory, "unused.sqlite3"),
  { env },
);
try {
  await fixture.start();
  const request = (operation, expected = "") =>
    fixture.request("platform.protocol", { operation, entry: application, expected });
  assert.equal((await request("status")).state, "missing");
  assert.equal((await request("register")).state, "current");
  await run("gio", ["open", "javm://safe-fixture/search?query=forest"], directory, true, env);
  let received;
  for (let i = 0; i < 100; ++i) {
    try {
      received = JSON.parse(await readFile(receipt, "utf8"));
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(50);
  }
  assert.deepEqual(received, ["javm://safe-fixture/search?query=forest"]);
  assert.equal((await request("remove")).state, "missing");
  console.log("Linux 链接注册、特殊字符路径、参数传递与解除通过");
} finally {
  await fixture.close();
  assert.equal(path.dirname(directory), path.resolve(tmpdir()));
  assert.match(path.basename(directory), /^javm-safe-protocol-/);
  await rm(directory, { recursive: true, force: true });
}
