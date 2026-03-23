"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  dictionaries,
  locales,
  resolveLocale,
  translate,
  type AppLocale,
  type LocaleKey,
} from "@/locales";
import { LOCALE_COOKIE } from "@/lib/i18n/i18n-shared";

type LocaleContextValue = {
  locale: AppLocale;
  locales: readonly AppLocale[];
  setLocale: (locale: AppLocale) => void;
  toggleLocale: () => void;
  t: (key: LocaleKey) => string;
};

const LOCALE_STORAGE_KEY = "portal_locale";
const LocaleContext = React.createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [locale, setLocaleState] = React.useState<AppLocale>("en-US");

  React.useEffect(() => {
    const cookieValue = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${LOCALE_COOKIE}=`))
      ?.slice(LOCALE_COOKIE.length + 1);
    if (cookieValue) {
      try {
        setLocaleState(resolveLocale(decodeURIComponent(cookieValue)));
        return;
      } catch {
        setLocaleState(resolveLocale(cookieValue));
        return;
      }
    }
    const fromStorage = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (fromStorage) {
      setLocaleState(resolveLocale(fromStorage));
      return;
    }
    const nav = window.navigator.language;
    setLocaleState(resolveLocale(nav));
  }, []);

  const persistLocale = React.useCallback((next: AppLocale) => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(next)}; path=/; max-age=31536000; samesite=lax`;
  }, []);

  const setLocale = React.useCallback(
    (next: AppLocale) => {
      if (locale === next) return;
      setLocaleState(next);
      persistLocale(next);
      router.refresh();
    },
    [locale, persistLocale, router],
  );

  const toggleLocale = React.useCallback(() => {
    const index = locales.indexOf(locale);
    const next = locales[(index + 1) % locales.length] ?? "en-US";
    setLocale(next);
  }, [locale, setLocale]);

  const t = React.useCallback(
    (key: LocaleKey) =>
      dictionaries[locale][key] ?? translate("en-US", key),
    [locale],
  );

  const value = React.useMemo(
    () => ({ locale, locales, setLocale, toggleLocale, t }),
    [locale, setLocale, toggleLocale, t],
  );

  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
}

export function useLocale() {
  const ctx = React.useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used within LocaleProvider");
  return ctx;
}
