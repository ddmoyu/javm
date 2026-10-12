import { describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { protocolScript } from "../frontend/src/services/settings/systemProtocol";
import type {
  ProtocolOperation,
  ProtocolState,
} from "../frontend/src/services/settings/systemProtocol";

describe.runIf(process.platform === "win32")("隔离 HKCU 测试键中的链接注册", () => {
  it("检查、注册、替换前冲突验证和解除只操作测试键，特殊路径不执行命令", async () => {
    await fs.mkdir(".tmp", { recursive: true });
    const root = path.resolve(await fs.mkdtemp(".tmp/protocol-safe-"));
    const entry = path.join(root, "中文 $() & ' 空格", "JAVM.exe");
    await fs.mkdir(path.dirname(entry));
    await fs.writeFile(entry, "safe non-executable fixture");
    const key = `Software\\JAVM\\Tests\\${crypto.randomUUID()}`;
    const run = (operation: ProtocolOperation, expected = "", exe = entry) =>
      JSON.parse(
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-EncodedCommand",
            Buffer.from(protocolScript(exe, operation, expected, key), "utf16le").toString(
              "base64",
            ),
          ],
          { encoding: "utf8", windowsHide: true, timeout: 15000 },
        ),
      ) as ProtocolState;
    try {
      expect(run("status").state).toBe("missing");
      const registered = run("register");
      expect(registered.state).toBe("current");
      expect(registered.command).toBe(`"${entry}" "%1"`);
      const second = path.join(root, "JAVM.exe");
      await fs.writeFile(second, "safe fixture");
      expect(() => run("register", "", second)).toThrow();
      expect(() => run("remove", "", second)).toThrow();
      expect(run("register", registered.command, second).state).toBe("current");
      expect(run("remove", "", second).state).toBe("missing");
    } finally {
      const state = run("status");
      if (state.state === "current") run("remove");
      else if (state.command) run("remove", "", path.join(root, "JAVM.exe"));
    }
  });
});
