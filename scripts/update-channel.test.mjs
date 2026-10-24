import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { publicKeyHex, signManifest } from "./update-format.mjs";
import { updateManifest } from "./update-release.mjs";
import {
  betaChannelTag,
  newestUpdateRelease,
  publishBetaChannel,
  verifyChannelManifest,
} from "./update-channel.mjs";

// 全部发布、附件和密钥均为安全虚构数据，gh 由内存端口替代，不连接网络。
const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const privateKey = keys.privateKey.export({ format: "pem", type: "pkcs8" });
const publicHex = publicKeyHex(privateKey);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const manifestName = "JAVM-update.json";
function release(version, id = 1) {
  const files = [
    ["windows-x64", "-update.jup"],
    ["windows-x64", "-setup.exe"],
    ["macos-x64", "-update.jup"],
    ["macos-arm64", "-update.jup"],
    ["linux-x64", "-update.jup"],
    ["linux-x64", ".AppImage"],
    ["linux-x64", ".deb"],
  ].map(([platform, suffix]) => ({
    name: `JAVM-${version}-${platform}${suffix}`,
    bytes: 4,
    sha256: hash("safe"),
  }));
  const payload = updateManifest(version, files);
  const data = Buffer.from(JSON.stringify(signManifest(payload, privateKey)) + "\n");
  return {
    data,
    payload,
    record: {
      id,
      tag_name: `v${version}`,
      draft: false,
      prerelease: version.includes("-beta."),
      assets: [...files, { name: manifestName, bytes: data.length, sha256: hash(data) }].map(
        (file) => ({
          name: file.name,
          size: file.bytes,
          digest: `sha256:${file.sha256}`,
          state: "uploaded",
        }),
      ),
    },
  };
}

async function fixture(t, versions = ["1.2.0-beta.2"]) {
  const temporaryRoot = path.resolve(".tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(path.join(temporaryRoot, "beta-channel-safe-"));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(temporaryRoot + path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  const releases = versions.map((version, index) => release(version, index + 1));
  const state = { channel: null, channelData: null, calls: [], corruptReadback: false };
  const gh = (args) => {
    state.calls.push(args);
    if (args[0] === "api") {
      if (args[1].includes("?per_page=100&page=1"))
        return JSON.stringify(releases.map((entry) => entry.record));
      if (args[1].endsWith("/releases/1000") && state.channel) return JSON.stringify(state.channel);
    }
    if (args[0] === "release") {
      const option = (name) => args[args.indexOf(name) + 1];
      if (args[1] === "view") {
        if (state.channel) return JSON.stringify({ databaseId: 1000 });
        const error = new Error("fixture missing release");
        error.stderr = "release not found";
        throw error;
      }
      if (args[1] === "download") {
        let data =
          args[2] === betaChannelTag
            ? state.channelData
            : releases.find((entry) => entry.record.tag_name === args[2])?.data;
        if (state.corruptReadback && path.basename(option("--dir")) === "readback")
          data = Buffer.from("invalid safe fixture");
        assert.ok(data);
        writeFileSync(path.join(option("--dir"), manifestName), data);
        return "";
      }
      if (args[1] === "create") {
        assert.ok(
          args.includes("--draft") &&
            args.includes("--prerelease") &&
            args.includes("--latest=false"),
        );
        state.channel = {
          id: 1000,
          tag_name: betaChannelTag,
          draft: true,
          prerelease: true,
          assets: [],
        };
        return "";
      }
      if (args[1] === "upload") {
        state.channelData = readFileSync(args[3]);
        state.channel.assets = [
          {
            name: manifestName,
            size: state.channelData.length,
            digest: `sha256:${hash(state.channelData)}`,
            state: "uploaded",
          },
        ];
        return "";
      }
      if (args[1] === "edit") {
        assert.ok(
          args.includes("--draft=false") &&
            args.includes("--prerelease") &&
            args.includes("--latest=false"),
        );
        state.channel.draft = false;
        return "";
      }
    }
    throw new Error("未声明的发布端口调用：" + JSON.stringify(args));
  };
  return {
    state,
    releases,
    run: () =>
      publishBetaChannel({
        gh,
        repository: "safe/fixture",
        commit: "a".repeat(40),
        directory,
        publicKeyHex: publicHex,
      }),
    previous(value, draft = false) {
      state.channel = {
        id: 1000,
        tag_name: betaChannelTag,
        draft,
        prerelease: true,
        assets: [{ name: manifestName }],
      };
      state.channelData = value.data;
    },
  };
}

test("选择最高正式或 Beta 数值版本，忽略草稿、Alpha、组件和缺少清单的版本", () => {
  const records = ["1.2.0-beta.2", "1.2.0-beta.10", "1.2.0", "1.3.0-beta.1"].map(
    (version) => release(version).record,
  );
  const excluded = [
    { ...records[0], tag_name: "v9.0.0-alpha.1", prerelease: true },
    { ...records[0], tag_name: "v9.0.0", prerelease: false, draft: true },
    { ...records[0], tag_name: "v9.0.0", prerelease: false, assets: [] },
    { ...records[0], tag_name: "deps-safe" },
    { ...records[0], tag_name: betaChannelTag },
  ];
  assert.equal(newestUpdateRelease([...excluded, ...records]).tag_name, "v1.3.0-beta.1");
  assert.equal(newestUpdateRelease(records.slice(0, 3)).tag_name, "v1.2.0");
  assert.equal(newestUpdateRelease(records.slice(0, 2)).tag_name, "v1.2.0-beta.10");
});

test("复制原始签名清单并回读验证，通道始终为非 Latest 的预发布", async (t) => {
  const f = await fixture(t, ["1.2.0", "1.3.0-beta.1"]);
  assert.equal(await f.run(), "1.3.0-beta.1");
  assert.deepEqual(f.state.channelData, f.releases[1].data);
  assert.equal(f.state.channel.draft, false);
  assert.equal(f.state.channel.prerelease, true);
  assert.equal(f.state.channel.assets.length, 1);
});

test("发布正式版后 Beta 通道转向更高正式版，较低正式版不覆盖已有较高 Beta", async (t) => {
  const f = await fixture(t, ["1.2.0-beta.10", "1.2.0", "1.1.9"]);
  f.previous(f.releases[0]);
  assert.equal(await f.run(), "1.2.0");
  const next = await fixture(t, ["1.2.0", "1.3.0-beta.2"]);
  next.previous(next.releases[1]);
  assert.equal(await next.run(), "1.3.0-beta.2");
  assert.equal(
    next.state.calls.some((args) => args[1] === "upload"),
    false,
  );
});

test("通道同步可恢复已上传草稿，拒绝倒退和同版本不同内容", async (t) => {
  const f = await fixture(t);
  f.previous(f.releases[0], true);
  assert.equal(await f.run(), "1.2.0-beta.2");
  assert.equal(f.state.channel.draft, false);
  const older = await fixture(t);
  older.previous(release("2.0.0-beta.1"));
  await assert.rejects(older.run(), /较旧版本/);
  const changed = await fixture(t);
  changed.previous(release("1.2.0-beta.2"));
  await assert.rejects(changed.run(), /同一版本/);
});

test("拒绝无效签名、版本错配、平台错配和过大的通道清单", () => {
  const value = release("1.2.0-beta.2");
  assert.equal(verifyChannelManifest(value.data, publicHex).version, "1.2.0-beta.2");
  const bad = JSON.parse(value.data);
  bad.payload = bad.payload.replace("1.2.0-beta.2", "9.0.0-beta.2");
  assert.throws(() => verifyChannelManifest(JSON.stringify(bad), publicHex), /签名/);
  assert.throws(() => verifyChannelManifest(value.data, publicHex, "1.2.0"), /不匹配/);
  value.payload.assets[0].platform = "linux-x64";
  assert.throws(
    () => verifyChannelManifest(JSON.stringify(signManifest(value.payload, privateKey)), publicHex),
    /平台/,
  );
  assert.throws(() => verifyChannelManifest(" ".repeat(65537), publicHex), /无效/);
});

test("附件缺失或哈希不符时停止，不改动已有 Beta 清单", async (t) => {
  for (const corrupt of [
    (value) => value.record.assets.shift(),
    (value) => {
      value.record.assets[0].digest = "sha256:" + "0".repeat(64);
    },
    (value) => {
      value.record.assets.at(-1).size++;
    },
  ]) {
    const f = await fixture(t);
    corrupt(f.releases[0]);
    await assert.rejects(f.run(), /附件|回读哈希/);
    assert.equal(
      f.state.calls.some((args) => ["create", "upload", "edit"].includes(args[1])),
      false,
    );
  }
});

test("通道上传后回读损坏时失败，新入口保持草稿", async (t) => {
  const f = await fixture(t);
  f.state.corruptReadback = true;
  await assert.rejects(f.run());
  assert.equal(f.state.channel.draft, true);
  assert.equal(
    f.state.calls.some((args) => args[1] === "edit"),
    false,
  );
});
