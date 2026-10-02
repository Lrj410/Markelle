import { useSyncExternalStore } from "react";
import { getLocale, subscribeLocale, type Locale } from "../lib/i18n";

/** Re-render when UI locale changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}
