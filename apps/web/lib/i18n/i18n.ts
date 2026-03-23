import "server-only";
import { cookies, headers } from "next/headers";
import { ensureDatabaseSchema, getPortalUserById } from "@workspace/database";
import {
  dictionaries,
  locales,
  resolveLocale,
  translate,
  type AppLocale,
  type LocaleKey,
} from "@/locales";
import { resolvePortalSessionFromCookieStore } from "@/lib/auth/admin-auth";
import { LOCALE_COOKIE } from "@/lib/i18n/i18n-shared";
import { getLocaleFromCountry } from "@/lib/i18n/locale-map";

async function getLocaleFromRequestHeaders(): Promise<AppLocale> {
  const headerStore = await headers();
  const acceptLanguage = headerStore.get("accept-language");
  if (!acceptLanguage) return "en-US";

  const first = acceptLanguage.split(",")[0]?.trim();
  return resolveLocale(first);
}

export async function getServerRequestLocale(): Promise<AppLocale> {
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  if (fromCookie) return resolveLocale(fromCookie);

  return getLocaleFromRequestHeaders();
}

export async function getServerLocale(): Promise<AppLocale> {
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  if (fromCookie) return resolveLocale(fromCookie);

  const resolved = await resolvePortalSessionFromCookieStore(cookieStore);
  if (resolved) {
    try {
      if (resolved.session.sub) {
        await ensureDatabaseSchema();
        const user = await getPortalUserById(resolved.session.sub);
        if (user) {
          return getLocaleFromCountry(user.country);
        }
      }
    } catch {
      // Fall through to accept-language.
    }
  }

  return getLocaleFromRequestHeaders();
}

export async function getServerTranslator() {
  const locale = await getServerLocale();
  return {
    locale,
    locales,
    t: (key: LocaleKey) => translate(locale, key),
  };
}

export function getClientTranslator(locale: AppLocale) {
  return {
    t: (key: LocaleKey) =>
      dictionaries[locale][key] ?? dictionaries["en-US"][key] ?? key,
  };
}
