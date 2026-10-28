"use client";

import { useEffect, useRef } from "react";
import { useLocale } from "@/i18n/locale";
import { Composer } from "./Composer";
import { EmergencyBanner } from "./EmergencyBanner";
import { LocaleToggle } from "./LocaleToggle";
import { MessageBubble } from "./MessageBubble";
import { SamplePrompts } from "./SamplePrompts";
import { useAgentStream } from "./useAgentStream";

/** Top-level chat screen: header, message list, emergency banner, composer and disclaimer. */
export function ChatWindow() {
  const { locale, t } = useLocale();
  const { messages, status, hydrating, send, retry, cancel, reset } = useAgentStream(locale);
  const listRef = useRef<HTMLDivElement>(null);
  const streaming = status === "streaming";

  // Keep the newest content in view while the assistant streams.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // The banner follows the most recent recommendation only: an earlier emergency
  // that was later downgraded (after clarification) should not keep shouting.
  const latestRecommendation = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.recommendation !== null);
  const showEmergency =
    latestRecommendation?.role === "assistant" && latestRecommendation.recommendation?.urgency === "emergency";

  return (
    <div className="flex min-h-full flex-1 flex-col bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold text-zinc-900">{t.title}</h1>
            <p className="text-xs text-zinc-600">{t.subtitle}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={hydrating || messages.length === 0}
              className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
            >
              {t.newConversation}
            </button>
            <LocaleToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4">
        {showEmergency ? (
          <div className="pt-4">
            <EmergencyBanner />
          </div>
        ) : null}

        <div
          ref={listRef}
          role="log"
          aria-label={t.messagesRegion}
          className="flex flex-1 flex-col gap-4 overflow-y-auto py-6"
        >
          {!hydrating && messages.length === 0 ? (
            <div className="my-auto">
              <SamplePrompts onPick={(text) => void send(text)} disabled={streaming} />
            </div>
          ) : null}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} onRetry={() => void retry()} />
          ))}
        </div>

        <div className="sticky bottom-0 border-t border-zinc-200 bg-zinc-50 py-3">
          <Composer onSend={(text) => void send(text)} onCancel={cancel} streaming={streaming} />
          <p className="mt-2 text-center text-xs text-zinc-500">{t.disclaimer}</p>
        </div>
      </main>
    </div>
  );
}
