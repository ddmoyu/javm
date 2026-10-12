import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile, inventory } from "./dependency-bundle.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const bundle = JSON.parse(await readFile(path.join(root, "dist/offline/latest.json"), "utf8"));
const manifest = JSON.parse(await readFile(bundle.manifest, "utf8"));
const dependencyLock = JSON.parse(
  await readFile(path.join(root, "scripts/dependency-bundle.json"), "utf8"),
);
const output = path.join(root, "dist/release");
await cp(bundle.archive, path.join(output, path.basename(bundle.archive)));
const report = {
  ...manifest,
  dependencyBundle: dependencyLock,
  sourceCommit: process.env.RELEASE_COMMIT || null,
  runUrl: process.env.GITHUB_RUN_ID
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null,
  installer: JSON.parse(await readFile(path.join(root, "build/installer/receipt.json"), "utf8")),
};
delete report.installer.installer;
await writeFile(
  path.join(output, `JAVM-${pkg.version}-build-manifest.json`),
  JSON.stringify(report, null, 2),
);
const escape = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
await writeFile(
  path.join(output, "THIRD-PARTY-NOTICES.html"),
  `<!doctype html><meta charset="utf-8"><title>JAVM third-party notices</title><h1>JAVM ${escape(pkg.version)}</h1><p>Corresponding dependency sources and build recipes: <a href="https://github.com/${dependencyLock.repository}/releases/tag/${dependencyLock.tag}">${dependencyLock.tag}</a></p>${manifest.licenseNotices.map((entry) => `<h2>${escape(entry.components.join(", "))}</h2><pre>${escape(entry.text)}</pre>`).join("\n")}`,
);
const allowed = new Set([
  path.basename(bundle.archive),
  `JAVM-${pkg.version}-windows-x64-setup.exe`,
  `JAVM-${pkg.version}-build-manifest.json`,
  "THIRD-PARTY-NOTICES.html",
]);
const assets = (await inventory(output)).filter((file) => file.path !== "SHA256SUMS");
if (assets.some((file) => !allowed.has(file.path)))
  throw new Error(
    "Release output contains stale or unexpected files; use a clean dist/release directory",
  );
if (
  !assets.some((file) => file.path.endsWith("-setup.exe")) ||
  !assets.some((file) => file.path.endsWith(".zip"))
)
  throw new Error("Both installer and portable archive are required");
await writeFile(
  path.join(output, "SHA256SUMS"),
  assets.map((file) => `${file.sha256}  ${file.path}\n`).join(""),
);
console.log(
  JSON.stringify(
    {
      version: pkg.version,
      assets,
      checksumsSha256: await hashFile(path.join(output, "SHA256SUMS")),
    },
    null,
    2,
  ),
);
