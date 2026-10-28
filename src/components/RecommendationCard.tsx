"use client";

import type { Recommendation, Urgency } from "@/shared/contracts";
import { useLocale } from "@/i18n/locale";
import { ProviderCard } from "./ProviderCard";

const URGENCY_STYLES: Record<Urgency, { badge: string; border: string }> = {
  emergency: { badge: "bg-red-600 text-white", border: "border-red-300" },
  urgent: { badge: "bg-orange-500 text-white", border: "border-orange-300" },
  routine: { badge: "bg-sky-600 text-white", border: "border-sky-300" },
  self_care: { badge: "bg-emerald-600 text-white", border: "border-emerald-300" },
};

/** Structured recommendation produced by the server's `recommend_next_step` tool. */
export function RecommendationCard({ recommendation }: { recommendation: Recommendation }) {
  const { t } = useLocale();
  const styles = URGENCY_STYLES[recommendation.urgency];
  return (
    <section
      aria-label={t.recommendation.title}
      className={`rounded-lg border-2 bg-white p-4 ${styles.border}`}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{t.recommendation.title}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span className={`rounded-md px-2.5 py-1 text-sm font-semibold ${styles.badge}`}>
          {t.nextStepLabels[recommendation.nextStep]}
        </span>
        <span className="text-sm text-zinc-700">
          {t.recommendation.urgency}: <strong>{t.urgencyLabels[recommendation.urgency]}</strong>
        </span>
        {recommendation.specialty ? (
          <span className="text-sm text-zinc-700">· {t.specialties[recommendation.specialty]}</span>
        ) : null}
      </div>

      <p className="mt-3 text-sm text-zinc-800">
        <span className="font-medium">{t.recommendation.rationale}: </span>
        {recommendation.rationale}
      </p>

      {recommendation.questionsRemaining.length > 0 ? (
        <div className="mt-3 text-sm text-zinc-800">
          <p className="font-medium">{t.recommendation.questionsRemaining}:</p>
          <ul className="mt-1 list-disc space-y-0.5 ps-5">
            {recommendation.questionsRemaining.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-3">
        <p className="text-sm font-medium text-zinc-800">{t.recommendation.providers}</p>
        {recommendation.providers.length === 0 ? (
          <p className="mt-1 text-xs text-zinc-500">{t.recommendation.noProviders}</p>
        ) : (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {recommendation.providers.map((p) => (
              <ProviderCard key={p.id} provider={p} />
            ))}
          </div>
        )}
      </div>

      <p className="mt-3 border-t border-zinc-100 pt-2 text-xs text-zinc-500">{t.recommendation.disclaimer}</p>
    </section>
  );
}
