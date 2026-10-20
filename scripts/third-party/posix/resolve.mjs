import { execFileSync } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { findRelease } from "../github.mjs";
import { components, root, specification, target, targets } from "./common.mjs";
import { downloadAndVerify, requirePublishedRelease } from "./artifact.mjs";

if (process.argv.length > 2 || !targets.includes(target))
  throw new Error("不支持的组件安装参数或平台；本命令只下载和校验已发布组件");
const repository = "ddmoyu/javm";
const gh = (args) =>
  execFileSync("gh", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180000,
  });
const specifications = await Promise.all(components.map((name) => specification(name)));
// Check the whole set before installing anything. Missing, draft or incomplete
// components fail here; this consumer has no source-build or publish path.
const releases = new Map(
  specifications.map((spec) => [
    spec.tag,
    requirePublishedRelease(findRelease(gh, repository, spec.tag), spec),
  ]),
);
const destination = path.join(root, "build/dependencies", target);
await mkdir(destination, { recursive: true });
const resolved = { schema: 1, platform: target, components: {} };
for (const spec of specifications) {
  const release = releases.get(spec.tag);
  const { payload, manifest, digest, archive } = await downloadAndVerify(spec, destination, gh);
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
  if (spec.component !== "mediainfo" && spec.component !== "neutralino") {
    await mkdir(tools, { recursive: true });
    await cp(path.join(payload, "runtime"), tools, { recursive: true });
  }
  await mkdir(path.join(root, "bin/licenses"), { recursive: true });
  await cp(path.join(payload, "licenses"), path.join(root, "bin/licenses", spec.component), {
    recursive: true,
  });
  console.log(`${spec.component}: 已校验并复用 ${spec.tag}`);
}
await writeFile(path.join(destination, "resolved.json"), JSON.stringify(resolved, null, 2) + "\n");
await writeFile(
  path.join(destination, "paths.cmake"),
  specifications
    .map(
      (spec) =>
        `set(JAVM_PREBUILT_${spec.component.toUpperCase()} "${resolved.components[spec.component].path.replaceAll("\\", "/")}")`,
    )
    .join("\n") + "\n",
);
