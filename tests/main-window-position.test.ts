import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WindowDisplay } from "../frontend/src/contracts/window";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  readFile: vi.fn(),
  write: vi.fn(),
  request: vi.fn(),
  log: vi.fn(),
  getSize: vi.fn(),
  getPosition: vi.fn(),
  setSize: vi.fn(),
  move: vi.fn(),
  isMaximized: vi.fn(),
  isFullScreen: vi.fn(),
  isMinimized: vi.fn(),
  setBorderless: vi.fn(),
}));
vi.mock("@neutralinojs/lib", () => ({ window: mocks, filesystem: { readFile: mocks.readFile } }));
vi.mock("../frontend/src/platform/neutralino/library", () => ({
  NativeLibraryPort: class {
    request = mocks.request;
  },
}));
vi.mock("../frontend/src/platform/neutralino/settingsStorage", () => ({
  nativeSettingsStorage: () => ({ read: mocks.read, write: mocks.write }),
}));
vi.mock("../frontend/src/services/logging/events", () => ({ logEvent: mocks.log }));

const primary: WindowDisplay = {
  primary: true,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1032 },
};
const secondary: WindowDisplay = {
  primary: false,
  bounds: { x: -2560, y: -1440, width: 2560, height: 1440 },
  workArea: { x: -2560, y: -1440, width: 2560, height: 1380 },
};
let size: {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  resizable: boolean;
};
let position: { x: number; y: number };

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal("window", { NL_DATAPATH: "C:/safe-window" });
  size = { width: 960, height: 700, minWidth: 760, minHeight: 540, resizable: true };
  position = { x: 120, y: 90 };
  mocks.read.mockResolvedValue(true);
  mocks.readFile.mockRejectedValue(new Error("安全模拟：没有保存的尺寸"));
  mocks.request.mockResolvedValue([secondary, primary]);
  mocks.isMaximized.mockResolvedValue(false);
  mocks.isFullScreen.mockResolvedValue(false);
  mocks.isMinimized.mockResolvedValue(false);
  mocks.getPosition.mockImplementation(async () => ({ ...position }));
  mocks.getSize.mockImplementation(async () => ({ ...size }));
  mocks.setSize.mockImplementation(async (next) => {
    if (next.width > 0) size.width = next.width;
    if (next.height > 0) size.height = next.height;
  });
  mocks.move.mockImplementation(async (x: number, y: number) => {
    position = { x, y };
  });
});
afterEach(() => vi.unstubAllGlobals());

async function initialize() {
  const { initializeMainWindowSize } =
    await import("../frontend/src/platform/neutralino/mainWindowSize");
  await initializeMainWindowSize();
}

it.each([
  [120, 90],
  [-2300, -1300],
  [-500, 200],
  [1850, 200],
  [300, -200],
])("保留仍可见的主屏、副屏和跨屏位置 (%i, %i)", async (x, y) => {
  position = { x, y };
  await initialize();
  expect(position).toEqual({ x, y });
  expect(mocks.move).not.toHaveBeenCalled();
  expect(mocks.setSize).not.toHaveBeenCalled();
});

it("复现完全离屏的极端坐标，恢复到主屏工作区中心并避开任务栏", async () => {
  position = { x: 32767, y: -32768 };
  size.width = 760;
  size.height = 540;
  await initialize();
  expect(position).toEqual({ x: 240, y: 66 });
  expect(size).toMatchObject({ width: 1440, height: 900 });
  expect(mocks.move).toHaveBeenCalledTimes(1);
});

describe("启动尺寸恢复", () => {
  beforeEach(() => {
    size.width = 760;
    size.height = 540;
  });

  it("窗口意外缩至最小时优先恢复上次有效尺寸，保留正常位置", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ width: 1640, height: 950 }));
    await initialize();
    expect(size).toMatchObject({ width: 1640, height: 950 });
    expect(position).toEqual({ x: 120, y: 90 });
    expect(mocks.move).not.toHaveBeenCalled();
    expect(mocks.readFile).toHaveBeenCalledWith("C:/safe-window/.tmp/window_state.config.json");
  });

  it("极端离屏与尺寸异常一起恢复，使用恢复后的实际尺寸居中", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ width: 1640, height: 950 }));
    position = { x: 32767, y: -32768 };
    await initialize();
    expect(size).toMatchObject({ width: 1640, height: 950 });
    expect(position).toEqual({ x: 140, y: 41 });
  });

  it("正常位置且保存尺寸就是用户选择的最小尺寸时不擅自放大", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ width: 760, height: 540 }));
    await initialize();
    expect(size).toMatchObject({ width: 760, height: 540 });
    expect(mocks.setSize).not.toHaveBeenCalled();
    expect(mocks.move).not.toHaveBeenCalled();
  });

  it.each(["broken", "null", '{"width":-1,"height":0}'])(
    "无效尺寸记录 %s 回退到默认尺寸且不改写原记录",
    async (record) => {
      mocks.readFile.mockResolvedValue(record);
      await initialize();
      expect(size).toMatchObject({ width: 1440, height: 900 });
      expect(mocks.write).not.toHaveBeenCalled();
    },
  );

  it("旧大屏尺寸按当前工作区限制，不回落到最小尺寸", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ width: 3000, height: 2000 }));
    await initialize();
    expect(size).toMatchObject({ width: 1872, height: 984 });
  });

  it("小屏幕按可用工作区限制默认尺寸", async () => {
    mocks.request.mockResolvedValue([
      {
        primary: true,
        bounds: { x: 0, y: 0, width: 1024, height: 768 },
        workArea: { x: 0, y: 0, width: 1024, height: 720 },
      },
    ]);
    position = { x: 32767, y: -32768 };
    await initialize();
    expect(size).toMatchObject({ width: 976, height: 672 });
    expect(position).toEqual({ x: 24, y: 24 });
  });
});

it.each([
  [-1500, 150], // 屏幕之间的空白区域，在虚拟桌面外接矩形内也算离屏。
  [1920, 1080], // 只接触屏幕边界，没有可见面积。
  [3200, 1800], // 上次使用的显示器已断开。
  [NaN, Infinity],
])("位置异常 (%s, %s) 时选择真正主屏，不依赖显示器枚举顺序", async (x, y) => {
  position = { x, y };
  await initialize();
  expect(position).toEqual({ x: 480, y: 166 });
});

it("不同缩放显示器统一使用原生物理像素范围，不重复放大副屏坐标", async () => {
  position = { x: -2200, y: -1200 };
  size.width = 2100;
  size.height = 1200;
  await initialize();
  expect(mocks.move).not.toHaveBeenCalled();
  expect(mocks.setSize).not.toHaveBeenCalled();
});

it("缩小超大窗口时仍保留原位置，恢复边框样式不再次设置尺寸", async () => {
  size.width = 2400;
  size.height = 1400;
  await initialize();
  expect(position).toEqual({ x: 120, y: 90 });
  expect(size).toMatchObject({ width: 1872, height: 984 });
  expect(mocks.setSize).toHaveBeenLastCalledWith(
    expect.objectContaining({ width: -1, height: -1, resizable: true }),
  );
  expect(mocks.setBorderless).toHaveBeenCalledWith(true);
  expect(mocks.move).not.toHaveBeenCalled();
});

it("旧默认尺寸只迁移一次，迁移不改变仍可见的位置", async () => {
  mocks.read.mockResolvedValue(null);
  size.width = 1100;
  size.height = 760;
  await initialize();
  expect(size).toMatchObject({ width: 1440, height: 900 });
  expect(position).toEqual({ x: 120, y: 90 });
  expect(mocks.move).not.toHaveBeenCalled();
  expect(mocks.write).toHaveBeenCalledWith(true);
});

it.each(["isMaximized", "isFullScreen", "isMinimized"] as const)(
  "保留窗口已有的 %s 状态",
  async (state) => {
    mocks[state].mockResolvedValue(true);
    await initialize();
    expect(mocks.move).not.toHaveBeenCalled();
    expect(mocks.setSize).not.toHaveBeenCalled();
  },
);

it("迁移设置读取失败不影响离屏窗口恢复，也不覆盖原设置", async () => {
  mocks.read.mockRejectedValue(new Error("安全模拟：设置不可读"));
  position = { x: 32767, y: -32768 };
  await initialize();
  expect(position).toEqual({ x: 480, y: 166 });
  expect(mocks.write).not.toHaveBeenCalled();
});

it("显示器查询失败时保留当前窗口并记录错误", async () => {
  mocks.request.mockRejectedValue(new Error("安全模拟：显示器查询失败"));
  await initialize();
  expect(mocks.move).not.toHaveBeenCalled();
  expect(mocks.setSize).not.toHaveBeenCalled();
  expect(mocks.log).toHaveBeenCalledWith(
    "warn",
    "window",
    "startup_size_failed",
    expect.any(String),
  );
});

it("重复初始化共享一次位置检查", async () => {
  const { initializeMainWindowSize } =
    await import("../frontend/src/platform/neutralino/mainWindowSize");
  const first = initializeMainWindowSize();
  expect(initializeMainWindowSize()).toBe(first);
  await first;
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith("window.displays");
});
