"use client";

import { useLocale } from "@/i18n/locale";

/** Single button that flips EN <-> AR; its label is always the *other* language. */
export function LocaleToggle() {
  const { locale, t, toggleLocale } = useLocale();
  return (
    <button
      type="button"
      onClick={toggleLocale}
      aria-label={`${t.localeToggle.label}: ${t.localeToggle.switchTo}`}
      lang={locale === "ar" ? "en" : "ar"}
      className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-sm font-medium text-zinc-700 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
    >
      {t.localeToggle.switchTo}
    </button>
  );
}
