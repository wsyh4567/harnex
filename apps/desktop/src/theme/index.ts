export type ThemeMode = "light" | "dark";

export const THEME_STORAGE_KEY = "harnex.theme";

export function getInitialTheme(): ThemeMode {
  try {
    if (typeof localStorage !== "undefined") {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === "light" || stored === "dark") {
        return stored;
      }
    }
  } catch {
    // Ignore storage restriction
  }
  return "light";
}

export function applyTheme(theme: ThemeMode): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
  } catch {
    // Ignore storage restriction
  }

  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }
}
