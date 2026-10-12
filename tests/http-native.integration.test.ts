import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { MediaHost } from "./helpers/mediaHost";
import type { HttpResponse } from "../frontend/src/services/network/HttpService";

// 只监听回环地址，测试服务器从不转发请求；不访问真实网站、不打开数据库或界面。
describe.runIf(process.env.JAVM_HTTP_INTEGRATION === "1")(
  "常驻 libcurl 官方 Extension（本地安全 mock）",
  () => {
    let host: MediaHost, server: Server, root: string, origin: string;
    let connections: number, calls: string[], slow: ServerResponse[];
    let sockets: Set<Socket>;
    const base = path.resolve(import.meta.dirname, "../.tmp");
    beforeEach(async () => {
      root = await mkdtemp(path.join(base, "http-native-safe-"));
      connections = 0;
      calls = [];
      slow = [];
      sockets = new Set();
      server = createServer((req, res) => {
        calls.push(req.url!);
        if (req.url === "/slow") {
          slow.push(res);
          res.writeHead(200);
          res.write("safe");
          return;
        }
        if (req.url === "/redirect") {
          res.writeHead(302, { Location: "/ok" });
          res.end();
          return;
        }
        if (req.url === "/forbidden") {
          res.writeHead(403, { "cf-mitigated": "challenge", "Set-Cookie": "safe=example" });
          res.end("Safe mock challenge");
          return;
        }
        if (req.url === "/oversize") {
          res.writeHead(200);
          res.write("x".repeat(64));
          res.end("x".repeat(64));
          return;
        }
        if (req.url === "/bad-header") {
          res.writeHead(302, { Location: "/\u00ff" });
          res.end();
          return;
        }
        if (req.url === "/duplicate-header") {
          res.writeHead(200, { "Content-Type": ["text/plain", "text/html"] });
          res.end("safe");
          return;
        }
        if (req.url === "/echo") {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });
          req.on("end", () => {
            res.setHeader("Content-Type", "text/plain");
            res.end(`${req.method}:${body}`);
          });
          return;
        }
        if (req.headers.range) {
          res.writeHead(206, { "Content-Range": "bytes 2-5/8" });
          res.end("cdef");
          return;
        }
        res.setHeader("Content-Type", "text/plain");
        res.end("Safe fixture");
      });
      server.on("connection", (socket) => {
        connections++;
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Mock 地址无效");
      origin = `http://127.0.0.1:${address.port}`;
      host = new MediaHost();
      await host.start(path.join(root, "must-not-open.sqlite"));
    });
    afterEach(async () => {
      await host?.close();
      for (const socket of sockets ?? []) socket.destroy();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      const relative = path.relative(base, path.resolve(root));
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("Mock 清理路径越界");
      expect(await stat(path.join(root, "must-not-open.sqlite")).catch(() => null)).toBeNull();
      await rm(root, { recursive: true, force: true });
    });
    function start(route = "/ok", patch: Record<string, unknown> = {}) {
      const id = crypto.randomUUID(),
        output = path.join(root, `${id}.part`);
      const done = host.request<HttpResponse>("http.request", {
        id,
        url: `${origin}${route}`,
        output,
        maxBytes: 1024,
        timeoutMs: 3000,
        connectTimeoutMs: 1000,
        ...patch,
      });
      return { id, output, done };
    }
    it("连续请求复用同一 TCP 连接；响应只含受限元数据", async () => {
      const first = start(),
        a = await first.done;
      const second = start(),
        b = await second.done;
      expect(a).toMatchObject({ status: 200, exitCode: 0, connections: 1 });
      expect(b).toMatchObject({ status: 200, exitCode: 0, connections: 0 });
      expect(connections).toBe(1);
      expect(await readFile(second.output, "utf8")).toBe("Safe fixture");
      expect(b.headers["content-type"]).toBe("text/plain");
    });
    it("403 原样返回、不重试、不把 Cookie 传回 TypeScript", async () => {
      const transfer = start("/forbidden");
      const response = await transfer.done;
      expect(response).toMatchObject({
        status: 403,
        exitCode: 0,
        setCookie: true,
        headers: { "cf-mitigated": "challenge" },
      });
      expect(JSON.stringify(response)).not.toContain("safe=example");
      expect(calls).toEqual(["/forbidden"]);
    });
    it("有界重定向、Range 和 POST 请求均保留调用语义", async () => {
      expect(await start("/redirect").done).toMatchObject({ status: 302, exitCode: 0 });
      expect(await start("/redirect", { maxRedirects: 2 }).done).toMatchObject({
        status: 200,
        effectiveUrl: `${origin}/ok`,
      });
      const range = start("/ok", { headers: { Range: "bytes=2-5" } });
      expect(await range.done).toMatchObject({
        status: 206,
        headers: { "content-range": "bytes 2-5/8" },
      });
      expect(await readFile(range.output, "utf8")).toBe("cdef");
      const post = start("/echo", { method: "POST", body: "safe-body" });
      expect(await post.done).toMatchObject({ status: 200, exitCode: 0 });
      expect(await readFile(post.output, "utf8")).toBe("POST:safe-body");
    });
    it("未知长度响应传输中也受大小上限约束", async () => {
      const transfer = start("/oversize", { maxBytes: 80 });
      expect(await transfer.done).toMatchObject({ exitCode: 63 });
      expect((await stat(transfer.output)).size).toBeLessThanOrEqual(80);
    });
    it("畸形 UTF-8 与重复关键响应头不能使常驻进程退出", async () => {
      expect(await start("/bad-header").done).toMatchObject({ exitCode: 8 });
      expect(await start("/duplicate-header").done).toMatchObject({ ambiguousHeaders: true });
      expect(await start().done).toMatchObject({ exitCode: 0, status: 200 });
    });
    it("原生排队中的取消不建立额外连接、不创建输出文件", async () => {
      const holding = Array.from({ length: 4 }, () => start("/slow"));
      await expect.poll(() => slow.length).toBe(2);
      const queued = start("/slow");
      expect(await host.request("http.cancel", { id: queued.id })).toEqual({ stopped: true });
      expect(await queued.done).toMatchObject({ exitCode: 42 });
      expect(await stat(queued.output).catch(() => null)).toBeNull();
      for (const transfer of holding) await host.request("http.cancel", { id: transfer.id });
      await Promise.all(holding.map((transfer) => transfer.done));
    });
    it("取消确认前移除活动传输并关闭文件，随后可直接删除", async () => {
      const transfer = start("/slow");
      await expect.poll(() => slow.length).toBe(1);
      expect(await host.request("http.cancel", { id: transfer.id })).toEqual({ stopped: true });
      expect(await transfer.done).toMatchObject({ exitCode: 42 });
      await rm(transfer.output);
      await expect.poll(() => sockets.size).toBe(0);
    });
    it("慢响应按时退出，其他请求仍能完成", async () => {
      const slowRequest = start("/slow", { timeoutMs: 100, connectTimeoutMs: 100 });
      expect(await start().done).toMatchObject({ exitCode: 0, status: 200 });
      expect(await slowRequest.done).toMatchObject({ exitCode: 28 });
    });
    it("显式代理交给回环 mock，目标测试域从不发起 DNS 或外部请求", async () => {
      const transfer = start("", { url: "http://safe.invalid/through-proxy", proxy: origin });
      expect(await transfer.done).toMatchObject({ exitCode: 0, status: 200 });
      expect(calls).toEqual(["http://safe.invalid/through-proxy"]);
      expect(await readFile(transfer.output, "utf8")).toBe("Safe fixture");
    });
    it("退出 Extension 主连接时中止仍在运行的网络传输", async () => {
      const transfer = start("/slow");
      const done = transfer.done.catch(() => null);
      await expect.poll(() => slow.length).toBe(1);
      await host.close();
      await done;
      await expect.poll(() => sockets.size).toBe(0);
    });
  },
);
