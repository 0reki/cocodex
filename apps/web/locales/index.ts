import { enUS } from "./en-US";
import { zhCN } from "./zh-CN";
import { zhHK } from "./zh-HK";
import { zhMO } from "./zh-MO";
import { zhTW } from "./zh-TW";
import { jaJP } from "./ja-JP";
import { esES } from "./es-ES";
import { frFR } from "./fr-FR";
import { deDE } from "./de-DE";
import { koKR } from "./ko-KR";
import { ptBR } from "./pt-BR";
import { itIT } from "./it-IT";
import { ruRU } from "./ru-RU";
import { trTR } from "./tr-TR";

export const locales = [
  "en-US",
  "zh-CN",
  "zh-HK",
  "zh-MO",
  "zh-TW",
  "ja-JP",
  "es-ES",
  "fr-FR",
  "de-DE",
  "ko-KR",
  "pt-BR",
  "it-IT",
  "ru-RU",
  "tr-TR",
] as const;
export type AppLocale = (typeof locales)[number];

export const dictionaries = {
  "en-US": enUS,
  "zh-CN": zhCN,
  "zh-HK": zhHK,
  "zh-MO": zhMO,
  "zh-TW": zhTW,
  "ja-JP": jaJP,
  "es-ES": esES,
  "fr-FR": frFR,
  "de-DE": deDE,
  "ko-KR": koKR,
  "pt-BR": ptBR,
  "it-IT": itIT,
  "ru-RU": ruRU,
  "tr-TR": trTR,
} as const;

export type LocaleKey = keyof typeof enUS;

export function resolveLocale(input: string | null | undefined): AppLocale {
  if (!input) return "en-US";
  const normalized = input.trim();
  if (normalized === "en" || normalized === "en-US") return "en-US";
  const lower = normalized.toLowerCase();
  if (lower === "zh-hk" || lower === "zh-hant-hk") return "zh-HK";
  if (lower === "zh-mo" || lower === "zh-hant-mo") return "zh-MO";
  if (lower === "zh-tw" || lower === "zh-hant-tw") return "zh-TW";
  if (lower.startsWith("zh-hant")) return "zh-TW";
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("ja")) return "ja-JP";
  if (lower.startsWith("es")) return "es-ES";
  if (lower.startsWith("fr")) return "fr-FR";
  if (lower.startsWith("de")) return "de-DE";
  if (lower.startsWith("ko")) return "ko-KR";
  if (lower.startsWith("pt")) return "pt-BR";
  if (lower.startsWith("it")) return "it-IT";
  if (lower.startsWith("ru")) return "ru-RU";
  if (lower.startsWith("tr")) return "tr-TR";
  return "en-US";
}

export function translate(locale: AppLocale, key: LocaleKey): string {
  return dictionaries[locale][key] ?? dictionaries["en-US"][key] ?? key;
}
