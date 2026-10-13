import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { findRelease } from "../github.mjs";
import {
  components,
  inside,
  json,
  root,
  run,
  sha256,
  specification,
  target,
  targets,
  verifyInventory,
} from "./common.mjs";
import { buildComponent } from "./build.mjs";
import { verifyRuntime } from "./verify.mjs";

const publish = process.argv.includes("--publish-missing");
if (process.argv.slice(2).some((arg) => arg !== "--publish-missing") || !targets.includes(target))
  throw new Error("不支持的组件安装参数或平台");
const repository = "ddmoyu/javm";
const gh = (args) =>
  execFileSync("gh", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180000,
  });
const releases = new Map();
const reserved = new Set();
const specifications = await Promise.all(components.map((name) => specification(name)));
const destination = path.join(root, "build/dependencies", target);
await mkdir(destination, { recursive: true });
const resolved = { schema: 1, platform: target, components: {} };
try {
  // 长构建前固定标签到当前提交。已存在的正式组件只读复用，不覆盖附件。
  for (const spec of specifications) {
    let release = findRelease(gh, repository, spec.tag);
    if (!release && publish) {
      const notes = path.join(destination, `${spec.component}-notes.txt`);
      await writeFile(
        notes,
        `JAVM ${spec.component} / ${target}\n\n构建指纹：${spec.fingerprint}\n最低系统：${spec.inputs.baseline}\n\n仅包含已验证组件，不作为 JAVM Latest。\n`,
      );
      gh([
        "release",
        "create",
        spec.tag,
        "--repo",
        repository,
        "--draft",
        "--latest=false",
        "--target",
        process.env.GITHUB_SHA || (await run("git", ["rev-parse", "HEAD"], root, true)),
        "--title",
        `${spec.component} / ${target}`,
        "--notes-file",
        notes,
      ]);
      release = findRelease(gh, repository, spec.tag);
      reserved.add(release.id);
    }
    if (!release || (release.draft && !reserved.has(release.id)))
      throw new Error(`缺少已验证组件，或同指纹的构建尚未完成：${spec.tag}`);
    releases.set(spec.tag, release);
  }
  for (const spec of specifications) {
    let release = releases.get(spec.tag);
    if (release.draft) {
      const built = await buildComponent(spec.component);
      const manifest = path.join(path.dirname(built.archive), `${spec.tag}.json`);
      gh([
        "release",
        "upload",
        spec.tag,
        built.archive,
        `${built.archive}.sha256`,
        manifest,
        "--repo",
        repository,
      ]);
    }
    // 从 GitHub 回读实际附件，哈希与运行均通过后才公开组件并安装。
    const stage = await mkdtemp(path.join(destination, `${spec.component}-`));
    gh(["release", "download", spec.tag, "--repo", repository, "--dir", stage]);
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
    assert.equal(manifest.fingerprint, spec.fingerprint);
    assert.equal(manifest.platform, target);
    assert.equal(manifest.tag, spec.tag);
    assert.deepEqual(manifest.inputs, spec.inputs);
    assert.equal(manifest.verification?.passed, true);
    const publishedManifest = await json(path.join(stage, `${spec.tag}.json`));
    assert.deepEqual(manifest, publishedManifest);
    await verifyInventory(payload, manifest);
    await verifyRuntime(payload, spec);
    if (release.draft) {
      gh(["release", "edit", spec.tag, "--repo", repository, "--draft=false", "--latest=false"]);
      release = findRelease(gh, repository, spec.tag);
    }
    if (release.draft) throw new Error("组件仍未公开");
    resolved.components[spec.component] = {
      fingerprint: spec.fingerprint,
      tag: spec.tag,
      releaseId: release.id,
      releaseUrl: release.html_url,
      sourceCommit: manifest.sourceCommit,
      archive: { name: path.basename(archive), sha256: digest },
      path: payload,
    };
    const tools = path.join(root, "bin/tools", spec.component === "metatube" ? "metatube" : "");
    if (spec.component !== "mediainfo") {
      await mkdir(tools, { recursive: true });
      await cp(path.join(payload, "runtime"), tools, { recursive: true });
    }
    await mkdir(path.join(root, "bin/licenses"), { recursive: true });
    await cp(path.join(payload, "licenses"), path.join(root, "bin/licenses", spec.component), {
      recursive: true,
    });
    console.log(`${spec.component}: 已校验 ${spec.tag}`);
  }
  await writeFile(
    path.join(destination, "resolved.json"),
    JSON.stringify(resolved, null, 2) + "\n",
  );
  await writeFile(
    path.join(destination, "paths.cmake"),
    specifications
      .map(
        (spec) =>
          `set(JAVM_PREBUILT_${spec.component.toUpperCase()} "${resolved.components[spec.component].path.replaceAll("\\", "/")}")`,
      )
      .join("\n") + "\n",
  );
} catch (error) {
  console.error(error);
  for (const release of releases.values()) {
    if (!reserved.has(release.id)) continue;
    const current = findRelease(gh, repository, release.tag_name);
    if (current?.draft && current.id === release.id) {
      // 草稿尚未创建 Git tag；删除不存在的 tag 会掩盖真正的构建错误。
      try {
        gh(["release", "delete", release.tag_name, "--repo", repository, "--yes"]);
      } catch (cleanupError) {
        console.error(`草稿清理失败: ${release.tag_name}`, cleanupError);
      }
    }
  }
  throw error;
}
