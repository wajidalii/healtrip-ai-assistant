"use client";

import { useCallback, useEffect, useRef } from "react";
import { useLocale } from "@/i18n/locale";
import { Composer } from "./Composer";
import { EmergencyBanner } from "./EmergencyBanner";
import { LocaleToggle } from "./LocaleToggle";
import { MessageBubble } from "./MessageBubble";
import { SamplePrompts } from "./SamplePrompts";
import { showEmergencyBanner, useAgentStream } from "./useAgentStream";

/** How close (px) to the bottom the reader must be for new content to pull the list down. */
const STICK_TO_BOTTOM_PX = 80;

/** Top-level chat screen: header, message list, emergency banner, composer and disclaimer. */
export function ChatWindow() {
  const { locale, t } = useLocale();
  const { messages, status, hydrating, hydrationError, conversationLost, send, retry, retryHydration, cancel, reset } =
    useAgentStream(locale);
  const listRef = useRef<HTMLDivElement>(null);
  // True while the reader is at (or near) the bottom; a reader who scrolled up
  // to re-read an earlier answer is not yanked down on every streamed delta.
  const stickToBottomRef = useRef(true);
  const streaming = status === "streaming";

  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_PX;
  };

  // Keep the newest content in view while the assistant streams. The list is
  // the real scroll container (bounded by the h-full / min-h-0 chain from
  // <body> down), so assigning scrollTop actually scrolls it.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Raised by the rule engine's latest triage verdict (the assess_urgency
  // tool_result, before any recommendation exists) with the saved recommendation
  // as fallback; a later triage that comes back non-emergency takes it down.
  const showEmergency = showEmergencyBanner(messages);

  const onRetry = useCallback(() => void retry(), [retry]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-50">
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
              disabled={hydrating || (messages.length === 0 && !hydrationError)}
              className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
            >
              {t.newConversation}
            </button>
            <LocaleToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full min-h-0 max-w-3xl flex-1 flex-col px-4">
        {showEmergency ? (
          <div className="pt-4">
            <EmergencyBanner />
          </div>
        ) : null}

        {hydrationError ? (
          <div role="alert" className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            <p>{t.errors.conversationLoad}</p>
            <button
              type="button"
              onClick={() => void retryHydration()}
              className="shrink-0 rounded-md bg-red-700 px-3 py-1 text-xs font-medium text-white hover:bg-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
            >
              {t.retry}
            </button>
          </div>
        ) : null}

        <div
          ref={listRef}
          onScroll={onListScroll}
          role="log"
          aria-label={t.messagesRegion}
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-6"
        >
          {!hydrating && messages.length === 0 ? (
            <div className="my-auto">
              <SamplePrompts onPick={(text) => void send(text)} disabled={streaming} />
            </div>
          ) : null}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} onRetry={onRetry} onReset={reset} />
          ))}
        </div>

        <div className="border-t border-zinc-200 bg-zinc-50 py-3">
          <Composer
            onSend={(text) => void send(text)}
            onCancel={cancel}
            streaming={streaming}
            disabled={conversationLost}
          />
          <p className="mt-2 text-center text-xs text-zinc-500">{t.disclaimer}</p>
        </div>
      </main>
    </div>
  );
}
