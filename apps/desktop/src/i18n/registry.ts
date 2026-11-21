import { enUSMessages } from "./locales/en-US.ts";
import { zhCNMessages } from "./locales/zh-CN.ts";
import type { LocaleMeta } from "./types.ts";

/**
 * Add new languages here (e.g. ja-JP, ko-KR, de-DE) by creating a file under
 * `src/i18n/locales/` and appending a single entry to `SUPPORTED_LOCALES`.
 */
export const SUPPORTED_LOCALES: LocaleMeta[] = [
  {
    code: "zh-CN",
    nativeLabel: "简体中文",
    shortLabel: "中",
    messages: zhCNMessages,
  },
  {
    code: "en-US",
    nativeLabel: "English",
    shortLabel: "EN",
    messages: enUSMessages,
  },
];

export const DEFAULT_LOCALE = "en-US";
