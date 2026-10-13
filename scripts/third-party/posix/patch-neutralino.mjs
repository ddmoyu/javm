import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function escapeGlobalStrings(source) {
  let count = 0;
  const result = source
    .replace(/("var NL_[A-Z_]+=)'" \+ (.+?) \+ "';"/g, (_match, prefix, expression) => {
      ++count;
      return `${prefix}" + helpers::jsonToString(json(${expression})) + ";"`;
    })
    .replace(
      '"=JSON.parse(\'" + helpers::jsonToString(it.value()) + "\');"',
      '"=" + helpers::jsonToString(it.value()) + ";"',
    );
  assert.equal(count, 15, "官方宿主全局变量实现已变化，需要重新审查补丁");
  return result;
}
export async function patchNeutralino(source, commit) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  const settings = path.join(source, "settings.cpp");
  await writeFile(settings, escapeGlobalStrings(await readFile(settings, "utf8")));
  const cmake = path.join(source, "CMakeLists.txt");
  const original = await readFile(cmake, "utf8");
  const patched = original.replace(
    /execute_process\(\s*COMMAND git rev-parse HEAD[\s\S]*?\n\)/,
    `set(NEU_COMMIT "${commit}+javm-globals")`,
  );
  assert.notEqual(patched, original, "源码归档的版本标识补丁未应用");
  await writeFile(cmake, patched);
}
