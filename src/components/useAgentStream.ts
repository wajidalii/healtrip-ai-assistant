"use client";

/**
 * Chat state machine for the streaming agent API (docs/API.md).
 *
 * Responsibilities:
 *  - conversation lifecycle (create on first send, restore from sessionStorage)
 *  - POST a message and fold the SSE `AgentEvent`s into UI messages
 *  - 90s inactivity timeout, cancellation, retry of the last message
 *
 * Provider cards are only ever populated from `recommendation.providers`,
 * which the server hydrates from the database; assistant text is never parsed.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  recommendationSchema,
  type AgentErrorCode,
  type AgentEvent,
  type ApiErrorCode,
  type ConversationView,
  type Locale,
  type Recommendation,
} from "@/shared/contracts";
import { ApiRequestError, createConversation, getConversation, postMessage } from "./api";
import { parseSse } from "./sse";

export const CONVERSATION_STORAGE_KEY = "healtrip.conversationId";
const INACTIVITY_TIMEOUT_MS = 90_000;

export type ToolStatus = "running" | "ok" | "error";
export type ToolActivityItem = { id: string; name: string; status: ToolStatus; summary: string };

export type UiError = {
  code: AgentErrorCode | ApiErrorCode | "network" | "unknown";
  message: string;
  retryable: boolean;
  /** Set when the error was produced client-side rather than by the server. */
  reason?: "timeout" | "network";
};

export type UserMessage = { id: string; role: "user"; text: string };
export type AssistantMessage = {
  id: string;
  role: "assistant";
  text: string;
  toolCalls: ToolActivityItem[];
  recommendation: Recommendation | null;
  error: UiError | null;
  streaming: boolean;
};
export type UiMessage = UserMessage | AssistantMessage;

export type StreamStatus = "idle" | "streaming" | "error";

type State = {
  conversationId: string | null;
  messages: UiMessage[];
  status: StreamStatus;
  lastError: UiError | null;
  hydrating: boolean;
};

type Action =
  | { type: "hydrated"; conversationId: string | null; messages: UiMessage[] }
  | { type: "conversation_created"; conversationId: string }
  | { type: "turn_started"; user: UserMessage | null; assistantId: string; replaceAssistantId: string | null }
  | { type: "text_delta"; assistantId: string; text: string }
  | { type: "tool_call"; assistantId: string; item: ToolActivityItem }
  | { type: "tool_result"; assistantId: string; id: string; ok: boolean; summary: string }
  | { type: "recommendation"; assistantId: string; recommendation: Recommendation }
  | { type: "turn_done"; assistantId: string }
  | { type: "turn_failed"; assistantId: string; error: UiError }
  | { type: "turn_cancelled"; assistantId: string }
  | { type: "forget_conversation" }
  | { type: "reset" };

const initialState: State = {
  conversationId: null,
  messages: [],
  status: "idle",
  lastError: null,
  hydrating: true,
};

function updateAssistant(
  messages: UiMessage[],
  assistantId: string,
  update: (m: AssistantMessage) => AssistantMessage,
): UiMessage[] {
  return messages.map((m) => (m.id === assistantId && m.role === "assistant" ? update(m) : m));
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "hydrated":
      return { ...state, hydrating: false, conversationId: action.conversationId, messages: action.messages };
    case "conversation_created":
      return { ...state, conversationId: action.conversationId };
    case "turn_started": {
      const assistant: AssistantMessage = {
        id: action.assistantId,
        role: "assistant",
        text: "",
        toolCalls: [],
        recommendation: null,
        error: null,
        streaming: true,
      };
      // On retry the failed assistant bubble is replaced; the user bubble stays.
      const kept = state.messages.filter((m) => m.id !== action.replaceAssistantId);
      return {
        ...state,
        status: "streaming",
        lastError: null,
        messages: action.user ? [...kept, action.user, assistant] : [...kept, assistant],
      };
    }
    case "text_delta":
      return {
        ...state,
        messages: updateAssistant(state.messages, action.assistantId, (m) => ({ ...m, text: m.text + action.text })),
      };
    case "tool_call":
      return {
        ...state,
        messages: updateAssistant(state.messages, action.assistantId, (m) => ({
          ...m,
          toolCalls: [...m.toolCalls, action.item],
        })),
      };
    case "tool_result":
      return {
        ...state,
        messages: updateAssistant(state.messages, action.assistantId, (m) => ({
          ...m,
          toolCalls: m.toolCalls.map((t) =>
            t.id === action.id ? { ...t, status: action.ok ? "ok" : "error", summary: action.summary } : t,
          ),
        })),
      };
    case "recommendation":
      return {
        ...state,
        messages: updateAssistant(state.messages, action.assistantId, (m) => ({
          ...m,
          recommendation: action.recommendation,
        })),
      };
    case "turn_done":
      return {
        ...state,
        status: "idle",
        messages: updateAssistant(state.messages, action.assistantId, (m) => ({ ...m, streaming: false })),
      };
    case "turn_failed":
      return {
        ...state,
        status: "error",
        lastError: action.error,
        messages: updateAssistant(state.messages, action.assistantId, (m) => ({
          ...m,
          streaming: false,
          error: action.error,
          // A still-running chip would be misleading once the turn is over.
          toolCalls: m.toolCalls.map((t) => (t.status === "running" ? { ...t, status: "error" } : t)),
        })),
      };
    case "turn_cancelled":
      return {
        ...state,
        status: "idle",
        messages: updateAssistant(state.messages, action.assistantId, (m) => ({
          ...m,
          streaming: false,
          toolCalls: m.toolCalls.map((t) => (t.status === "running" ? { ...t, status: "error" } : t)),
        })),
      };
    case "forget_conversation":
      return { ...state, conversationId: null };
    case "reset":
      return { ...initialState, hydrating: false };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readStoredConversationId(): string | null {
  try {
    return window.sessionStorage.getItem(CONVERSATION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredConversationId(id: string | null): void {
  try {
    if (id === null) window.sessionStorage.removeItem(CONVERSATION_STORAGE_KEY);
    else window.sessionStorage.setItem(CONVERSATION_STORAGE_KEY, id);
  } catch {
    // Storage unavailable: the conversation simply will not survive a reload.
  }
}

function fromConversationView(view: ConversationView): UiMessage[] {
  return view.messages.map((m) =>
    m.role === "user"
      ? { id: newId(), role: "user", text: m.text }
      : {
          id: newId(),
          role: "assistant",
          text: m.text,
          toolCalls: m.toolCalls.map((t) => ({
            id: t.id,
            name: t.name,
            status: t.ok ? "ok" : "error",
            summary: t.summary,
          })),
          recommendation: m.recommendation,
          error: null,
          streaming: false,
        },
  );
}

/** Which HTTP failures are worth a retry without changing the message. */
function errorFromApi(err: ApiRequestError): UiError {
  const retryable: ReadonlyArray<UiError["code"]> = [
    "rate_limited",
    "turn_in_progress",
    "upstream_error",
    "internal_error",
    "unknown",
  ];
  return { code: err.code, message: err.message, retryable: retryable.includes(err.code) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Turns one SSE message into an `AgentEvent`, or null when the payload does
 * not match the contract. The `event:` name wins; `data.type` is a fallback.
 */
function decodeAgentEvent(eventName: string, raw: string): AgentEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const type = eventName !== "message" ? eventName : data.type;
  switch (type) {
    case "conversation":
      return typeof data.conversationId === "string" ? { type, conversationId: data.conversationId } : null;
    case "text_delta":
      return typeof data.text === "string" ? { type, text: data.text } : null;
    case "tool_call":
      return typeof data.id === "string" && typeof data.name === "string"
        ? { type, id: data.id, name: data.name, input: data.input }
        : null;
    case "tool_result":
      return typeof data.id === "string" && typeof data.name === "string" && typeof data.ok === "boolean"
        ? { type, id: data.id, name: data.name, ok: data.ok, summary: typeof data.summary === "string" ? data.summary : "" }
        : null;
    case "recommendation": {
      // The API doc shows the recommendation fields at the top level while the
      // contract nests them under `recommendation`; accept both shapes.
      const parsed = recommendationSchema.safeParse(data.recommendation ?? data);
      return parsed.success ? { type, recommendation: parsed.data } : null;
    }
    case "done": {
      const usage = isRecord(data.usage) ? data.usage : {};
      const num = (v: unknown): number => (typeof v === "number" ? v : 0);
      return {
        type,
        stopReason: typeof data.stopReason === "string" ? data.stopReason : "end_turn",
        usage: {
          inputTokens: num(usage.inputTokens),
          outputTokens: num(usage.outputTokens),
          cacheReadInputTokens: num(usage.cacheReadInputTokens),
        },
      };
    }
    case "error":
      return typeof data.code === "string"
        ? {
            type,
            code: data.code as AgentErrorCode,
            message: typeof data.message === "string" ? data.message : "",
            retryable: data.retryable === true,
          }
        : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type AgentStream = {
  messages: UiMessage[];
  status: StreamStatus;
  lastError: UiError | null;
  hydrating: boolean;
  conversationId: string | null;
  send: (text: string) => Promise<void>;
  retry: () => Promise<void>;
  cancel: () => void;
  reset: () => void;
};

export function useAgentStream(locale: Locale): AgentStream {
  const [state, dispatch] = useReducer(reducer, initialState);
  const controllerRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const lastUserTextRef = useRef<string | null>(null);
  const statusRef = useRef<StreamStatus>("idle");
  const messagesRef = useRef<UiMessage[]>([]);

  // Mirror the latest state into refs so the async `send`/`retry` closures can
  // read fresh values without being recreated on every render.
  useEffect(() => {
    statusRef.current = state.status;
    conversationIdRef.current = state.conversationId;
    messagesRef.current = state.messages;
  }, [state.status, state.conversationId, state.messages]);

  // Restore a conversation from a previous page load in this tab.
  useEffect(() => {
    const stored = readStoredConversationId();
    if (!stored) {
      dispatch({ type: "hydrated", conversationId: null, messages: [] });
      return;
    }
    const ac = new AbortController();
    getConversation(stored, ac.signal)
      .then((view) => {
        const messages = fromConversationView(view);
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        lastUserTextRef.current = lastUser ? lastUser.text : null;
        dispatch({ type: "hydrated", conversationId: view.id, messages });
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        // 404 means the server forgot it (restart / in-memory repo). Any other
        // failure also starts fresh: keeping an id whose history we cannot
        // show would make the server-side context invisible to the user.
        if (!(err instanceof ApiRequestError) || err.status === 404) writeStoredConversationId(null);
        dispatch({ type: "hydrated", conversationId: null, messages: [] });
      });
    return () => ac.abort();
  }, []);

  // Abort any in-flight stream when the component unmounts.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const runTurn = useCallback(
    async (text: string, user: UserMessage | null, replaceAssistantId: string | null) => {
      const assistantId = newId();
      const controller = new AbortController();
      controllerRef.current = controller;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const armTimer = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, INACTIVITY_TIMEOUT_MS);
      };

      dispatch({ type: "turn_started", user, assistantId, replaceAssistantId });
      lastUserTextRef.current = text;

      try {
        let conversationId = conversationIdRef.current;
        if (!conversationId) {
          conversationId = await createConversation(locale, controller.signal);
          conversationIdRef.current = conversationId;
          writeStoredConversationId(conversationId);
          dispatch({ type: "conversation_created", conversationId });
        }

        armTimer();
        const body = await postMessage(conversationId, text, locale, controller.signal);
        let terminal = false;
        for await (const msg of parseSse(body, controller.signal)) {
          armTimer();
          const event = decodeAgentEvent(msg.event, msg.data);
          if (!event) {
            // Our own server sent something off-contract; surface it for debugging
            // instead of failing the whole turn.
            console.warn("[useAgentStream] ignoring malformed event", msg.event, msg.data);
            continue;
          }
          switch (event.type) {
            case "conversation":
              break;
            case "text_delta":
              dispatch({ type: "text_delta", assistantId, text: event.text });
              break;
            case "tool_call":
              dispatch({
                type: "tool_call",
                assistantId,
                item: { id: event.id, name: event.name, status: "running", summary: "" },
              });
              break;
            case "tool_result":
              dispatch({ type: "tool_result", assistantId, id: event.id, ok: event.ok, summary: event.summary });
              break;
            case "recommendation":
              dispatch({ type: "recommendation", assistantId, recommendation: event.recommendation });
              break;
            case "done":
              terminal = true;
              dispatch({ type: "turn_done", assistantId });
              break;
            case "error":
              terminal = true;
              dispatch({
                type: "turn_failed",
                assistantId,
                error: { code: event.code, message: event.message, retryable: event.retryable },
              });
              break;
          }
          if (terminal) break;
        }
        if (!terminal && !controller.signal.aborted) {
          // The server promises exactly one terminal event; a bare EOF means
          // the connection dropped mid-turn.
          dispatch({
            type: "turn_failed",
            assistantId,
            error: { code: "internal_error", message: "Stream ended unexpectedly", retryable: true },
          });
        }
      } catch (err: unknown) {
        if (timedOut) {
          dispatch({
            type: "turn_failed",
            assistantId,
            error: { code: "internal_error", message: "Inactivity timeout", retryable: true, reason: "timeout" },
          });
        } else if (controller.signal.aborted) {
          dispatch({ type: "turn_cancelled", assistantId });
        } else if (err instanceof ApiRequestError) {
          if (err.status === 404) {
            // The conversation vanished server-side; the next send creates a new one.
            writeStoredConversationId(null);
            conversationIdRef.current = null;
            dispatch({ type: "forget_conversation" });
          }
          dispatch({ type: "turn_failed", assistantId, error: errorFromApi(err) });
        } else {
          dispatch({
            type: "turn_failed",
            assistantId,
            error: { code: "network", message: "Network error", retryable: true, reason: "network" },
          });
        }
      } finally {
        if (timer) clearTimeout(timer);
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    [locale],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || statusRef.current === "streaming") return;
      await runTurn(trimmed, { id: newId(), role: "user", text: trimmed }, null);
    },
    [runTurn],
  );

  const retry = useCallback(async () => {
    const text = lastUserTextRef.current;
    if (!text || statusRef.current === "streaming") return;
    const failed = [...messagesRef.current].reverse().find((m) => m.role === "assistant" && m.error !== null);
    await runTurn(text, null, failed ? failed.id : null);
  }, [runTurn]);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    conversationIdRef.current = null;
    lastUserTextRef.current = null;
    writeStoredConversationId(null);
    dispatch({ type: "reset" });
  }, []);

  return {
    messages: state.messages,
    status: state.status,
    lastError: state.lastError,
    hydrating: state.hydrating,
    conversationId: state.conversationId,
    send,
    retry,
    cancel,
    reset,
  };
}
