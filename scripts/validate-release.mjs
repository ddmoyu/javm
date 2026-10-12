import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const tag = process.env.RELEASE_TAG;
assert.match(
  tag || "",
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.[1-9]\d*)?$/,
);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const config = JSON.parse(await readFile("neutralino.config.json", "utf8"));
assert.equal(tag, `v${pkg.version}`);
assert.equal(config.version, pkg.version);
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (process.env.RELEASE_PUBLISH === "true")
  assert.equal(
    commit,
    execFileSync("git", ["rev-parse", `${tag}^{commit}`], { encoding: "utf8" }).trim(),
  );
else assert.equal(commit, process.env.SOURCE_COMMIT);
await access(`docs/releases/${tag}.md`);
console.log(`Release source verified: ${tag} @ ${commit}`);
