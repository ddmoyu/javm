import "@mantine/core/styles.css";
import "../../../frontend/src/styles/global.css";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Group, MantineProvider } from "@mantine/core";
import { app, filesystem, os, storage, window as nativeWindow } from "@neutralinojs/lib";
import { initializePlatform } from "../../../frontend/src/platform/neutralino/bootstrap";
import { createNetworkSettings } from "../../../frontend/src/platform/neutralino/network";
import { createMetadataServices } from "../../../frontend/src/platform/neutralino/metadataServices";
import {
  createMetadataHttp,
  protectedSettingsStore,
} from "../../../frontend/src/platform/neutralino/metadataHttp";
import { AiService, defaultAiSettings } from "../../../frontend/src/services/metadata/AiService";
import {
  MetaTubeService,
  defaultMetaTubeSettings,
} from "../../../frontend/src/services/metadata/MetaTubeService";
import { AiSettingsPanel } from "../../../frontend/src/features/settings/AiSettingsPanel";
import { MetaTubeSettingsPanel } from "../../../frontend/src/features/settings/MetaTubeSettingsPanel";
import { WorkspaceContext } from "../../../frontend/src/app/state";
import type { WorkspaceState } from "../../../frontend/src/app/state";
import { cssVariablesResolver, theme } from "../../../frontend/src/app/theme";

const runtime = initializePlatform();
document.documentElement.dataset.runtime = runtime;
const network = createNetworkSettings(runtime),
  services = createMetadataServices(runtime, network);
const http = createMetadataHttp(network);
const params = new URLSearchParams(location.search),
  resultPath = params.get("result")!,
  root = params.get("root")!;
const exceptions: string[] = [],
  results: { name: string; ok: boolean; detail?: string }[] = [];
window.addEventListener("error", (event) => exceptions.push(event.message));
window.addEventListener("unhandledrejection", (event) => exceptions.push(String(event.reason)));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
async function test(name: string, action: () => Promise<void>) {
  try {
    await action();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: String(error) });
  }
  await filesystem.writeFile(
    resultPath,
    JSON.stringify({ done: false, results, exceptions }, null, 2),
  );
}
function View() {
  const [panel, setPanel] = useState("ai");
  return (
    <main
      style={{ maxWidth: 850, height: "100dvh", overflowY: "auto", margin: "auto", padding: 28 }}
    >
      <Group mb="lg">
        <Button onClick={() => setPanel("ai")}>AI 设置</Button>
        <Button onClick={() => setPanel("metatube")}>MetaTube 设置</Button>
      </Group>
      {panel === "ai" ? <AiSettingsPanel /> : <MetaTubeSettingsPanel />}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
    >
      <WorkspaceContext.Provider
        value={{ ...services, runtime, notice: () => {} } as unknown as WorkspaceState}
      >
        <View />
      </WorkspaceContext.Provider>
    </MantineProvider>
  </StrictMode>,
);
async function run() {
  const fixture = JSON.parse(await filesystem.readFile(params.get("fixture")!)) as {
    base: string;
  };
  const { ai, metatube } = services;
  await network.initialize();
  await ai.settings.initialize();
  await metatube.initialize();
  await test("初始化和设置页面不启动 MetaTube", async () => {
    assert(metatube.getSnapshot().status === "stopped", "初始化触发了服务启动");
    assert((await os.getSpawnedProcesses()).length === 0, "初始化留下子进程");
  });
  const config = {
    ...defaultAiSettings,
    enabled: true,
    endpoint: `${fixture.base}/v1`,
    model: "fixture-model",
    apiKey: "fixture-secret",
  };
  await test("AI 配置经 DPAPI 加密后持久化并可跨实例读取", async () => {
    await ai.settings.save(config);
    const stored = await storage.getData("javm-ai-settings-v1");
    assert(!stored.includes("fixture-secret") && !stored.includes("fixture-model"), "配置含明文");
    const reopened = new AiService(protectedSettingsStore("javm-ai-settings-v1"), http, true);
    assert((await reopened.settings.require()).apiKey === config.apiKey, "密钥未恢复");
  });
  await test("无 CORS 的本机 OpenAI 兼容接口完成连接测试、识别与翻译", async () => {
    await ai.test(config);
    assert(
      (await ai.recognize("TEST-001.mp4", "Fictional sample")).code === "TEST-001",
      "识别结果错误",
    );
    const result = await ai.translate({
      title: "Fictional sample film",
      plot: "A peaceful journey through a fictional city.",
    });
    assert(result.title === "虚构示例影片", "翻译结果错误");
  });
  await test("错误密钥反馈明确且不修改保存的配置", async () => {
    let message = "";
    try {
      await ai.test({ ...config, apiKey: "wrong" });
    } catch (error) {
      message = String(error);
    }
    assert(message.includes("拒绝访问"), "鉴权失败未反馈");
    assert((await ai.settings.require()).apiKey === config.apiKey, "测试覆盖了配置");
  });
  await test("取消慢请求并清理原生 curl 进程", async () => {
    const before = (await os.getSpawnedProcesses()).length;
    const abort = new AbortController();
    const pending = http({ url: `${fixture.base}/slow` }, abort.signal).then(
      () => "unexpected",
      (error) => (error instanceof Error ? error.name : "error"),
    );
    await sleep(900);
    const start = performance.now();
    abort.abort();
    assert((await pending) === "AbortError", "取消未生效");
    assert(performance.now() - start < 6000, "取消超时");
    assert((await os.getSpawnedProcesses()).length === before, "请求进程残留");
  });
  await test("限制服务响应大小且本机请求绕过错误代理", async () => {
    await network.update({ proxyEnabled: true, proxy: "http://127.0.0.1:9" });
    await ai.test(config);
    let failed = false;
    try {
      await http({ url: `${fixture.base}/oversize` }, new AbortController().signal);
    } catch {
      failed = true;
    }
    assert(failed, "未拒绝过大响应");
    await network.update({ proxyEnabled: false, proxy: "" });
  });
  await test("模拟内置宿主验证真实 HTTP 鉴权、查询和资料映射", async () => {
    // 仅注入测试宿主；产品设置不提供远程地址或令牌入口。
    const fixtureService = new MetaTubeService(
      { read: async () => ({ providers: ["Fixture"] }), write: async () => {} },
      http,
      {
        bundled: async () => ({ path: "fixture-only", version: "v1.4.0" }),
        start: async () => ({
          endpoint: fixture.base,
          token: "fixture-secret",
          exited: new Promise(() => {}),
          stop: async () => {},
        }),
      },
      true,
    );
    try {
      const result = await fixtureService.search("TEST-001 & 合成");
      assert(fixtureService.getSnapshot().status === "ready", "首次查询未启动服务");
      assert(result.length === 1, "搜索失败");
      const detail = await fixtureService.details(result[0]!);
      assert(detail.fields.plot?.includes("fictional"), "详情映射错误");
    } finally {
      await fixtureService.shutdown();
    }
  });
  await nativeWindow.snapshot(`${root}/ai-settings.png`);
  // 使用不存在的来源，触发真正的服务启动与路由响应而不访问任何外部资料站点。
  const candidate = { provider: "JavmFixtureUnavailable", id: "fixture", code: "", title: "" };
  await test("内置 MetaTube 按需启动，查询结束和隐藏窗口后仍驻留", async () => {
    const legacy = `${window.NL_DATAPATH}/metatube`;
    await filesystem.createDirectory(legacy).catch(() => {});
    await filesystem.writeFile(
      `${legacy}/installed.json`,
      JSON.stringify({
        version: "v99.0.0",
        folder: `package-${crypto.randomUUID()}`,
      }),
    );
    const bundled = await metatube.host.bundled();
    assert(
      bundled?.path.replaceAll("\\", "/").includes("/bin/tools/metatube/"),
      "未使用包内 MetaTube",
    );
    assert(bundled?.version !== "v99.0.0", "旧安装记录覆盖了内置组件");
    await metatube.save(defaultMetaTubeSettings);
    // 外部请求经过不可用代理，本地健康检查仍可完成；启动不依赖程序下载。
    await network.update({ proxyEnabled: true, proxy: "http://127.0.0.1:9" });
    await metatube.details(candidate).catch(() => {});
    assert(metatube.getSnapshot().providers.length > 0, "包内 MetaTube 未就绪");
    assert(metatube.getSnapshot().status === "ready", "查询失败关闭了内置服务");
    const processes = await os.getSpawnedProcesses();
    assert(processes.length === 1, "没有保持唯一内置服务进程");
    await metatube.details(candidate).catch(() => {});
    const repeated = await os.getSpawnedProcesses();
    assert(
      repeated.length === 1 && repeated[0]?.pid === processes[0]?.pid,
      "重复查询重新启动了服务",
    );
    await nativeWindow.hide();
    await sleep(800);
    assert((await os.getSpawnedProcesses())[0]?.pid === processes[0]?.pid, "隐藏窗口停止了服务");
    await nativeWindow.show();
    const button = [...document.querySelectorAll("button")].find(
      (item) => item.textContent === "MetaTube 设置",
    );
    button?.click();
    await sleep(300);
    assert(document.body.textContent?.includes("内置版本"), "未显示内置组件状态");
    assert(
      !/已有服务|随应用启动|服务地址|访问令牌/.test(document.body.textContent || "") &&
        ![...document.querySelectorAll("button")].some((item) =>
          /^(启动服务|重启|停止)/.test(item.textContent || ""),
        ),
      "仍显示外部服务或手动启停入口",
    );
    await nativeWindow.snapshot(`${root}/metatube-settings.png`);
    await network.update({ proxyEnabled: false, proxy: "" });
  });
  await test("应用退出收尾停止内置服务并回收子进程", async () => {
    await metatube.shutdown();
    assert(!metatube.getSnapshot().error, "退出误报错误");
    assert(metatube.getSnapshot().status === "stopped", "服务未停止");
    assert((await os.getSpawnedProcesses()).length === 0, "包内工具退出后存在残留");
  });
  const retry = new MetaTubeService(
    protectedSettingsStore("javm-metatube-settings-v1"),
    http,
    metatube.host,
    true,
  );
  await test("内置组件缺失提示修复运行包，恢复后可以重试", async () => {
    const bundled = await metatube.host.bundled();
    assert(bundled, "未找到包内组件");
    const source = bundled!.path,
      temporary = `${source}.fixture-backup`;
    assert(
      source.replaceAll("\\", "/") ===
        `${root.replaceAll("\\", "/")}/bin/tools/metatube/metatube-server.exe`,
      "拒绝移动测试目录以外的组件",
    );
    await filesystem.move(source, temporary);
    try {
      let message = "";
      try {
        await retry.details(candidate);
      } catch (error) {
        message = String(error);
      }
      assert(message.includes("内置 MetaTube 组件缺失"), "缺失组件的提示错误");
      assert((await os.getSpawnedProcesses()).length === 0, "缺失组件时启动了下载或安装进程");
    } finally {
      await filesystem.move(temporary, source);
    }
    await retry.details(candidate).catch(() => {});
    assert(retry.getSnapshot().status === "ready", "恢复组件后不能重试");
  });
  await ai.shutdown();
  await metatube.shutdown();
  const exitProcessPath = (await retry.host.bundled())?.path;
  assert(retry.getSnapshot().status === "ready", "宿主退出验证缺少运行中的内置服务");
  await filesystem.writeFile(
    resultPath,
    JSON.stringify({ done: true, results, exceptions, exitProcessPath }, null, 2),
  );
  // 此处刻意绕过 retry.shutdown，验证宿主消失时监督器仍能收尾。
  await app.exit();
}
void run().catch(async (error) => {
  await services.ai.shutdown().catch(() => {});
  await services.metatube.shutdown().catch(() => {});
  await filesystem.writeFile(
    resultPath,
    JSON.stringify({ done: true, results, exceptions, fatal: String(error) }, null, 2),
  );
});
