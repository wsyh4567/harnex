import { enUSMessages } from "./locales/en-US.ts";

export type TranslationKey = keyof typeof enUSMessages;
export type Messages = Record<TranslationKey, string>;
export type Locale = string;

export interface LocaleMeta {
  code: string;
  nativeLabel: string;
  shortLabel: string;
  messages: Partial<Messages> & Record<string, string>;
}
