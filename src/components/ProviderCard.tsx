"use client";

import type { ProviderSummary } from "@/shared/contracts";
import { useLocale } from "@/i18n/locale";

/**
 * Renders a provider row exactly as the server returned it from the database.
 * This component is the only place provider names appear as structured data.
 */
export function ProviderCard({ provider }: { provider: ProviderSummary }) {
  const { locale, t } = useLocale();
  const name = locale === "ar" ? provider.nameAr : provider.nameEn;
  return (
    <article className="rounded-lg border border-zinc-200 bg-white p-3 text-sm shadow-xs">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="font-semibold text-zinc-900">{name}</h4>
          <p className="text-xs text-zinc-600">
            {t.providerKind[provider.kind]} · {provider.city}, {provider.country}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
          <span className="sr-only">{t.provider.rating}: </span>
          <span aria-hidden="true">★ </span>
          {provider.rating.toFixed(1)}
        </span>
      </div>

      <dl className="mt-2 space-y-1 text-xs text-zinc-700">
        <div className="flex gap-1">
          <dt className="font-medium">{t.provider.specialties}:</dt>
          <dd>{provider.specialties.map((s) => t.specialties[s]).join("، ")}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="font-medium">{t.provider.languages}:</dt>
          <dd>{provider.languages.map((l) => t.languages[l]).join("، ")}</dd>
        </div>
      </dl>

      <ul className="mt-2 flex flex-wrap gap-1.5">
        <li className="rounded-full border border-zinc-200 px-2 py-0.5 text-xs text-zinc-700">
          {t.priceTier[provider.priceTier]}
        </li>
        {provider.emergencyCapable ? (
          <li className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-800">
            {t.provider.emergencyCapable}
          </li>
        ) : null}
        {provider.telemedicine ? (
          <li className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-800">
            {t.provider.telemedicine}
          </li>
        ) : null}
        {provider.acceptsInternational ? (
          <li className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-800">
            {t.provider.acceptsInternational}
          </li>
        ) : null}
      </ul>
    </article>
  );
}
