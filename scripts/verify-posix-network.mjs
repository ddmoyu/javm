import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExtensionFixture } from "../tests/fixtures/core-extension/host.mjs";
import { root, run } from "./third-party/posix/common.mjs";

assert.equal(process.env.GITHUB_ACTIONS, "true");
const directory = await mkdtemp(path.join(tmpdir(), "javm-safe-tls-"));
const host = new ExtensionFixture(
  path.join(root, "bin/javm_database"),
  path.join(directory, "unused.sqlite3"),
);
const servers = [],
  sockets = new Set();
async function listen(server) {
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
try {
  await mkdir(path.join(directory, "out"));
  await run(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      path.join(directory, "key.pem"),
      "-out",
      path.join(directory, "cert.pem"),
    ],
    directory,
    true,
  );
  const port = await listen(
    httpsServer(
      {
        key: await readFile(path.join(directory, "key.pem")),
        cert: await readFile(path.join(directory, "cert.pem")),
      },
      (_request, response) => response.end("safe TLS fixture"),
    ),
  );
  let tunnels = 0,
    requests = 0;
  const proxy = httpServer((request, response) => {
    assert.equal(request.url, "http://safe-fixture.invalid/check");
    requests++;
    response.end("safe proxy fixture");
  });
  proxy.on("connect", (request, client, head) => {
    if (request.url !== `127.0.0.1:${port}`) {
      client.destroy();
      return;
    }
    tunnels++;
    const remote = connect(port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) remote.write(head);
      remote.pipe(client);
      client.pipe(remote);
    });
    sockets.add(remote);
    remote.on("close", () => sockets.delete(remote));
    remote.on("error", () => client.destroy());
    client.on("error", () => remote.destroy());
  });
  const proxyPort = await listen(proxy);
  await host.start();
  const request = (url, options = {}) =>
    host.request("http.request", {
      id: crypto.randomUUID(),
      url,
      output: path.join(directory, "out", crypto.randomUUID()),
      maxBytes: 4096,
      timeoutMs: 12000,
      connectTimeoutMs: 4000,
      ...options,
    });
  assert.equal((await request(`https://127.0.0.1:${port}`)).exitCode, 60, "未信任证书必须拒绝");
  const viaProxy = { proxy: `http://127.0.0.1:${proxyPort}` };
  assert.equal((await request("http://safe-fixture.invalid/check", viaProxy)).status, 200);
  assert.equal(requests, 1);
  assert.equal((await request(`https://127.0.0.1:${port}`, viaProxy)).exitCode, 60);
  assert.equal(tunnels, 1, "HTTPS 必须经过指定代理且仍验证证书");
  const trusted = await request("https://example.com/", { method: "HEAD" });
  assert.equal(trusted.exitCode, 0, "发布构建必须能使用系统 CA");
  assert.ok(trusted.status >= 200 && trusted.status < 400);
  await run(
    path.join(root, "bin/tools/curl"),
    [
      "--silent",
      "--show-error",
      "--fail",
      "--max-time",
      "10",
      "--cacert",
      path.join(directory, "cert.pem"),
      `https://127.0.0.1:${port}`,
    ],
    directory,
    true,
  );
  console.log(`${process.platform}: 系统 CA、证书拒绝、HTTP 代理与 HTTPS CONNECT 通过`);
} finally {
  await host.close();
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  assert.match(path.basename(directory), /^javm-safe-tls-/);
  await rm(directory, { recursive: true, force: true });
}
