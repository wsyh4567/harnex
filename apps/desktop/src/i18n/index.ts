import { enUSMessages } from "./locales/en-US.ts";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./registry.ts";
import type { Locale, TranslationKey } from "./types.ts";

export type { Locale, LocaleMeta, Messages, TranslationKey } from "./types.ts";
export { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./registry.ts";
export { enUSMessages } from "./locales/en-US.ts";
export { zhCNMessages } from "./locales/zh-CN.ts";
export { useI18n } from "./useI18n.ts";

export const LOCALE_STORAGE_KEY = "harnex.locale";

const localeMap = new Map(SUPPORTED_LOCALES.map((item) => [item.code, item]));

export function isSupportedLocale(code: string | null | undefined): code is Locale {
  return Boolean(code && localeMap.has(code));
}

export function getInitialLocale(): Locale {
  try {
    if (typeof localStorage !== "undefined") {
      const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
      if (isSupportedLocale(stored)) {
        return stored;
      }
    }
  } catch {
    // Ignore storage restriction
  }
  if (typeof navigator !== "undefined" && navigator.language) {
    const lang = navigator.language.toLowerCase();
    const exact = SUPPORTED_LOCALES.find((l) => l.code.toLowerCase() === lang);
    if (exact) return exact.code;
    const prefix = lang.split("-")[0];
    const matched = SUPPORTED_LOCALES.find((l) => l.code.toLowerCase().startsWith(`${prefix}-`));
    if (matched) return matched.code;
  }
  return DEFAULT_LOCALE;
}

export function setStoredLocale(locale: Locale): void {
  const resolved = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LOCALE_STORAGE_KEY, resolved);
    }
  } catch {
    // Ignore storage restriction
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = resolved;
  }
}

export function translate(
  locale: Locale,
  key: TranslationKey,
  vars?: Record<string, string | number>,
): string {
  const activeMessages = localeMap.get(locale)?.messages;
  let text: string = activeMessages?.[key] ?? enUSMessages[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}
