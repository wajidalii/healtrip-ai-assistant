/**
 * Thin client for the HTTP API described in docs/API.md. Every non-2xx response
 * is turned into an `ApiRequestError` carrying the server's error code so the
 * UI can decide whether a retry makes sense.
 */
import type { ApiErrorBody, ApiErrorCode, ConversationView, Locale } from "@/shared/contracts";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | "unknown",
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json" };

async function toApiError(res: Response): Promise<ApiRequestError> {
  let body: Partial<ApiErrorBody> | null = null;
  try {
    body = (await res.json()) as Partial<ApiErrorBody>;
  } catch {
    // Non-JSON error page (e.g. a proxy); fall back to status text.
  }
  const code = body?.error?.code ?? "unknown";
  const message = body?.error?.message ?? res.statusText ?? "Request failed";
  return new ApiRequestError(res.status, code, message);
}

export async function createConversation(locale: Locale, signal?: AbortSignal): Promise<string> {
  const res = await fetch("/api/conversations", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ locale }),
    signal,
  });
  if (!res.ok) throw await toApiError(res);
  const data = (await res.json()) as { id: string };
  return data.id;
}

export async function getConversation(id: string, signal?: AbortSignal): Promise<ConversationView> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as ConversationView;
}

/** Returns the raw SSE body; the caller parses it with `parseSse`. */
export async function postMessage(
  id: string,
  content: string,
  locale: Locale,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ content, locale }),
    signal,
  });
  if (!res.ok) throw await toApiError(res);
  if (!res.body) throw new ApiRequestError(res.status, "unknown", "Empty response body");
  return res.body;
}
