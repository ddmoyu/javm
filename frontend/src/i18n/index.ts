import { useSyncExternalStore } from "react";
import { getLocale, subscribeLocale } from "./core";
export {
  t,
  localizeOptions,
  formatDate,
  getLocale,
  languages,
  isLocale,
  subscribeLocale,
} from "./core";
export type { Locale } from "./core";

export function useLocale() {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}
