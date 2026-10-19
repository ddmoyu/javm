import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  currentSpecification,
  componentSpecification,
  reuseRecordedSpecification,
} from "./fingerprint.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const migration = JSON.parse(await readFile(new URL("./reuse-v1.json", import.meta.url), "utf8"));
const keys = Object.keys(migration.entries);
const current = new Map(
  await Promise.all(
    keys.map(async (key) => {
      const [platform, component] = key.split("/");
      return [key, await currentSpecification(component, platform)];
    }),
  ),
);

await test("迁移保持全部 19 组已发布身份及真实构建输入", async () => {
  assert.equal(keys.length, 19);
  for (const [key, record] of Object.entries(migration.entries)) {
    const [platform, component] = key.split("/");
    const spec = current.get(key);
    assert.match(record.recipeFingerprint, /^[a-f0-9]{64}$/);
    const matchesMigration = record.recipeFingerprint === spec.fingerprint;
    assert.deepEqual(
      await componentSpecification(component, platform),
      matchesMigration ? record.specification : spec,
    );
    for (const [file, hash] of Object.entries(record.specification.inputs.files)) {
      if (
        ["scripts/third-party/components.mjs", "scripts/third-party/posix/common.mjs"].includes(
          file,
        )
      )
        continue;
      if (matchesMigration)
        assert.equal(spec.inputs.files[file], hash, `迁移不得改变原构建配方：${key} / ${file}`);
    }
    const changed = { ...spec, fingerprint: "0".repeat(64) };
    assert.equal(reuseRecordedSpecification(changed, record), changed);
    assert.throws(() =>
      reuseRecordedSpecification(
        { ...spec, fingerprint: record.recipeFingerprint },
        {
          ...record,
          specification: { ...record.specification, fingerprint: "0".repeat(64) },
        },
      ),
    );
  }
});

await test("逐个修改组件配方只使对应组件和平台失效", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "javm-recipe-isolation-"));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
    assert.match(path.basename(directory), /^javm-recipe-isolation-/);
    await rm(directory, { recursive: true, force: true });
  });
  const files = new Set([
    "scripts/offline-dependencies.json",
    "scripts/third-party/posix/sources.json",
    ...[...current.values()].flatMap((spec) => Object.keys(spec.inputs.files)),
  ]);
  for (const file of files) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await copyFile(path.join(root, file), path.join(directory, file));
  }
  const verifyChanged = async (expected) => {
    const changed = [];
    for (const [key, spec] of current) {
      const [platform, component] = key.split("/");
      const next = await currentSpecification(component, platform, directory);
      if (next.fingerprint !== spec.fingerprint) changed.push(key);
    }
    assert.deepEqual(changed, keys.filter(expected));
  };
  const mutate = async (file, transform, expected) => {
    const absolute = path.join(directory, file);
    const before = await readFile(absolute, "utf8");
    try {
      await writeFile(absolute, transform(before));
      await verifyChanged(expected);
    } finally {
      await writeFile(absolute, before);
    }
  };
  const fixture = "tests/fixtures/safe-component-patch.txt";
  await mkdir(path.dirname(path.join(directory, fixture)), { recursive: true });
  await writeFile(path.join(directory, fixture), "safe fictional fixture\n");
  for (const family of ["windows", "posix"]) {
    for (const component of family === "windows"
      ? ["curl", "mediainfo", "ffmpeg", "metatube"]
      : ["curl", "mediainfo", "ffmpeg", "metatube", "neutralino"]) {
      await mutate(
        `scripts/third-party/recipes/${family}/${component}.json`,
        (text) => {
          const recipe = JSON.parse(text);
          recipe.files.push(fixture);
          return JSON.stringify(recipe);
        },
        (key) =>
          key.endsWith(`/${component}`) && key.startsWith("windows-") === (family === "windows"),
      );
    }
  }
  await mutate(
    "scripts/metatube-lite/diagnostics/engine.go",
    (text) => text + "\n// safe change\n",
    (key) => key.endsWith("/metatube"),
  );
  await mutate(
    "scripts/offline-dependencies.json",
    (text) => {
      const sources = JSON.parse(text);
      sources.curl.version = "safe-next-version";
      return JSON.stringify(sources);
    },
    (key) => key.endsWith("/curl"),
  );
  await mutate(
    "scripts/third-party/verify.mjs",
    (text) => text + "\n// common verifier change\n",
    (key) => key.startsWith("windows-"),
  );
  await mutate(
    "scripts/third-party/posix/verify.mjs",
    (text) => text + "\n// common verifier change\n",
    (key) => !key.startsWith("windows-"),
  );
  await writeFile(path.join(directory, "package.json"), '{"version":"99.99.99"}');
  await writeFile(path.join(directory, "neutralino.config.json"), '{"version":"99.99.99"}');
  await verifyChanged(() => false);
});
