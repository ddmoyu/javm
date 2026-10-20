import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, target } from "./common.mjs";
import { verifyHostGlobals } from "./verify-host.mjs";

export function binaryArchitecture(bytes) {
  if (bytes.length < 20) return "unknown";
  if (bytes.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = bytes.readUInt32LE(4);
    return cpu === 0x100000c ? "macos-arm64" : cpu === 0x1000007 ? "macos-x64" : "unknown";
  }
  if (
    bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
    bytes[4] === 2 &&
    bytes[5] === 1
  )
    return bytes.readUInt16LE(18) === 62 ? "linux-x64" : "unknown";
  return "unknown";
}
export async function verifyRuntime(directory, spec) {
  const binary = path.join(
    directory,
    "runtime",
    {
      curl: "curl",
      mediainfo: target.startsWith("macos") ? "libmediainfo.0.dylib" : "libmediainfo.so.0",
      ffmpeg: "ffmpeg",
      metatube: "metatube-server",
      neutralino: "neutralino",
    }[spec.component],
  );
  assert.equal(binaryArchitecture(await readFile(binary)), spec.platform, "组件架构不匹配");
  if (target.startsWith("macos")) {
    const linked = await run("otool", ["-L", binary], directory, true);
    assert.ok(
      !/\/opt\/homebrew|\/usr\/local\/|\/Users\/runner\//.test(
        linked.split("\n").slice(1).join("\n"),
      ),
      "组件不能依赖构建机动态库",
    );
    const commands = await run("otool", ["-l", binary], directory, true);
    const minimums = [...commands.matchAll(/(?:minos|\bversion) (\d+\.\d+(?:\.\d+)?)/g)].map(
      (match) => match[1],
    );
    assert.ok(
      minimums.some((version) => Number(version.split(".")[0]) <= 13),
      "缺少 macOS 最低版本标识",
    );
    assert.ok(!commands.match(/minos (?:1[4-9]|[2-9]\d)\./), "组件要求的 macOS 版本高于 13");
  }
  const parent = await mkdtemp(path.join(tmpdir(), "javm-safe-component-"));
  try {
    if (spec.component === "curl") {
      const version = await run(binary, ["--version"], parent, true);
      assert.match(version, /OpenSSL/);
      assert.match(version, /Protocols:.*https.*wss?/);
      const server = createServer((_, response) => response.end("safe-山林"));
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const output = await run(
          binary,
          [
            "--fail",
            "--max-time",
            "10",
            "--noproxy",
            "*",
            `http://127.0.0.1:${server.address().port}/safe`,
          ],
          parent,
          true,
        );
        assert.equal(output, "safe-山林");
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    } else if (spec.component === "ffmpeg") {
      assert.match(await run(binary, ["-version"], parent, true), /ffmpeg version 8\.0\.1/);
      const protocols = await run(binary, ["-hide_banner", "-protocols"], parent, true);
      assert.ok(!/\bhttps?\b/.test(protocols), "FFmpeg 网络由 curl 统一管理");
      // 只生成安全纯色帧，验证解码、缩放与封面编码实际可运行。
      const input = path.join(parent, "安全 色块.ppm"),
        output = path.join(parent, "safe.jpg");
      await writeFile(
        input,
        Buffer.concat([Buffer.from("P6\n16 16\n255\n"), Buffer.alloc(16 * 16 * 3, 120)]),
      );
      await run(
        binary,
        ["-v", "error", "-y", "-i", input, "-vf", "scale=32:32", "-frames:v", "1", output],
        parent,
      );
      assert.equal((await readFile(output)).readUInt16BE(0), 0xffd8);
    } else if (spec.component === "mediainfo") {
      const input = path.join(parent, "安全 静音.wav");
      const data = Buffer.alloc(44 + 16000);
      data.write("RIFF");
      data.writeUInt32LE(data.length - 8, 4);
      data.write("WAVEfmt ", 8);
      data.writeUInt32LE(16, 16);
      data.writeUInt16LE(1, 20);
      data.writeUInt16LE(1, 22);
      data.writeUInt32LE(8000, 24);
      data.writeUInt32LE(16000, 28);
      data.writeUInt16LE(2, 32);
      data.writeUInt16LE(16, 34);
      data.write("data", 36);
      data.writeUInt32LE(16000, 40);
      await writeFile(input, data);
      const script = `import ctypes,sys\nl=ctypes.CDLL(sys.argv[1])\nl.MediaInfo_New.restype=ctypes.c_void_p\nl.MediaInfo_Open.argtypes=[ctypes.c_void_p,ctypes.c_wchar_p]\nl.MediaInfo_Open.restype=ctypes.c_size_t\nl.MediaInfo_Get.argtypes=[ctypes.c_void_p,ctypes.c_size_t,ctypes.c_size_t,ctypes.c_wchar_p,ctypes.c_size_t,ctypes.c_size_t]\nl.MediaInfo_Get.restype=ctypes.c_wchar_p\nl.MediaInfo_Delete.argtypes=[ctypes.c_void_p]\np=l.MediaInfo_New()\ntry:\n assert l.MediaInfo_Open(p,sys.argv[2])\n assert l.MediaInfo_Get(p,0,0,'Format',1,0)=='Wave'\n assert l.MediaInfo_Get(p,0,0,'Duration',1,0)=='1000'\nfinally: l.MediaInfo_Delete(p)\n`;
      await run("python3", ["-c", script, binary, input], parent);
    } else if (spec.component === "neutralino") {
      await verifyHostGlobals(binary);
    } else {
      // CLI 帮助不启动任何资料提供方，不读取或生成真实业务内容。
      const help = await run(binary, ["-help"], parent, "both");
      assert.match(help, /(?:bind|port|Usage)/);
    }
  } finally {
    assert.match(path.basename(parent), /^javm-safe-component-/);
    await rm(parent, { recursive: true, force: true });
  }
}
