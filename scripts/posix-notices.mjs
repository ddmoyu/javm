import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { root, run, sha256 } from "./third-party/posix/common.mjs";

// Component archives contain their own notices. Add the application's bundled
// frontend and native header-library notices without depending on a global cache.
export async function applicationNotices(nativeBuild) {
  const documents = new Map();
  const collect = async (file, label) => {
    const text = await readFile(file, "utf8");
    const key = sha256(text);
    const document = documents.get(key) ?? { text, labels: new Set() };
    document.labels.add(label);
    documents.set(key, document);
  };
  for (const file of ["Neutralino.txt", "phosphor-icons-react.txt"])
    await collect(path.join(root, "resources/licenses", file), file);
  await collect(
    path.join(nativeBuild, "_deps/nlohmann_json-src/LICENSE.MIT"),
    "nlohmann-json / LICENSE.MIT",
  );
  const licenses = JSON.parse(
    await run("pnpm", ["licenses", "list", "--prod", "--json"], root, true),
  );
  for (const packages of Object.values(licenses)) {
    for (const entry of packages) {
      const directory = entry.paths[0];
      for (const file of await readdir(directory)) {
        if (
          /^(license|licence|copying|notice)(\.|$)/i.test(file) &&
          (await stat(path.join(directory, file))).isFile()
        )
          await collect(path.join(directory, file), `${entry.name}@${entry.version} / ${file}`);
      }
    }
  }
  return (
    [...documents.values()]
      .map(
        ({ labels, text }) =>
          `${[...labels].sort((a, b) => a.localeCompare(b)).join("\n")}\n${"=".repeat(72)}\n${text}`,
      )
      .join("\n\n") + "\n"
  );
}
