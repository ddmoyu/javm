import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));

export function nativeBuildPlan(platform, args = []) {
  const names = new Map([
    ["fresh", "Fresh"],
    ["release", "Release"],
    ["portabilitychecks", "PortabilityChecks"],
    ["coreonly", "CoreOnly"],
    ["curltransport", "CurlTransport"],
  ]);
  const flags = new Set();
  for (const arg of args) {
    const name = /^--?[a-z-]+$/i.test(arg) && names.get(arg.replaceAll("-", "").toLowerCase());
    if (!name) throw new Error(`Unknown native build option: ${arg}`);
    flags.add(name);
  }
  const has = (name) => flags.has(name);
  if (
    (has("Release") && (has("PortabilityChecks") || has("CoreOnly") || has("CurlTransport"))) ||
    (has("PortabilityChecks") && (has("CoreOnly") || has("CurlTransport"))) ||
    (has("CurlTransport") && !has("CoreOnly"))
  ) {
    throw new Error(
      "Use --core-only with optional --curl-transport, --portability-checks, or --release separately.",
    );
  }
  if (!["win32", "linux", "darwin"].includes(platform))
    throw new Error(`Unsupported platform: ${platform}`);
  if (platform === "win32") {
    return [
      {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(root, "scripts/build-native.ps1"),
          ...[...flags].map((flag) => `-${flag}`),
        ],
      },
    ];
  }
  const fresh = has("Fresh") ? ["--fresh"] : [];
  if (has("PortabilityChecks")) {
    return [
      {
        command: "cmake",
        args: [
          ...fresh,
          "-S",
          "tests/native",
          "-B",
          "build/native/portability-checks",
          "-G",
          "Ninja",
          "-DCMAKE_BUILD_TYPE=Debug",
        ],
      },
      { command: "cmake", args: ["--build", "build/native/portability-checks"] },
    ];
  }
  const preset = `${platform === "darwin" ? "macos" : "linux"}-${has("CoreOnly") ? "core" : has("Release") ? "release" : "app"}`;
  return [
    { command: "cmake", args: [...fresh, "--preset", preset] },
    { command: "cmake", args: ["--build", "--preset", preset] },
  ];
}

async function run(command, args, env, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      windowsHide: true,
      stdio: capture ? ["ignore", "pipe", "ignore"] : "inherit",
    });
    let output = "";
    if (capture)
      child.stdout.on("data", (data) => {
        output += data;
      });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${command} failed (${signal ?? code})`));
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const plan = nativeBuildPlan(process.platform, process.argv.slice(2));
    const env = { ...process.env };
    if (process.platform === "darwin") {
      // 只发现已安装的 SDK，不自动安装或修改开发机。
      for (const [key, formula] of [
        ["OPENSSL_ROOT_DIR", "openssl@3"],
        ["ICU_ROOT", "icu4c"],
      ]) {
        if (env[key]) continue;
        try {
          env[key] = await run("brew", ["--prefix", formula], env, true);
        } catch {
          /* CMake 继续使用系统搜索路径，缺失时报告依赖错误。 */
        }
      }
    }
    for (const step of plan) await run(step.command, step.args, env);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
