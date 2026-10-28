"use client";

/**
 * Locale context backed by a tiny external store (localStorage + listeners)
 * and read through `useSyncExternalStore`, so the server snapshot is always
 * "en" and the client snapshot is the stored/browser preference. The locale is
 * independent of the conversation: the server receives it with every message.
 *
 * A tiny inline script in the root layout applies `lang`/`dir` before first
 * paint so the layout does not visibly flip for Arabic users.
 */
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { LOCALES, type Locale } from "@/shared/contracts";
import { dictionaries, type Dictionary } from "./dictionaries";

export const LOCALE_STORAGE_KEY = "healtrip.locale";

export type Direction = "ltr" | "rtl";

export function directionFor(locale: Locale): Direction {
  return locale === "ar" ? "rtl" : "ltr";
}

function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Stored preference first, then the browser language (any `ar*` -> ar). */
export function detectLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // localStorage can throw in private mode / blocked storage; fall through.
  }
  const nav = (navigator.languages?.[0] ?? navigator.language ?? "").toLowerCase();
  return nav.startsWith("ar") ? "ar" : "en";
}

function applyToDocument(locale: Locale): void {
  document.documentElement.lang = locale;
  document.documentElement.dir = directionFor(locale);
}

// --- external store ---------------------------------------------------------

const listeners = new Set<() => void>();
let cached: Locale | null = null;

function getSnapshot(): Locale {
  if (cached === null) {
    cached = detectLocale();
    applyToDocument(cached);
  }
  return cached;
}

function getServerSnapshot(): Locale {
  return "en";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Keep tabs in sync when the preference changes elsewhere.
  const onStorage = (e: StorageEvent) => {
    if (e.key === LOCALE_STORAGE_KEY) {
      cached = null;
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function writeLocale(next: Locale): void {
  cached = next;
  applyToDocument(next);
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    // Preference simply will not persist; the UI still switches.
  }
  listeners.forEach((l) => l());
}

// --- context ----------------------------------------------------------------

type LocaleContextValue = {
  locale: Locale;
  dir: Direction;
  t: Dictionary;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const locale = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setLocale = useCallback((next: Locale) => writeLocale(next), []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      dir: directionFor(locale),
      t: dictionaries[locale],
      setLocale,
      toggleLocale: () => setLocale(locale === "ar" ? "en" : "ar"),
    }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used inside <LocaleProvider>");
  return ctx;
}

/**
 * Source of the inline script rendered by the root layout. Mirrors
 * `detectLocale` but must be dependency-free because it runs before React.
 */
export const LOCALE_BOOT_SCRIPT = `(function(){try{var k=${JSON.stringify(
  LOCALE_STORAGE_KEY,
)},s=localStorage.getItem(k),n=((navigator.languages&&navigator.languages[0])||navigator.language||"").toLowerCase(),l=(s==="ar"||s==="en")?s:(n.indexOf("ar")===0?"ar":"en");var d=document.documentElement;d.lang=l;d.dir=l==="ar"?"rtl":"ltr";}catch(e){}})();`;
