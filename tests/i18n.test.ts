import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  getLocale,
  languages,
  localizeOptions,
  setLocale,
  subscribeLocale,
  translate,
} from "../frontend/src/i18n/core";
import english from "../frontend/src/i18n/locales/en.json";
import japanese from "../frontend/src/i18n/locales/ja.json";
import traditional from "../frontend/src/i18n/locales/zh-TW.json";
import { UiPreferencesService } from "../frontend/src/services/settings/UiPreferencesService";
import type { UiPreferences } from "../frontend/src/services/settings/UiPreferencesService";

const defaults: UiPreferences = {
  colorScheme: "dark",
  navCollapsed: false,
  cardClickToPlay: true,
  discoverCardWidth: 260,
};
afterEach(() => setLocale("zh-CN"));

describe("界面多语言", () => {
  it("四种语言覆盖相同消息并保留插值参数", () => {
    const keys = Object.keys(english).sort();
    const parameters = (text: string) =>
      [...text.matchAll(/\{\d+\}/g)].map((match) => match[0]).sort();
    for (const dictionary of [english, japanese, traditional]) {
      expect(Object.keys(dictionary).sort()).toEqual(keys);
      for (const [key, value] of Object.entries(dictionary)) {
        expect(value.length, key).toBeGreaterThan(0);
        expect(parameters(value), key).toEqual(parameters(key));
      }
    }
    expect(languages.map((item) => item.value)).toEqual(["zh-CN", "zh-TW", "en", "ja"]);
    expect(translate("显示语言", "en")).toBe("Display language");
    expect(translate("显示语言", "ja")).toBe("表示言語");
    expect(translate("显示语言", "zh-TW")).toBe("顯示語言");
  });
  it("插值保留媒体标题、路径和特殊字符", () => {
    const title = "媒体库 <safe> $& {1}";
    expect(translate("当前影片：{0}", "en", [title])).toBe(`Current title: ${title}`);
    expect(translate("原路径：{0}", "ja", ["C:/安全示例/视频.mp4"])).toBe(
      "元のパス: C:/安全示例/视频.mp4",
    );
    expect(translate("未知的安全样例文案", "en")).toBe("未知的安全样例文案");
  });
  it("已保存的动态消息在显示时翻译，超长消息保持原文", () => {
    expect(translate("发现 JAVM 1.2.3，可前往系统设置下载更新。", "en")).toBe(
      "JAVM 1.2.3 is available. Download it in Settings.",
    );
    expect(translate("已找到 12 条磁力", "ja")).toBe("12 件のマグネットを検出");
    const long = "安全内容".repeat(2048);
    expect(translate(long, "en")).toBe(long);
  });
  it("选项只翻译标签并保留业务值、顺序和禁用状态", () => {
    setLocale("en");
    const options = [
      { value: "女演员", label: "女演员", disabled: true },
      { value: "studios", label: "制作商" },
    ];
    expect(localizeOptions(options)).toEqual([
      { value: "女演员", label: "Actresses", disabled: true },
      { value: "studios", label: "Studio" },
    ]);
    expect(options[0]!.label).toBe("女演员");
    expect(localizeOptions(["女演员"])).toEqual([{ value: "女演员", label: "Actresses" }]);
  });
  it("只在语言变化时通知订阅者，未知语言回退简体中文", () => {
    const observed: string[] = [];
    const stop = subscribeLocale(() => observed.push(getLocale()));
    setLocale("en");
    setLocale("en");
    setLocale("ja");
    setLocale("invalid");
    stop();
    setLocale("zh-TW");
    expect(observed).toEqual(["en", "ja", "zh-CN"]);
  });
  it("旧偏好兼容，语言保存后可重载并同步另一窗口", async () => {
    let stored: UiPreferences = { ...defaults };
    const store = {
      read: async () => stored,
      write: async (value: UiPreferences) => {
        stored = { ...value };
      },
    };
    const first = new UiPreferencesService(store, defaults, () => null);
    const second = new UiPreferencesService(store, defaults, () => null);
    await Promise.all([first.initialize(), second.initialize()]);
    expect(first.getSnapshot().value).toEqual(defaults);
    await first.update({ language: "ja" });
    await second.refresh();
    expect(second.getSnapshot().value).toEqual({ ...defaults, language: "ja" });
    const reopened = new UiPreferencesService(store, defaults, () => null);
    await reopened.initialize();
    expect(reopened.getSnapshot().value.language).toBe("ja");
  });
  it("保存失败恢复原语言并保留可翻译的错误提示", async () => {
    const service = new UiPreferencesService(
      {
        read: async () => ({ ...defaults, language: "en" }),
        write: async () => {
          throw new Error("safe write failure");
        },
      },
      defaults,
      () => null,
    );
    await service.initialize();
    const synchronize = () => setLocale(service.getSnapshot().value.language);
    synchronize();
    const stop = service.subscribe(synchronize);
    await service.update({ language: "ja" });
    expect(getLocale()).toBe("en");
    expect(service.getSnapshot().error).toBe("界面偏好保存失败，已恢复上次设置，请重试。");
    stop();
  });
});
