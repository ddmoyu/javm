import english from "./locales/en.json";
import japanese from "./locales/ja.json";
import traditional from "./locales/zh-TW.json";

export const languages = [
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
] as const;
export type Locale = (typeof languages)[number]["value"];
export const isLocale = (value: unknown): value is Locale =>
  languages.some((language) => language.value === value);

const dictionaries: Record<Exclude<Locale, "zh-CN">, Record<string, string>> = {
  en: english,
  ja: japanese,
  "zh-TW": traditional,
};
let locale: Locale = "zh-CN";
const listeners = new Set<() => void>();
export const getLocale = () => locale;
export function subscribeLocale(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function setLocale(value: unknown) {
  const next = isLocale(value) ? value : "zh-CN";
  if (typeof document !== "undefined") {
    document.documentElement.lang = next;
    document.documentElement.dir = "ltr";
  }
  if (locale === next) return;
  locale = next;
  for (const listener of listeners) listener();
}

type TranslationValue = string | number | bigint | boolean | null | undefined;
const interpolate = (message: string, values: readonly TranslationValue[]) =>
  message.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    Number(index) < values.length ? String(values[Number(index)] ?? "") : placeholder,
  );
// 已保存任务仍持有源语言消息。显示时匹配已知模板，参数按原文保留。
// 限制输入长度与缓存大小；普通文案始终只做字典查询。
const templates = Object.keys(english)
  .filter((key) => /\{\d+\}/.test(key))
  .map((key) => {
    const indices = [...key.matchAll(/\{(\d+)\}/g)].map((match) => Number(match[1]));
    const pieces = key.split(/\{\d+\}/);
    return {
      key,
      prefix: pieces[0]!,
      indices,
      pieces,
    };
  })
  .sort((a, b) => b.prefix.length - a.prefix.length);
const messageCache = new Map<string, { key: string; values: string[] } | null>();

export function translate(
  source: string,
  target: Locale,
  values: readonly TranslationValue[] = [],
): string {
  if (target === "zh-CN") return interpolate(source, values);
  const dictionary = dictionaries[target];
  const direct = Object.hasOwn(dictionary, source) ? dictionary[source] : undefined;
  if (direct !== undefined) return interpolate(direct, values);
  if (values.length || source.length > 4096 || !/[\u3400-\u9fff]/.test(source))
    return interpolate(source, values);
  let match = messageCache.get(source);
  if (match === undefined) {
    match = null;
    for (const template of templates) {
      if (!source.startsWith(template.prefix)) continue;
      let offset = template.prefix.length;
      const parameters: string[] = [];
      let matches = true;
      for (let position = 0; position < template.indices.length; position++) {
        const separator = template.pieces[position + 1]!;
        const last = position === template.indices.length - 1;
        // 连续占位符无法无歧义还原；完整 UI 调用直接传参。
        if (!separator && !last) {
          matches = false;
          break;
        }
        const end = last
          ? source.endsWith(separator)
            ? source.length - separator.length
            : -1
          : source.indexOf(separator, offset);
        if (end < offset) {
          matches = false;
          break;
        }
        parameters[template.indices[position]!] = source.slice(offset, end);
        offset = end + separator.length;
      }
      if (!matches || offset !== source.length) continue;
      match = { key: template.key, values: parameters };
      break;
    }
    if (messageCache.size >= 512) messageCache.clear();
    messageCache.set(source, match);
  }
  return match ? interpolate(dictionary[match.key] ?? match.key, match.values) : source;
}

export function t(source: string, ...values: TranslationValue[]): string;
export function t<T>(source: T): T;
export function t(source: unknown, ...values: TranslationValue[]): unknown {
  return typeof source === "string" ? translate(source, locale, values) : source;
}

/** 只本地化控件选项，保留业务标识、禁用状态和排序。 */
export function localizeOptions<T>(options: T): T {
  if (!Array.isArray(options)) return options;
  return options.map((option: unknown) => {
    if (typeof option === "string") return { value: option, label: t(option) };
    if (!option || typeof option !== "object") return option;
    const value = option as Record<string, unknown>;
    return {
      ...value,
      ...(typeof value.label === "string" ? { label: t(value.label) } : {}),
      ...(typeof value.group === "string" ? { group: t(value.group) } : {}),
      ...(Array.isArray(value.items) ? { items: localizeOptions(value.items) } : {}),
    };
  }) as T;
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
export function formatDate(value: string | number | Date, options?: Intl.DateTimeFormatOptions) {
  const key = locale + JSON.stringify(options ?? {});
  let formatter = dateFormats.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    if (dateFormats.size >= 32) dateFormats.clear();
    dateFormats.set(key, formatter);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : formatter.format(date);
}
