import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { NativeLibraryPort } from "../frontend/src/platform/neutralino/library";

// 只替换客户端传输，挂载与图片读取由真实 Neutralino 资源服务器执行。
const native = vi.hoisted(() => ({
  call: async (_method: string, _data?: unknown): Promise<unknown> => {
    throw new Error("安全资源服务器尚未启动");
  },
}));
vi.mock("@neutralinojs/lib", () => ({
  events: {},
  extensions: {},
  filesystem: {},
  server: {
    getMounts: () => native.call("server.getMounts"),
    mount: (path: string, target: string) => native.call("server.mount", { path, target }),
    unmount: (path: string) => native.call("server.unmount", { path }),
  },
}));

it.runIf(process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1")(
  "真实挂载反复刷新后，仍能读取本地封面和预览图（仅安全纯色图片，无窗口、数据库或外网）",
  async () => {
    const project = path.resolve(import.meta.dirname, "..");
    const temporary = path.join(project, ".tmp");
    await mkdir(temporary, { recursive: true });
    const root = await mkdtemp(path.join(temporary, "safe-library-assets-"));
    const directory = path.join(root, "资料", "metadata");
    const images = path.join(directory, "safe-work", "images");
    await mkdir(images, { recursive: true });
    // 1x1 的安全占位 PNG，绝不读取用户图片或启动正式业务页面。
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SCEAAAAASUVORK5CYII=",
      "base64",
    );
    const files = [path.join(images, "封面 #1.png"), path.join(images, "预览 1.png")];
    for (const file of files) await writeFile(file, png);
    await writeFile(
      path.join(root, "neutralino.config.json"),
      JSON.stringify({
        applicationId: `net.ddmoyu.javm.safeimages.${crypto.randomUUID()}`,
        defaultMode: "cloud",
        port: 0,
        url: "/",
        documentRoot: "/",
        enableServer: true,
        enableNativeAPI: true,
        enableExtensions: false,
        tokenSecurity: "one-time",
        dataLocation: "app",
        storageLocation: "app",
        logging: { enabled: false },
        nativeAllowList: ["server.mount", "server.unmount", "server.getMounts", "app.exit"],
      }),
    );
    const child = spawn(
      path.join(project, "bin/neutralino-win_x64.exe"),
      ["--mode=cloud", "--res-mode=directory", `--path=${root}`, "--export-auth-info=true"],
      { cwd: root, windowsHide: true, stdio: "ignore" },
    );
    let failure: Error | undefined;
    child.on("error", (error) => {
      failure = error;
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    let socket: WebSocket | undefined;
    const until = async <T>(read: () => Promise<T | undefined>) => {
      const deadline = Date.now() + 8000;
      do {
        if (failure) throw failure;
        const value = await read();
        if (value !== undefined) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      throw new Error("安全资源服务器启动超时");
    };
    try {
      const auth = await until(() =>
        readFile(path.join(root, ".tmp/auth_info.json"), "utf8")
          .then(
            (text) =>
              JSON.parse(text) as { nlPort: number; nlConnectToken: string; nlToken: string },
          )
          .catch(() => undefined),
      );
      socket = new WebSocket(`ws://127.0.0.1:${auth.nlPort}/?connectToken=${auth.nlConnectToken}`);
      await until(async () => (socket!.readyState === WebSocket.OPEN ? true : undefined));
      const connection = socket;
      native.call = (method, data = {}) =>
        new Promise((resolve, reject) => {
          const id = crypto.randomUUID();
          const timer = setTimeout(() => {
            connection.removeEventListener("message", listener);
            reject(new Error("安全资源 API 超时"));
          }, 5000);
          const listener = (event: MessageEvent) => {
            const response = JSON.parse(String(event.data));
            if (response.id !== id) return;
            clearTimeout(timer);
            connection.removeEventListener("message", listener);
            if (response.data?.error) reject(new Error(JSON.stringify(response.data.error)));
            else resolve(response.data?.returnValue ?? response.data);
          };
          connection.addEventListener("message", listener);
          connection.send(JSON.stringify({ id, method, data, accessToken: auth.nlToken }));
        });
      vi.stubGlobal("window", { NL_PORT: auth.nlPort });
      const port = new NativeLibraryPort();
      const urls: string[][] = [];
      for (let refresh = 0; refresh < 3; refresh++) {
        const asset = await port.mount([], directory);
        const current = files.map((file) => asset(file));
        expect(current.every((url) => !!url)).toBe(true);
        for (const url of current) {
          const response = await fetch(url!, { signal: AbortSignal.timeout(5000) });
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toMatch(/^image\/png/);
          expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
        }
        urls.push(current as string[]);
      }
      expect(urls[1]).toEqual(urls[0]);
      expect(urls[2]).toEqual(urls[0]);
    } finally {
      vi.unstubAllGlobals();
      socket?.close();
      if (child.exitCode === null && !failure) child.kill();
      if (!failure) await exited;
      if (
        path.dirname(root) === temporary &&
        path.basename(root).startsWith("safe-library-assets-")
      )
        await rm(root, { recursive: true, force: true });
    }
  },
  25000,
);
