import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { verifyMetatubeLite } from "./metatube-lite-profile.mjs";

// 此验证只访问本机服务，使用新建数据库和安全虚构资料；不读取用户数据库。
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "build/metatube-lite");
const dependency = JSON.parse(
  await readFile(path.join(root, "scripts/offline-dependencies.json"), "utf8"),
).metatube;
const receipt = await verifyMetatubeLite(output, dependency);
const temporary = await mkdtemp(path.join(output, "verify-"));
const token = "javm-safe-fixture-token";
let blockedRequests = 0;
const sockets = new Set();
// 上游搜索仅能到达此拒绝代理，随后验证 SQLite 的 fallback 行为。
const proxy = net.createServer((socket) => {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
  socket.once("data", () => {
    blockedRequests++;
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
const processes = new Set();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function start(executable, database) {
  const port = await freePort();
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("MT_")),
  );
  Object.assign(environment, {
    GIN_MODE: "release",
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    ALL_PROXY: proxyUrl,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    MT_MOVIE_PROVIDER_JAVBUS__PROXY: proxyUrl,
  });
  const child = spawn(
    executable,
    [
      "-bind",
      "127.0.0.1",
      "-port",
      String(port),
      "-token",
      token,
      "-dsn",
      database,
      "-request-timeout",
      "2s",
    ],
    {
      cwd: temporary,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  processes.add(child);
  let logs = "",
    exited = false,
    startError;
  const done = new Promise((resolve) => {
    child.on("error", (error) => {
      startError = error;
      exited = true;
      processes.delete(child);
      resolve();
    });
    child.on("exit", () => {
      exited = true;
      processes.delete(child);
      resolve();
    });
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      logs = (logs + chunk).slice(-4096);
    });
  const request = async (route, authorization = token) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      headers: authorization ? { Authorization: `Bearer ${authorization}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    return { status: response.status, body: await response.json() };
  };
  const stop = async () => {
    if (!exited) child.kill();
    await done;
  };
  for (let attempt = 0; attempt < 100; attempt++) {
    if (exited) throw new Error(`隔离服务启动失败：${startError?.message ?? logs}`);
    try {
      const health = await request("/v1/db/version");
      if (health.status === 200) return { request, stop };
    } catch {}
    await wait(50);
  }
  await stop();
  throw new Error(`隔离服务启动超时：${logs}`);
}

const arrayLiteral = (values) =>
  `{${values.map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`;
function snapshot(file) {
  const db = new DatabaseSync(file);
  try {
    return {
      schema: db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name")
        .all(),
      movie: db
        .prepare("SELECT * FROM movie_metadata WHERE id='DEMO-001' AND provider='JavBus'")
        .get(),
      review: db
        .prepare("SELECT * FROM movie_reviews WHERE id='DEMO-001' AND provider='JavBus'")
        .get(),
    };
  } finally {
    db.close();
  }
}

try {
  const original = path.join(output, "metatube-server-official.exe");
  const lite = path.join(output, "metatube-server.exe");
  const seed = path.join(temporary, "seed.sqlite3");
  const initial = await start(original, seed);
  await initial.stop();
  const db = new DatabaseSync(seed);
  try {
    const fixture = {
      id: "DEMO-001",
      number: "DEMO-001",
      provider: "JavBus",
      title: "安全演示资料",
      summary: "仅用于本地验证的虚构内容",
      homepage: "https://example.invalid/DEMO-001",
      director: "演示导演",
      actors: arrayLiteral(["演示人物甲", 'Demo "B"', "Demo\\C"]),
      thumb_url: "https://example.invalid/thumbnail.jpg",
      cover_url: "https://example.invalid/cover.jpg",
      big_thumb_url: "https://example.invalid/large-thumbnail.jpg",
      big_cover_url: "https://example.invalid/large-cover.jpg",
      preview_video_url: "https://example.invalid/sample.mp4",
      preview_video_hls_url: "https://example.invalid/sample.m3u8",
      preview_images: arrayLiteral(["https://example.invalid/preview.jpg"]),
      maker: "示例工作室",
      label: "演示标签",
      series: "虚构系列",
      genres: arrayLiteral(["测试", "纪录"]),
      score: 4.2,
      runtime: 120,
      release_date: "2020-01-02 00:00:00+00:00",
      created_at: "2020-01-02 00:00:00+00:00",
      updated_at: "2020-01-02 00:00:00+00:00",
    };
    const columns = Object.keys(fixture);
    db.prepare(
      `INSERT INTO movie_metadata (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    ).run(...Object.values(fixture));
    db.prepare("INSERT INTO movie_reviews (id,provider,reviews) VALUES (?,?,?)").run(
      "DEMO-001",
      "JavBus",
      JSON.stringify([
        {
          title: "安全样例",
          author: "演示用户",
          comment: "虚构验证内容",
          score: 4,
          date: "2020-01-02T00:00:00Z",
        },
      ]),
    );
  } finally {
    db.close();
  }
  const before = snapshot(seed);
  const routes = [
    ["/v1/providers", ""],
    ["/v1/db/version", token],
    ["/v1/db/version", "invalid-safe-token"],
    ["/v1/movies/JavBus/DEMO-001", token],
    ["/v1/movies/JavBus/demo-001", token],
    ["/v1/movies/search?q=DEMO-001&provider=JavBus&fallback=true", token],
    ["/v1/movies/search?q=https%3A%2F%2Fwww.javbus.com%2Fja%2FDEMO-001", token],
    ["/v1/movies/search?provider=JavBus", token],
    ["/v1/movies/SAFE_MISSING_PROVIDER/DEMO-001", token],
  ];
  const expectedStatuses = [200, 200, 401, 200, 200, 200, 200, 400, 404];
  const results = [];
  for (const [name, executable] of [
    ["official", original],
    ["lite", lite],
  ]) {
    const database = path.join(temporary, `${name}.sqlite3`);
    await copyFile(seed, database);
    const server = await start(executable, database);
    try {
      const responses = [];
      for (const [route, authorization] of routes)
        responses.push(await server.request(route, authorization));
      assert.deepEqual(
        responses.map((response) => response.status),
        expectedStatuses,
      );
      assert.equal(responses[3].body.data.title, "安全演示资料");
      assert.equal(responses[5].body.data[0].number, "DEMO-001");
      if (name === "lite") {
        for (const route of [
          "/v1/translate",
          "/v1/images/primary/JavBus/DEMO-001",
          "/v1/reviews/JavBus/DEMO-001",
        ])
          assert.equal((await server.request(route)).status, 404);
      }
      results.push(responses);
    } finally {
      await server.stop();
    }
    assert.deepEqual(snapshot(database), before, `${name}: 缓存 schema 或记录发生变化`);
  }
  assert.deepEqual(results[1], results[0], "精简版接口响应与官方版不一致");
  assert.ok(blockedRequests > 0, "缓存回退未经过拒绝代理");
  const providers = results[0][0].body.data;
  const report = {
    status: "passed",
    binarySha256: receipt.sha256,
    comparedEndpoints: routes.length,
    movieProviders: Object.keys(providers.movie_providers).sort(),
    actorProviders: Object.keys(providers.actor_providers).sort(),
    sqliteSchemaAndRowsUnchanged: true,
    removedEndpoints: 3,
    blockedOutboundRequests: blockedRequests,
    realSourceRequests: 0,
    fixtureDirectory: temporary,
  };
  await writeFile(path.join(output, "verification.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await Promise.all(
    [...processes].map(async (child) => {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }),
  );
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => proxy.close(resolve));
}
