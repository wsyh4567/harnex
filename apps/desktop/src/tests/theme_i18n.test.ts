import { beforeEach, describe, expect, it } from "bun:test";
import {
  enUSMessages,
  getInitialLocale,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  translate,
  zhCNMessages,
} from "../i18n/index.ts";
import { MockIpcAdapter } from "../ipc/index.ts";
import { useCommandDeckStore } from "../stores/useCommandDeckStore.ts";
import { applyTheme, getInitialTheme, THEME_STORAGE_KEY } from "../theme/index.ts";

function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
  return store;
}

describe("Dual Theme (Light/Dark) & Modular Bilingual i18n", () => {
  beforeEach(() => {
    installMemoryLocalStorage();
  });

  it("defaults to Light theme, toggles Light <-> Dark, and persists in localStorage", () => {
    expect(getInitialTheme()).toBe("light");

    applyTheme("dark");
    expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(getInitialTheme()).toBe("dark");

    applyTheme("light");
    expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(getInitialTheme()).toBe("light");
  });

  it("verifies zh-CN and en-US dictionaries have 100% key parity and registry structure", () => {
    const enKeys = Object.keys(enUSMessages).sort();
    const zhKeys = Object.keys(zhCNMessages).sort();

    expect(zhKeys).toEqual(enKeys);
    expect(enKeys.length).toBeGreaterThan(100);
    expect(SUPPORTED_LOCALES.map((l) => l.code)).toEqual(["zh-CN", "en-US"]);

    for (const key of enKeys) {
      expect(enUSMessages[key as keyof typeof enUSMessages].trim().length).toBeGreaterThan(0);
      expect(zhCNMessages[key as keyof typeof zhCNMessages].trim().length).toBeGreaterThan(0);
    }

    // Interpolation + fallback to en-US for unknown locale
    expect(translate("zh-CN", "update.pillDownloading", { pct: 64 })).toBe("下载中 64%");
    expect(translate("en-US", "update.pillDownloading", { pct: 64 })).toBe("Downloading 64%");
    expect(translate("ja-JP", "top.liveTauri")).toBe("Live Tauri L0");
  });

  it("switches theme and locale cleanly through Zustand store and persists locale", async () => {
    const adapter = new MockIpcAdapter({ simulationDelayMs: 0 });
    await useCommandDeckStore.getState().initialize(adapter);

    useCommandDeckStore.getState().setTheme("light");
    expect(useCommandDeckStore.getState().theme).toBe("light");
    useCommandDeckStore.getState().toggleTheme();
    expect(useCommandDeckStore.getState().theme).toBe("dark");
    expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    useCommandDeckStore.getState().setLocale("zh-CN");
    expect(useCommandDeckStore.getState().locale).toBe("zh-CN");
    expect(globalThis.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN");
    expect(getInitialLocale()).toBe("zh-CN");

    useCommandDeckStore.getState().toggleLocale();
    expect(useCommandDeckStore.getState().locale).toBe("en-US");
    expect(globalThis.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en-US");
  });
});
