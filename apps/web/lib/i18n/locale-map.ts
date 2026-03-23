import countries from "i18n-iso-countries";
import en from "i18n-iso-countries/langs/en.json";
import zh from "i18n-iso-countries/langs/zh.json";
import ja from "i18n-iso-countries/langs/ja.json";
import es from "i18n-iso-countries/langs/es.json";
import fr from "i18n-iso-countries/langs/fr.json";
import de from "i18n-iso-countries/langs/de.json";
import ko from "i18n-iso-countries/langs/ko.json";
import pt from "i18n-iso-countries/langs/pt.json";
import it from "i18n-iso-countries/langs/it.json";
import ru from "i18n-iso-countries/langs/ru.json";
import tr from "i18n-iso-countries/langs/tr.json";
import type { AppLocale } from "@/locales";

countries.registerLocale(en);
countries.registerLocale(zh);
countries.registerLocale(ja);
countries.registerLocale(es);
countries.registerLocale(fr);
countries.registerLocale(de);
countries.registerLocale(ko);
countries.registerLocale(pt);
countries.registerLocale(it);
countries.registerLocale(ru);
countries.registerLocale(tr);

export type CountryCode = string;

function toCountryLocale(locale: AppLocale) {
  if (locale === "zh-CN") return "zh";
  if (locale === "zh-HK") return "zh";
  if (locale === "zh-MO") return "zh";
  if (locale === "zh-TW") return "zh";
  if (locale === "ja-JP") return "ja";
  if (locale === "es-ES") return "es";
  if (locale === "fr-FR") return "fr";
  if (locale === "de-DE") return "de";
  if (locale === "ko-KR") return "ko";
  if (locale === "pt-BR") return "pt";
  if (locale === "it-IT") return "it";
  if (locale === "ru-RU") return "ru";
  if (locale === "tr-TR") return "tr";
  return "en";
}

export function getCountryOptions(locale: AppLocale): Array<{
  value: string;
  label: string;
}> {
  const countryLocale = toCountryLocale(locale);
  const names = countries.getNames(countryLocale, { select: "official" });
  return Object.entries(names)
    .map(([code, label]) => ({ value: code, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function isCountryCode(input: string | null | undefined): input is CountryCode {
  if (!input) return false;
  return countries.isValid(input.toUpperCase());
}

export function getLocaleFromCountry(country: string | null | undefined): AppLocale {
  const normalized = (country ?? "").toUpperCase();
  if (normalized === "CN") return "zh-CN";
  if (normalized === "HK") return "zh-HK";
  if (normalized === "MO") return "zh-MO";
  if (normalized === "TW") return "zh-TW";
  if (normalized === "JP") return "ja-JP";
  if (normalized === "ES") return "es-ES";
  if (normalized === "FR") return "fr-FR";
  if (normalized === "DE") return "de-DE";
  if (normalized === "KR") return "ko-KR";
  if (normalized === "BR") return "pt-BR";
  if (normalized === "IT") return "it-IT";
  if (normalized === "RU") return "ru-RU";
  if (normalized === "TR") return "tr-TR";
  return "en-US";
}
