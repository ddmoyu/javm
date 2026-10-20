import { expect, it, vi } from "vite-plus/test";
import {
  UpdateHttp,
  UpdateCheckDeferredError,
  updateCacheMs,
  type UpdateHttpState,
} from "../frontend/src/services/settings/updateHttp";
import {
  normalizeUpdateMirror,
  updateSources,
} from "../frontend/src/services/settings/updateSources";

const url = "https://github.com/safe/fixture/JAVM-update.json";
const response = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => ({
  status,
  body: new TextEncoder().encode(JSON.stringify(body)).buffer,
  headers,
});
function fixture() {
  let now = 1_800_000_000_000,
    saved: UpdateHttpState | null = null;
  const http = vi.fn(async () => response(200, { safe: true }, { etag: '"fixture"' }));
  const store = {
    read: async () => saved,
    write: async (value: UpdateHttpState) => {
      saved = value;
    },
  };
  const client = new UpdateHttp(http, store, () => now);
  return { client, http, store, advance: (ms: number) => (now += ms), now: () => now };
}
it("15 分钟内复用缓存，过期发送 ETag 并接受 304", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  await f.client.json(url, signal);
  await f.client.json(url, signal);
  expect(f.http).toHaveBeenCalledOnce();
  f.advance(updateCacheMs + 1);
  f.http.mockResolvedValue(response(304));
  expect(await f.client.json(url, signal)).toEqual({ safe: true });
  expect(f.http).toHaveBeenLastCalledWith(
    expect.objectContaining({ headers: expect.objectContaining({ "If-None-Match": '"fixture"' }) }),
    signal,
  );
});
it("429 的 Retry-After 跨重启生效，未到时间不发请求", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  f.http.mockResolvedValue(response(429, {}, { "retry-after": "120" }));
  await expect(f.client.json(url, signal)).rejects.toMatchObject({ retryAt: f.now() + 120000 });
  const restarted = new UpdateHttp(f.http, f.store, f.now);
  await expect(restarted.json(url, signal)).rejects.toBeInstanceOf(UpdateCheckDeferredError);
  expect(f.http).toHaveBeenCalledOnce();
  f.advance(120001);
  f.http.mockResolvedValue(response(200));
  await restarted.json(url, signal);
  expect(f.http).toHaveBeenCalledTimes(2);
});
it("403 只在限流证据存在时退避，尊重 reset 和 HTTP 日期", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  f.http.mockResolvedValue(response(403, { message: "Forbidden" }));
  await expect(f.client.json(url, signal)).rejects.toThrow("HTTP 403");
  f.http.mockResolvedValue(
    response(
      403,
      {},
      {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String((f.now() + 3600000) / 1000),
        "retry-after": new Date(f.now() + 60000).toUTCString(),
      },
    ),
  );
  await expect(f.client.json(url, signal)).rejects.toMatchObject({ retryAt: f.now() + 3600000 });
  expect(f.http).toHaveBeenCalledTimes(2);
});
it("没有服务端时间的连续限流指数退避，成功后清除", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  f.http.mockResolvedValue(response(429));
  await expect(f.client.json(url, signal)).rejects.toMatchObject({ retryAt: f.now() + 30000 });
  f.advance(30001);
  await expect(f.client.json(url, signal)).rejects.toMatchObject({ retryAt: f.now() + 60000 });
  f.advance(60001);
  f.http.mockResolvedValue(response(200));
  await f.client.json(url, signal);
  expect((await f.store.read())?.cooldowns).toEqual([]);
});
it("过期缓存加网络失败不能报告当前已是最新版", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  await f.client.json(url, signal);
  f.advance(updateCacheMs + 1);
  f.http.mockResolvedValue(response(503));
  await expect(f.client.json(url, signal)).rejects.toBeInstanceOf(UpdateCheckDeferredError);
});
it("镜像来源独立退避，取消不启动网络请求", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.http.mockResolvedValueOnce(response(429)).mockResolvedValue(response(200));
  await expect(f.client.json(url, controller.signal)).rejects.toBeInstanceOf(
    UpdateCheckDeferredError,
  );
  await f.client.json("https://mirror.example.com/" + url, controller.signal);
  controller.abort();
  await expect(f.client.json(url, controller.signal)).rejects.toThrow();
  expect(f.http).toHaveBeenCalledTimes(2);
});
it("镜像前缀限制 HTTPS 且保留原始 GitHub 地址，不接受凭据与模板", () => {
  expect(normalizeUpdateMirror(" https://mirror.example.com/prefix ")).toBe(
    "https://mirror.example.com/prefix/",
  );
  expect(updateSources("custom", "https://mirror.example.com/")).toEqual([
    "https://mirror.example.com/",
    "",
  ]);
  expect(updateSources("official")).toEqual([""]);
  for (const invalid of [
    "http://mirror.example.com/",
    "https://user:pass@mirror.example.com/",
    "https://mirror.example.com/?token=x",
    "https://mirror.example.com:443/",
    "https://mirror.example.com/../",
    "https://mirror.example.com/#x",
    "https://mirror.example.com/{url}",
  ])
    expect(() => normalizeUpdateMirror(invalid)).toThrow();
});
it("损坏的缓存响应不会使已保存的限流退避失效", async () => {
  const f = fixture();
  await f.store.write({
    entries: [{ url, body: "broken fixture", fetchedAt: f.now() }],
    cooldowns: [
      { origin: "https://github.com", until: f.now() + 60000, failures: 1, limited: true },
    ],
  });
  await expect(f.client.json(url, new AbortController().signal)).rejects.toBeInstanceOf(
    UpdateCheckDeferredError,
  );
  expect(f.http).not.toHaveBeenCalled();
});
