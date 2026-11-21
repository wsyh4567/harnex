import { useCallback } from "react";
import { useCommandDeckStore } from "../stores/useCommandDeckStore.ts";
import { translate, type TranslationKey } from "./index.ts";

export function useI18n() {
  const locale = useCommandDeckStore((s) => s.locale);
  const setLocale = useCommandDeckStore((s) => s.setLocale);
  const toggleLocale = useCommandDeckStore((s) => s.toggleLocale);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) =>
      translate(locale, key, vars),
    [locale],
  );

  return { locale, setLocale, toggleLocale, t };
}
