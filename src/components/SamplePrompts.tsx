"use client";

import { useLocale } from "@/i18n/locale";

/** Empty-state shortcuts; clicking one sends it as the first message. */
export function SamplePrompts({ onPick, disabled }: { onPick: (text: string) => void; disabled: boolean }) {
  const { t } = useLocale();
  return (
    <div className="mx-auto max-w-xl text-center">
      <p className="text-sm text-zinc-600">{t.tagline}</p>
      <p className="mt-5 text-xs font-medium uppercase tracking-wide text-zinc-500">{t.samplePromptsTitle}</p>
      <ul className="mt-2 flex flex-col gap-2">
        {t.samplePrompts.map((prompt) => (
          <li key={prompt}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(prompt)}
              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-start text-sm text-zinc-800 hover:border-sky-400 hover:bg-sky-50 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
            >
              {prompt}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
