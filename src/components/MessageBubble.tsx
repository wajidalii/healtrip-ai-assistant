"use client";

import { memo } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import { useLocale } from "@/i18n/locale";
import { RecommendationCard } from "./RecommendationCard";
import { ToolActivity } from "./ToolActivity";
import type { UiError, UiMessage } from "./useAgentStream";

/** Localised text for an error; falls back to the server's message for codes we do not translate. */
export function describeError(error: UiError, t: Dictionary): string {
  if (error.reason === "timeout") return t.errors.timeout;
  if (error.reason === "network") return t.errors.network;
  switch (error.code) {
    case "rate_limited":
      return t.errors.rateLimited;
    case "turn_in_progress":
      return t.errors.turnInProgress;
    case "not_found":
      return t.errors.notFound;
    case "validation_error":
      return t.errors.validation;
    case "payload_too_large":
      return t.errors.payloadTooLarge;
    case "step_limit":
      return t.errors.stepLimit;
    case "max_tokens":
      return t.errors.maxTokens;
    case "refusal":
      return t.errors.refusal;
    case "upstream_error":
      // Non-retryable upstream failures are configuration/credential problems
      // (docs/SECURITY.md), not blips: do not promise that "try again" helps.
      return error.retryable ? t.errors.upstream : t.errors.upstreamUnavailable;
    default:
      return error.message || t.errors.generic;
  }
}

/**
 * Only a conversation the server no longer knows truly ends the thread. Every
 * other non-retryable error (step limit, cut-off answer, refusal, validation)
 * is recovered by sending a different message, which the code-specific copy
 * already says; appending "start a new conversation" would contradict it.
 */
export function endsConversation(error: UiError): boolean {
  return error.code === "not_found";
}

type Props = {
  message: UiMessage;
  onRetry: () => void;
  onReset: () => void;
};

/**
 * Memoised: every `text_delta` produces a new `messages` array but keeps the
 * object identity of untouched entries, so earlier bubbles (and their provider
 * grids) skip re-rendering per token.
 */
export const MessageBubble = memo(function MessageBubble({ message, onRetry, onReset }: Props) {
  const { t } = useLocale();

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-ee-sm bg-sky-600 px-4 py-2.5 text-sm text-white">
          <span className="sr-only">{t.you}: </span>
          {/* `dir="auto"`: the patient may write in either language regardless of the UI locale. */}
          <p className="whitespace-pre-wrap text-start" dir="auto">
            {message.text}
          </p>
        </div>
      </div>
    );
  }

  const isEmpty = message.text === "" && message.toolCalls.length === 0 && !message.recommendation;
  return (
    <div className="flex justify-start">
      {/* No aria-live here: the enclosing role="log" is already a polite live region;
          a second one would announce every streamed delta twice. */}
      <div
        className="flex max-w-[92%] flex-col gap-3 rounded-2xl rounded-es-sm border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900"
        aria-busy={message.streaming}
      >
        <span className="sr-only">{t.assistant}: </span>
        <ToolActivity items={message.toolCalls} />
        {message.text ? (
          <p className="whitespace-pre-wrap text-start" dir="auto">
            {message.text}
          </p>
        ) : null}
        {message.streaming && isEmpty ? (
          <p className="text-zinc-500">
            <span className="inline-block animate-pulse">{t.thinking}</span>
          </p>
        ) : null}
        {message.recommendation ? <RecommendationCard recommendation={message.recommendation} /> : null}
        {message.error ? (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            <p>{describeError(message.error, t)}</p>
            {message.error.retryable ? (
              <button
                type="button"
                onClick={onRetry}
                className="mt-2 rounded-md bg-red-700 px-3 py-1 text-xs font-medium text-white hover:bg-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
              >
                {t.retry}
              </button>
            ) : endsConversation(message.error) ? (
              <>
                <p className="mt-1 text-xs">{t.startNewHint}</p>
                <button
                  type="button"
                  onClick={onReset}
                  className="mt-2 rounded-md bg-red-700 px-3 py-1 text-xs font-medium text-white hover:bg-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
                >
                  {t.newConversation}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});
