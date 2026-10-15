import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PrivacyService,
  defaultPrivacySettings,
} from "../frontend/src/services/privacy/PrivacyService";
import type {
  PrivacyRecord,
  PrivacySettings,
} from "../frontend/src/services/privacy/PrivacyService";
import { matchesShortcut, validateShortcut } from "../frontend/src/services/privacy/shortcuts";
import { deferred } from "./helpers/deferred";

const password = "Safe-Fixture-2026";
function fixture(initial: unknown = null) {
  let saved = initial;
  const store = {
    read: vi.fn(async () => saved),
    write: vi.fn(async (value: PrivacyRecord) => {
      saved = structuredClone(value);
    }),
  };
  const register = vi.fn(async (_settings: PrivacySettings) => {});
  const hide = vi.fn(async (_hidden: boolean) => {});
  return {
    service: new PrivacyService(store, register, hide),
    store,
    register,
    hide,
    saved: () => saved as PrivacyRecord,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("隐私保护定向验证（仅安全虚构数据）", () => {
  it("默认 F1 / F9，最多一个修饰键，Esc 和已用组合保留原行为", () => {
    expect(defaultPrivacySettings.localShortcut.key).toBe("F1");
    expect(defaultPrivacySettings.globalShortcut.key).toBe("F9");
    for (const shortcut of [
      { key: "Escape", modifier: "" },
      { key: "F12", modifier: "" },
      { key: "K", modifier: "Ctrl" },
      { key: "A", modifier: "Shift" },
      { key: "F4", modifier: "Alt" },
      { key: "Q", modifier: "Ctrl+Alt" },
    ])
      expect(() => validateShortcut(shortcut)).toThrow();
    expect(validateShortcut({ key: "Q", modifier: "Ctrl" })).toEqual({
      key: "Q",
      modifier: "Ctrl",
    });
    expect(
      matchesShortcut(
        {
          key: "F1",
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        } as KeyboardEvent,
        defaultPrivacySettings.localShortcut,
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        {
          key: "Escape",
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        } as KeyboardEvent,
        defaultPrivacySettings.localShortcut,
      ),
    ).toBe(false);
  });
  it("系统热键冲突拒绝保存，并保留原快捷键与设置", async () => {
    const f = fixture();
    await f.service.initialize();
    f.register.mockClear();
    f.register.mockRejectedValueOnce(new Error("全局快捷键已被占用"));
    await expect(
      f.service.saveSettings({
        ...defaultPrivacySettings,
        globalShortcut: { key: "F8", modifier: "" },
      }),
    ).rejects.toThrow("占用");
    expect(f.service.getSnapshot().settings.globalShortcut.key).toBe("F9");
    expect(f.store.write).not.toHaveBeenCalled();
    expect(f.service.getSnapshot().busy).toBe(false);
  });
  it("应用内与全局同键在进入原生注册前拒绝", async () => {
    const f = fixture();
    await f.service.initialize();
    f.register.mockClear();
    await expect(
      f.service.saveSettings({
        ...defaultPrivacySettings,
        localShortcut: { key: "F9", modifier: "" },
      }),
    ).rejects.toThrow("不能相同");
    expect(f.register).not.toHaveBeenCalled();
  });
  it("持久化失败恢复旧热键，不发布未保存的偏好", async () => {
    const f = fixture();
    await f.service.initialize();
    f.register.mockClear();
    f.store.write.mockRejectedValueOnce(new Error("模拟只读目录"));
    await expect(
      f.service.saveSettings({
        ...defaultPrivacySettings,
        globalShortcut: { key: "F8", modifier: "" },
      }),
    ).rejects.toThrow("保存失败");
    expect(f.register.mock.calls.map(([settings]) => settings.globalShortcut.key)).toEqual([
      "F8",
      "F9",
    ]);
    expect(f.service.getSnapshot().settings).toEqual(defaultPrivacySettings);
  });
  it("启动全局占用仍先建立应用内按键并显示错误", async () => {
    const f = fixture();
    f.register.mockImplementation(async (settings) => {
      if (settings.globalEnabled) throw new Error("模拟全局占用");
    });
    await f.service.initialize();
    expect(f.register.mock.calls[0]![0]).toMatchObject({
      globalEnabled: false,
      localEnabled: true,
      localShortcut: { key: "F1" },
    });
    expect(f.service.getSnapshot()).toMatchObject({
      ready: true,
      locked: false,
      shortcutError: "模拟全局占用",
    });
  });
  it("损坏设置保持锁定且不覆盖原记录，可重新读取恢复", async () => {
    const f = fixture({ version: 1, settings: {}, credential: null });
    await f.service.initialize();
    expect(f.service.getSnapshot()).toMatchObject({ ready: false, locked: true });
    expect(f.store.write).not.toHaveBeenCalled();
    f.store.read.mockResolvedValueOnce(null);
    await f.service.initialize();
    expect(f.service.getSnapshot()).toMatchObject({ ready: true, locked: false });
  });
  it("未设置密码不能启用启动锁或老板键恢复锁", async () => {
    const f = fixture();
    await f.service.initialize();
    for (const key of ["lockOnStartup", "lockOnBossKey"])
      await expect(
        f.service.saveSettings({ ...defaultPrivacySettings, [key]: true }),
      ).rejects.toThrow("先设置密码");
    expect(f.store.write).not.toHaveBeenCalled();
  });
  it("密码不以明文保存，重启锁定，错误密码不解锁，正确密码解锁", async () => {
    const f = fixture();
    await f.service.initialize();
    await f.service.changePassword("", password);
    expect(JSON.stringify(f.saved())).not.toContain(password);
    expect(f.saved().credential).toMatchObject({ iterations: 600000 });
    expect(f.saved().credential!.salt).toMatch(/^[a-f0-9]{32}$/);
    await f.service.saveSettings({ ...defaultPrivacySettings, lockOnStartup: true });
    const restarted = fixture(f.saved());
    await restarted.service.initialize();
    expect(restarted.service.getSnapshot().locked).toBe(true);
    await expect(restarted.service.unlock("wrong-safe-password")).rejects.toThrow("不正确");
    expect(restarted.service.getSnapshot().locked).toBe(true);
    await restarted.service.unlock(password);
    expect(restarted.service.getSnapshot()).toMatchObject({ locked: false, hidden: false });
  });
  it("启动锁与老板键恢复锁互不隐式启用，托盘恢复不绕过密码", async () => {
    const f = fixture();
    await f.service.initialize();
    await f.service.changePassword("", password);
    await f.service.saveSettings({ ...defaultPrivacySettings, lockOnBossKey: true });
    const restarted = fixture(f.saved());
    await restarted.service.initialize();
    expect(restarted.service.getSnapshot().locked).toBe(false);
    await restarted.service.conceal();
    await restarted.service.restore();
    expect(restarted.service.getSnapshot()).toMatchObject({ locked: true, hidden: false });
    await restarted.service.unlock(password);
    await restarted.service.saveSettings({ ...defaultPrivacySettings, lockOnStartup: true });
    await restarted.service.conceal();
    await restarted.service.restore();
    expect(restarted.service.getSnapshot()).toMatchObject({ locked: false, hidden: false });
  });
  it("五次错误后限制尝试，冷却后可继续；移除密码需当前密码", async () => {
    const f = fixture();
    await f.service.initialize();
    await f.service.changePassword("", password);
    await f.service.conceal(true);
    for (let i = 0; i < 5; ++i)
      await expect(f.service.unlock("wrong-safe-password")).rejects.toThrow("不正确");
    await expect(f.service.unlock(password)).rejects.toThrow("30 秒");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 30001);
    await f.service.unlock(password);
    await expect(f.service.changePassword("wrong-safe-password", null)).rejects.toThrow("不正确");
    expect(f.service.getSnapshot().hasPassword).toBe(true);
    await f.service.changePassword(password, null);
    expect(f.service.getSnapshot()).toMatchObject({
      hasPassword: false,
      settings: { lockOnStartup: false, lockOnBossKey: false },
    });
  });
  it("验证过程中再次按老板键，迟到的正确密码不能解锁", async () => {
    const f = fixture();
    await f.service.initialize();
    await f.service.changePassword("", password);
    await f.service.conceal(true);
    const unlocking = f.service.unlock(password);
    await f.service.conceal();
    await unlocking;
    expect(f.service.getSnapshot()).toMatchObject({ locked: true, hidden: true });
  });
  it("立即锁定尚未完成时按老板键，仍补上主窗口隐藏", async () => {
    const f = fixture();
    await f.service.initialize();
    await f.service.changePassword("", password);
    const delayed = deferred<void>();
    f.hide.mockImplementationOnce(() => delayed.promise);
    const locking = f.service.conceal(true);
    const hiding = f.service.conceal();
    expect(f.service.getSnapshot()).toMatchObject({ locked: true, hidden: true });
    delayed.resolve();
    await Promise.all([locking, hiding]);
    expect(f.hide.mock.calls.map(([hidden]) => hidden)).toEqual([false, true]);
  });
  it("恢复等待期间重新隐藏，迟到的恢复请求不显示内容", async () => {
    const f = fixture();
    await f.service.initialize();
    const delayed = deferred<void>();
    f.hide.mockImplementationOnce(() => delayed.promise);
    const hiding = f.service.conceal();
    const restoring = f.service.restore();
    const hidingAgain = f.service.conceal();
    delayed.resolve();
    await Promise.all([hiding, hidingAgain]);
    expect(await restoring).toBe(false);
    expect(f.service.getSnapshot().hidden).toBe(true);
  });
  it("原生隐藏失败时仍保持内容遮挡并反馈错误", async () => {
    const f = fixture();
    await f.service.initialize();
    f.hide.mockRejectedValueOnce(new Error("模拟窗口 API 失败"));
    await expect(f.service.conceal()).rejects.toThrow("隐藏失败");
    expect(f.service.getSnapshot()).toMatchObject({ hidden: true });
    expect(f.service.getSnapshot().error).toContain("已遮挡");
  });
});
