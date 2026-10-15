// 私钥仅在 GitHub runner 内存中生成；导出物只包含公钥、签名和密文。
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const algorithm = "ECDSA-P256-SHA256";
const output = "build/update-key";
const publicFile = "resources/update-public-key.json";
const mode = process.argv[2] ?? "verify";
const repository = "ddmoyu/javm";
function publicKeyHex(key) {
  const jwk = createPublicKey(key).export({ format: "jwk" });
  if (jwk.crv !== "P-256") throw new Error("更新签名必须使用 P-256 密钥");
  return (
    "04" +
    Buffer.from(jwk.x, "base64url").toString("hex") +
    Buffer.from(jwk.y, "base64url").toString("hex")
  );
}
async function save(name, data) {
  await writeFile(`${output}/${name}`, JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
}
async function main() {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== repository)
    throw new Error("签名密钥操作仅允许在 ddmoyu/javm 的 GitHub Actions 中执行");
  if (!["bootstrap", "verify"].includes(mode)) throw new Error("仅支持 bootstrap 或 verify");
  const existing = JSON.parse(await readFile(publicFile, "utf8"));
  await mkdir(output, { recursive: true });
  const run = `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  if (mode === "bootstrap" && !existing.publicKeyHex) {
    if (process.env.JAVM_UPDATE_PRIVATE_KEY) throw new Error("仓库已有签名私钥，禁止自动覆盖");
    const recipient = process.env.JAVM_ACTIONS_PUBLIC_KEY;
    const keyId = process.env.JAVM_ACTIONS_PUBLIC_KEY_ID;
    if (!recipient || Buffer.from(recipient, "base64").length !== 32 || !/^\d+$/.test(keyId ?? ""))
      throw new Error("缺少 GitHub Actions 的加密公钥");
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicHex = publicKeyHex(privateKey);
    const pem = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }));
    let encrypted;
    try {
      encrypted = execFileSync(
        "python3",
        [
          "-c",
          `
import base64, ctypes, ctypes.util, os, sys
lib = ctypes.CDLL(ctypes.util.find_library('sodium'))
lib.sodium_init.restype = ctypes.c_int
assert lib.sodium_init() >= 0
lib.crypto_box_seal.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulonglong, ctypes.c_void_p]
lib.crypto_box_seal.restype = ctypes.c_int
msg = bytearray(sys.stdin.buffer.read())
source = (ctypes.c_ubyte * len(msg)).from_buffer(msg)
recipient = base64.b64decode(os.environ['JAVM_ACTIONS_PUBLIC_KEY'], validate=True)
assert len(recipient) == 32
destination = ctypes.create_string_buffer(len(msg) + 48)
assert lib.crypto_box_seal(destination, source, len(msg), recipient) == 0
for i in range(len(msg)): msg[i] = 0
sys.stdout.write(base64.b64encode(destination.raw).decode('ascii'))
`,
        ],
        { input: pem, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
    } finally {
      pem.fill(0);
    }
    await save("sealed-secret.json", { encrypted_value: encrypted, key_id: keyId });
    await save("public-key.json", {
      algorithm,
      publicKeyHex: publicHex,
      fingerprintSha256: createHash("sha256").update(Buffer.from(publicHex, "hex")).digest("hex"),
      createdAt: new Date().toISOString(),
      generatedBy: run,
      secretName: "JAVM_UPDATE_PRIVATE_KEY",
    });
    const payload = JSON.stringify({
      purpose: "JAVM update signing key bootstrap",
      repository,
      run,
      publicKeyHex: publicHex,
    });
    await save("proof.json", {
      payload,
      signature: sign("sha256", Buffer.from(payload), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("hex"),
    });
    console.log("已生成更新密钥；导出公钥和仅 GitHub 可解密的私钥密文。");
  } else {
    if (existing.algorithm !== algorithm || !/^04[0-9a-f]{128}$/.test(existing.publicKeyHex ?? ""))
      throw new Error("更新公钥尚未配置");
    if (!process.env.JAVM_UPDATE_PRIVATE_KEY)
      throw new Error("缺少 JAVM_UPDATE_PRIVATE_KEY secret");
    const key = createPrivateKey(process.env.JAVM_UPDATE_PRIVATE_KEY);
    if (publicKeyHex(key) !== existing.publicKeyHex)
      throw new Error("GitHub secret 与仓库公钥不匹配");
    const payload = JSON.stringify({
      purpose: "JAVM update signing secret verification",
      repository,
      run,
      publicKeyHex: existing.publicKeyHex,
    });
    const signature = sign("sha256", Buffer.from(payload), { key, dsaEncoding: "ieee-p1363" });
    if (
      !verify(
        "sha256",
        Buffer.from(payload),
        { key: createPublicKey(key), dsaEncoding: "ieee-p1363" },
        signature,
      )
    )
      throw new Error("签名自检失败");
    await save("verification.json", {
      payload,
      signature: signature.toString("hex"),
      verifiedAt: new Date().toISOString(),
    });
    console.log("GitHub secret 与仓库公钥匹配，签名自检通过。");
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
