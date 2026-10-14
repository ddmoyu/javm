import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { legacyTargets, verifyLegacyRelease, verifyLegacySignature } from "./legacy-update.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "javm-legacy-safe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const id = randomBytes(8),
    publicBytes = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const encoded = Buffer.from(
    "untrusted comment: safe fixture\n" +
      Buffer.concat([Buffer.from("Ed"), id, publicBytes]).toString("base64") +
      "\n",
  ).toString("base64");
  const encodeSignature = (bytes, key = privateKey) => {
    const signature = sign(null, createHash("blake2b512").update(bytes).digest(), key);
    const comment = "timestamp:1 safe fixture";
    return Buffer.from(
      [
        "untrusted comment: safe fixture",
        Buffer.concat([Buffer.from("ED"), id, signature]).toString("base64"),
        "trusted comment: " + comment,
        sign(null, Buffer.concat([signature, Buffer.from(comment)]), key).toString("base64"),
        "",
      ].join("\n"),
    ).toString("base64");
  };
  return { directory, encoded, id, encodeSignature };
}
test("旧公钥验证 minisign 预哈希及可信注释", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from("Safe fictional update fixture"),
    file = path.join(f.directory, "safe.bin");
  await writeFile(file, bytes);
  assert.equal(
    await verifyLegacySignature(file, f.encodeSignature(bytes), f.encoded),
    Buffer.from(f.id).reverse().toString("hex").toUpperCase(),
  );
  await writeFile(file, "changed");
  await assert.rejects(
    verifyLegacySignature(file, f.encodeSignature(bytes), f.encoded),
    /验证失败/,
  );
});
test("旧签名拒绝错误密钥及被修改的可信注释", async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from("safe"),
    file = path.join(f.directory, "safe.bin");
  await writeFile(file, bytes);
  const wrong = generateKeyPairSync("ed25519");
  await assert.rejects(
    verifyLegacySignature(file, f.encodeSignature(bytes, wrong.privateKey), f.encoded),
    /验证失败/,
  );
  const altered = Buffer.from(
    Buffer.from(f.encodeSignature(bytes), "base64")
      .toString()
      .replace("timestamp:1", "timestamp:2"),
  ).toString("base64");
  await assert.rejects(verifyLegacySignature(file, altered, f.encoded), /验证失败/);
});
test("旧更新入口只接收正式版与 Beta，按安装类型选择附件", () => {
  assert.throws(() => legacyTargets("1.2.0-alpha.1"), /正式版和 Beta/);
  assert.throws(() => legacyTargets("../../oops"), /正式版和 Beta/);
  const targets = legacyTargets("1.2.0-beta.3");
  assert.match(targets["linux-x86_64-deb"], /\.deb$/);
  assert.match(targets["linux-x86_64-appimage"], /\.AppImage$/);
  assert.match(targets["darwin-aarch64"], /arm64-legacy\.app\.tar\.gz$/);
  assert.equal(targets["linux-aarch64"], undefined);
});
test("正式发布要求完整兼容清单、附件哈希和旧密钥签名", async (t) => {
  const f = await fixture(t),
    version = "1.2.0",
    targets = legacyTargets(version),
    files = [],
    platforms = {};
  async function save(name, data) {
    await writeFile(path.join(f.directory, name), data);
    files.push({
      name,
      bytes: Buffer.byteLength(data),
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }
  const signatures = new Map();
  for (const name of new Set(Object.values(targets))) {
    const bytes = Buffer.from("Safe test asset: " + name),
      signature = f.encodeSignature(bytes);
    await save(name, bytes);
    await save(name + ".sig", signature + "\n");
    signatures.set(name, signature);
  }
  for (const [target, name] of Object.entries(targets))
    platforms[target] = {
      url: `https://github.com/ddmoyu/javm/releases/download/v${version}/${name}`,
      signature: signatures.get(name),
    };
  await save(
    "latest.json",
    JSON.stringify({ version, pub_date: "2026-10-14T00:00:00Z", platforms }),
  );
  await verifyLegacyRelease(f.directory, version, files, f.encoded);
  await assert.rejects(
    verifyLegacyRelease(
      f.directory,
      version,
      files.filter((file) => !file.name.endsWith(".sig")),
      f.encoded,
    ),
    /缺少可信附件/,
  );
  const manifest = JSON.parse(await readFile(path.join(f.directory, "latest.json")));
  delete manifest.platforms["darwin-aarch64"];
  await writeFile(path.join(f.directory, "latest.json"), JSON.stringify(manifest));
  await assert.rejects(verifyLegacyRelease(f.directory, version, files, f.encoded), /平台不完整/);
});
