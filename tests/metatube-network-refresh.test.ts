import { describe, expect, it, vi } from "vite-plus/test";
import { MetaTubeService } from "../frontend/src/services/metadata/MetaTubeService";
import type { MetaTubeHost } from "../frontend/src/services/metadata/MetaTubeService";
import { JsonHttpError } from "../frontend/src/services/metadata/shared";
import type { JsonHttp } from "../frontend/src/services/metadata/shared";

const health: JsonHttp = async (request) =>
  request.url.endsWith("providers")
    ? { data: { movie_providers: { Fixture: "https://example.invalid" } } }
    : { data: request.url.includes("movies/search") ? [] : 1 };

function fixture(http: JsonHttp = health) {
  let proxy = "";
  const events: string[] = [];
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const native = {
    bundled: async () => ({ path: "C:/fixture/metatube.exe", version: "v1.4.0" }),
    start: vi.fn(async () => {
      const currentProxy = proxy;
      const id = stops.length + 1;
      events.push(`start:${id}:${currentProxy}`);
      let exit!: () => void;
      const exited = new Promise<void>((resolve) => {
        exit = resolve;
      });
      const stop = vi.fn(async () => {
        events.push(`stop:${id}`);
        exit();
      });
      stops.push(stop);
      return {
        endpoint: `http://127.0.0.1:${12000 + id}`,
        token: "fixture-token",
        exited,
        isNetworkCurrent: async () => currentProxy === proxy,
        stop,
      };
    }),
  } satisfies MetaTubeHost;
  const service = new MetaTubeService(
    { read: async () => null, write: async () => {} },
    http,
    native,
    true,
  );
  return {
    service,
    events,
    native,
    stops,
    saveProxy: (value: string) => {
      proxy = value;
    },
  };
}

describe("MetaTube 代理刷新与查询错误", () => {
  it("启用、更换和停用代理在下次查询生效，旧进程退出前不启动新进程", async () => {
    const { service, events, native, saveProxy } = fixture();
    try {
      await service.initialize();
      expect(native.start).not.toHaveBeenCalled();
      await service.search("TEST-001");
      saveProxy("http://127.0.0.1:7897");
      expect(events).toEqual(["start:1:"]);
      await service.search("TEST-001");
      await service.search("TEST-002");
      saveProxy("http://127.0.0.1:7898");
      await service.search("TEST-003");
      saveProxy("");
      await service.search("TEST-004");
      expect(events).toEqual([
        "start:1:",
        "stop:1",
        "start:2:http://127.0.0.1:7897",
        "stop:2",
        "start:3:http://127.0.0.1:7898",
        "stop:3",
        "start:4:",
      ]);
      expect(service.getSnapshot()).toMatchObject({ status: "ready", querying: false });
    } finally {
      await service.shutdown();
    }
  });

  it("保存代理不打断在途查询，随后查询等待旧进程停止", async () => {
    let finish!: (value: unknown) => void;
    let first = true;
    const { service, native, stops, saveProxy } = fixture(async (request, signal) => {
      if (request.url.includes("movies/search") && first) {
        first = false;
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return health(request, signal);
    });
    try {
      const pending = service.search("TEST-001");
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      saveProxy("http://127.0.0.1:7897");
      expect(stops[0]).not.toHaveBeenCalled();
      finish({ data: [] });
      await pending;
      let stopped!: () => void;
      stops[0]!.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            stopped = resolve;
          }),
      );
      const next = service.search("TEST-002");
      await vi.waitFor(() => expect(stopped).toBeTypeOf("function"));
      expect(native.start).toHaveBeenCalledOnce();
      stopped();
      await next;
      expect(native.start).toHaveBeenCalledTimes(2);
    } finally {
      await service.shutdown();
    }
  });

  it.each(["search", "details"] as const)(
    "%s 的旧组件 404 说明详细原因未知，保留服务供重试",
    async (operation) => {
      const { service, stops } = fixture(async (request, signal) => {
        if (request.url.includes("movies/"))
          throw new JsonHttpError(404, "服务返回 HTTP 404，请检查基础地址和服务状态。");
        return health(request, signal);
      });
      try {
        const pending =
          operation === "search"
            ? service.search("TEST-001")
            : service.details({
                provider: "Fixture",
                id: "test001",
                code: "TEST-001",
                title: "合成影片",
              });
        await expect(pending).rejects.toThrow("当前组件未提供详细原因");
        expect(service.getSnapshot()).toMatchObject({ status: "ready", querying: false });
        expect(service.getSnapshot().error).not.toContain("基础地址");
        expect(stops[0]).not.toHaveBeenCalled();
      } finally {
        await service.shutdown();
      }
    },
  );

  it("其他 HTTP 错误保留状态并提供分类提示", async () => {
    const error = new JsonHttpError(500, "服务返回 HTTP 500。");
    const { service } = fixture(async (request, signal) => {
      if (request.url.includes("movies/")) throw error;
      return health(request, signal);
    });
    try {
      await expect(service.search("TEST-001")).rejects.toMatchObject({
        status: 500,
        message: "资料服务暂时异常，请稍后重试。",
      });
    } finally {
      await service.shutdown();
    }
  });
});
