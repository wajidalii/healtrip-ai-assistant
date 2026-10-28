"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { useLocale } from "@/i18n/locale";

export const MAX_MESSAGE_CHARS = 2000;

type Props = {
  onSend: (text: string) => void;
  onCancel: () => void;
  streaming: boolean;
};

/** Textarea with Enter-to-send, Shift+Enter newline, and a hard 2000-char cap matching the API. */
export function Composer({ onSend, onCancel, streaming }: Props) {
  const { t } = useLocale();
  const [text, setText] = useState("");
  const id = useId();
  const trimmed = text.trim();
  const canSend = !streaming && trimmed.length > 0 && trimmed.length <= MAX_MESSAGE_CHARS;

  const submit = () => {
    if (!canSend) return;
    onSend(trimmed);
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition (e.g. Arabic/Japanese input methods) also fires Enter; do not send mid-composition.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-col gap-2"
    >
      <label htmlFor={id} className="sr-only">
        {t.composerLabel}
      </label>
      <textarea
        id={id}
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, MAX_MESSAGE_CHARS))}
        onKeyDown={onKeyDown}
        disabled={streaming}
        placeholder={t.placeholder}
        rows={3}
        maxLength={MAX_MESSAGE_CHARS}
        className="w-full resize-y rounded-lg border border-zinc-300 bg-white p-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-200 disabled:bg-zinc-100"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-zinc-500" aria-live="polite">
          {t.charCount(text.length, MAX_MESSAGE_CHARS)}
        </span>
        <div className="flex gap-2">
          {streaming ? (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
            >
              {t.cancel}
            </button>
          ) : null}
          <button
            type="submit"
            disabled={!canSend}
            className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-zinc-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
          >
            {t.send}
          </button>
        </div>
      </div>
    </form>
  );
}
