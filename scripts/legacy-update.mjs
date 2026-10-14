// 仅用于保留 Tauri 客户端的升级入口；私钥只由 GitHub Actions 注入。
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = "ddmoyu/javm";
const publicFile = "resources/legacy-update-public-key.json";
const versionPattern =
  /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(-beta\.(0|[1-9]\d{0,5}))?$/;

function decode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.trim()))
    throw new Error("旧版签名编码无效");
  return Buffer.from(value.trim(), "base64");
}
function publicKeyRecord(encoded) {
  const lines = decode(encoded).toString("utf8").trim().split(/\r?\n/);
  const packet = decode(lines[1]);
  if (
    lines.length !== 2 ||
    !lines[0].startsWith("untrusted comment: ") ||
    packet.length !== 42 ||
    packet.toString("ascii", 0, 2) !== "Ed"
  )
    throw new Error("旧版更新公钥格式无效");
  return {
    key: createPublicKey({
      format: "jwk",
      key: { kty: "OKP", crv: "Ed25519", x: packet.subarray(10).toString("base64url") },
    }),
    id: packet.subarray(2, 10),
  };
}
async function digest(file, algorithm) {
  const hash = createHash(algorithm);
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest();
}
export async function verifyLegacySignature(file, signature, publicKey) {
  const { key, id } = publicKeyRecord(publicKey);
  const lines = decode(signature).toString("utf8").trim().split(/\r?\n/);
  if (
    lines.length !== 4 ||
    !lines[0].startsWith("untrusted comment: ") ||
    !lines[2].startsWith("trusted comment: ")
  )
    throw new Error("旧版更新签名格式无效");
  const packet = decode(lines[1]);
  // 新发布统一要求 minisign 的 BLAKE2b 预哈希格式，不接受降级签名。
  if (
    packet.length !== 74 ||
    packet.toString("ascii", 0, 2) !== "ED" ||
    !packet.subarray(2, 10).equals(id)
  )
    throw new Error("旧版签名密钥不匹配");
  const raw = packet.subarray(10);
  const global = decode(lines[3]);
  if (
    global.length !== 64 ||
    !verify(null, await digest(file, "blake2b512"), key, raw) ||
    !verify(
      null,
      Buffer.concat([raw, Buffer.from(lines[2].slice("trusted comment: ".length))]),
      key,
      global,
    )
  )
    throw new Error("旧版更新签名验证失败");
  return Buffer.from(id).reverse().toString("hex").toUpperCase();
}
export function legacyTargets(version) {
  if (!versionPattern.test(version)) throw new Error("旧版兼容更新仅支持正式版和 Beta");
  const prefix = `JAVM-${version}-`;
  return {
    "windows-x86_64": prefix + "windows-x64-setup.exe",
    "windows-x86_64-nsis": prefix + "windows-x64-setup.exe",
    "darwin-x86_64": prefix + "macos-x64-legacy.app.tar.gz",
    "darwin-x86_64-app": prefix + "macos-x64-legacy.app.tar.gz",
    "darwin-aarch64": prefix + "macos-arm64-legacy.app.tar.gz",
    "darwin-aarch64-app": prefix + "macos-arm64-legacy.app.tar.gz",
    "linux-x86_64": prefix + "linux-x64.AppImage",
    "linux-x86_64-appimage": prefix + "linux-x64.AppImage",
    "linux-x86_64-deb": prefix + "linux-x64.deb",
  };
}
export async function signLegacyFile(file, publicKey) {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== repository ||
    !process.env.TAURI_SIGNING_PRIVATE_KEY
  )
    throw new Error("旧版兼容包必须在 GitHub Actions 中使用现有 TAURI_SIGNING_PRIVATE_KEY 签名");
  try {
    execFileSync("pnpm", ["dlx", "@tauri-apps/cli@2.11.2", "signer", "sign", file], {
      // 不向命令行传递密钥，不输出可能携带密钥的 CLI 诊断。
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180000,
    });
  } catch {
    throw new Error("旧版签名失败，请检查原有 Tauri 密钥及密码；未输出签名器内部诊断");
  }
  const signature = (await readFile(file + ".sig", "utf8")).trim();
  await verifyLegacySignature(file, signature, publicKey);
  return signature;
}
async function inventory(file) {
  return {
    name: path.basename(file),
    bytes: (await stat(file)).size,
    sha256: (await digest(file, "sha256")).toString("hex"),
  };
}
export async function writeLegacyManifest(directory, version, files, notes = "") {
  const key = JSON.parse(await readFile(publicFile, "utf8"));
  const targets = legacyTargets(version),
    signatures = new Map(),
    output = [];
  for (const name of new Set(Object.values(targets))) {
    const source = files.filter((file) => file.name === name),
      file = path.join(directory, name);
    const actual = await inventory(file);
    if (
      source.length !== 1 ||
      source[0].bytes !== actual.bytes ||
      source[0].sha256 !== actual.sha256
    )
      throw new Error("缺少已验证的旧版兼容附件：" + name);
    signatures.set(name, await signLegacyFile(file, key.publicKey));
    output.push(await inventory(file + ".sig"));
  }
  const manifest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: Object.fromEntries(
      Object.entries(targets).map(([target, name]) => [
        target,
        {
          url: `https://github.com/${repository}/releases/download/v${version}/${name}`,
          signature: signatures.get(name),
        },
      ]),
    ),
  };
  const file = path.join(directory, "latest.json");
  await writeFile(file, JSON.stringify(manifest, null, 2) + "\n");
  output.push(await inventory(file));
  await verifyLegacyRelease(directory, version, [...files, ...output], key.publicKey);
  return output;
}
export async function verifyLegacyRelease(directory, version, files, publicKey) {
  const manifest = JSON.parse(await readFile(path.join(directory, "latest.json"), "utf8"));
  const targets = legacyTargets(version);
  if (
    manifest.version !== version ||
    !manifest.pub_date ||
    !Number.isFinite(Date.parse(manifest.pub_date)) ||
    Object.keys(manifest.platforms ?? {})
      .sort()
      .join() !== Object.keys(targets).sort().join()
  )
    throw new Error("旧版更新清单的版本或平台不完整，禁止公开发布");
  const expected = new Set([
    "latest.json",
    ...Object.values(targets),
    ...Object.values(targets).map((name) => name + ".sig"),
  ]);
  for (const name of expected) {
    const found = files.filter((file) => file.name === name),
      actual = await inventory(path.join(directory, name));
    if (found.length !== 1 || found[0].sha256 !== actual.sha256 || found[0].bytes !== actual.bytes)
      throw new Error("旧版兼容发布清单缺少可信附件：" + name);
  }
  const verified = new Set();
  for (const [target, name] of Object.entries(targets)) {
    const entry = manifest.platforms[target];
    if (
      entry.url !== `https://github.com/${repository}/releases/download/v${version}/${name}` ||
      entry.signature !== (await readFile(path.join(directory, name + ".sig"), "utf8")).trim()
    )
      throw new Error("旧版更新地址或签名不匹配");
    if (!verified.has(name))
      await verifyLegacySignature(path.join(directory, name), entry.signature, publicKey);
    verified.add(name);
  }
}
async function proof() {
  const key = JSON.parse(await readFile(publicFile, "utf8"));
  const output = "build/update-key";
  await mkdir(output, { recursive: true });
  const payload = JSON.stringify({
    purpose: "JAVM legacy Tauri signing verification",
    source: key.source,
    run: `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  });
  const file = path.join(output, "legacy-proof.txt");
  await writeFile(file, payload);
  const signature = await signLegacyFile(file, key.publicKey);
  const keyId = await verifyLegacySignature(file, signature, key.publicKey);
  await writeFile(
    path.join(output, "legacy-verification.json"),
    JSON.stringify({ payload, signature, keyId, verifiedAt: new Date().toISOString() }, null, 2) +
      "\n",
  );
  console.log("原有 Tauri 私钥与 0.5.3 公钥匹配，兼容签名验证通过。");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "verify-key")
    throw new Error("用法：node scripts/legacy-update.mjs verify-key");
  proof().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
