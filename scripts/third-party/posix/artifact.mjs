import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { inside, json, root, run, sha256, verifyInventory } from "./common.mjs";
import { verifyRuntime } from "./verify.mjs";

export function completeRelease(release, spec) {
  return Boolean(
    release &&
    !release.draft &&
    !release.prerelease &&
    release.tag_name === spec.tag &&
    [`${spec.tag}.tar.gz`, `${spec.tag}.tar.gz.sha256`, `${spec.tag}.json`].every((name) =>
      release.assets?.some((asset) => asset.name === name && asset.size > 0),
    ),
  );
}

export function requirePublishedRelease(release, spec) {
  if (!completeRelease(release, spec))
    throw new Error(
      `缺少已发布且完整的组件：${spec.tag}。请先运行“第三方精简组件”工作流；应用打包不会编译组件。`,
    );
  return release;
}

export async function downloadAndVerify(spec, destination, gh) {
  await mkdir(destination, { recursive: true });
  const stage = await mkdtemp(path.join(destination, `${spec.component}-`));
  gh(["release", "download", spec.tag, "--repo", "ddmoyu/javm", "--dir", stage]);
  const archive = path.join(stage, `${spec.tag}.tar.gz`);
  const digest = sha256(await readFile(archive));
  assert.equal(
    (await readFile(`${archive}.sha256`, "utf8")).split(/\s+/)[0],
    digest,
    "组件附件哈希不一致",
  );
  const listing = await run("tar", ["-tf", archive], root, true);
  for (const name of listing.split("\n")) {
    const relative = name.replace(/^\.\//, "").replace(/\/$/, "");
    if (relative) inside(stage, relative);
  }
  const detail = await run("tar", ["-tvf", archive], root, true);
  if (detail.split("\n").some((line) => line && !/^[d-]/.test(line)))
    throw new Error("组件归档不接受链接或特殊文件");
  const payload = path.join(stage, "payload");
  await mkdir(payload);
  await run("tar", ["-xf", archive, "-C", payload]);
  const manifest = await json(path.join(payload, "manifest.json"));
  assert.equal(manifest.component, spec.component);
  assert.equal(manifest.fingerprint, spec.fingerprint);
  assert.equal(manifest.platform, spec.platform);
  assert.equal(manifest.tag, spec.tag);
  assert.deepEqual(manifest.inputs, spec.inputs);
  assert.equal(manifest.verification?.passed, true);
  assert.deepEqual(manifest, await json(path.join(stage, `${spec.tag}.json`)));
  await verifyInventory(payload, manifest);
  await verifyRuntime(payload, spec);
  return { payload, manifest, digest, archive };
}
