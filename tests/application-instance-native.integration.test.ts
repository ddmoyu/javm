import { afterAll, describe, expect, it } from "vite-plus/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MediaHost } from "./helpers/mediaHost";
import { parseLaunchArguments } from "../frontend/src/services/settings/deepLinks";
const enabled = process.platform === "win32" && process.env.JAVM_MEDIA_INTEGRATION === "1";
describe("深度链接参数", () => {
  it("只识别显式动作，下载仅形成待确认表单", () => {
    expect(parseLaunchArguments(["--path=ignored", "javm://search?code=SAFE-001"])).toEqual([
      { kind: "search", code: "SAFE-001" },
    ]);
    expect(
      parseLaunchArguments(["javm://download?url=https%3A%2F%2Fsafe.invalid%2Fsafe.m3u8"]),
    ).toEqual([{ kind: "download", url: "https://safe.invalid/safe.m3u8", name: "" }]);
    expect(() =>
      parseLaunchArguments(["javm://download?url=file%3A%2F%2F%2FC%3A%2Funsafe.exe"]),
    ).toThrow();
    expect(() => parseLaunchArguments(["javm://execute?command=anything"])).toThrow();
  });
});
describe.runIf(enabled)("主应用单实例（隔离临时数据库）", () => {
  const hosts: MediaHost[] = [];
  afterAll(async () => {
    await Promise.all(hosts.map((host) => host.close()));
  });
  it("第二进程转发参数，主实例退出后可重新接管", async () => {
    const root = path.resolve(await fs.mkdtemp(".tmp/application-instance-"));
    const launch = async () => {
      const host = new MediaHost();
      hosts.push(host);
      await host.start(path.join(root, "downloads.sqlite3"));
      return host;
    };
    const first = await launch(),
      second = await launch();
    expect(
      await first.request("library.instance.claim", { args: ["javm://search?code=SAFE-001"] }),
    ).toEqual({ primary: true });
    expect(
      await second.request("library.instance.claim", { args: ["javm://work?id=safe-work"] }),
    ).toEqual({ primary: false });
    await expect(second.request("library.instance.take")).rejects.toThrow("主实例");
    expect(await first.request("library.instance.take")).toEqual([
      ["javm://search?code=SAFE-001"],
      ["javm://work?id=safe-work"],
    ]);
    expect(await first.request("library.instance.take")).toEqual([]);
    await first.close();
    expect(await second.request("library.instance.claim", { args: [] })).toEqual({ primary: true });
  });
  it("第二进程转发参数时不改写主实例正在扫描的目录状态", async () => {
    const root = path.resolve(await fs.mkdtemp(".tmp/application-instance-scan-"));
    const seed = new MediaHost();
    try {
      await seed.start(path.join(root, "downloads.sqlite3"));
      await seed.request("library.status");
    } finally {
      await seed.close();
    }
    const library = path.join(root, "library.sqlite3");
    const setState = (state: string) => {
      const database = new DatabaseSync(library);
      try {
        database
          .prepare(
            "INSERT INTO directories(id,path,path_key,state) VALUES('safe-dir',?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
          )
          .run(root, root.toLowerCase(), state);
      } finally {
        database.close();
      }
    };
    const state = () => {
      const database = new DatabaseSync(library);
      try {
        return (
          database.prepare("SELECT state FROM directories WHERE id='safe-dir'").get() as {
            state: string;
          }
        ).state;
      } finally {
        database.close();
      }
    };
    const launch = async () => {
      const host = new MediaHost();
      hosts.push(host);
      await host.start(path.join(root, "downloads.sqlite3"));
      return host;
    };
    setState("scanning");
    const first = await launch();
    expect(await first.request("library.instance.claim", { args: [] })).toEqual({ primary: true });
    // 主实例接管时把上次遗留的扫描标为中断。
    expect(state()).toBe("interrupted");
    // 模拟主实例正在扫描，第二进程只转发参数。
    setState("scanning");
    const second = await launch();
    expect(
      await second.request("library.instance.claim", { args: ["javm://search?code=SAFE-001"] }),
    ).toEqual({ primary: false });
    expect(state()).toBe("scanning");
    expect(await first.request("library.instance.take")).toEqual([["javm://search?code=SAFE-001"]]);
  });
});
