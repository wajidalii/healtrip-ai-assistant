import { postMessageSchema, type AgentEvent, type Locale } from "@/shared/contracts";
import { runTurn } from "@/server/agent/run-turn";
import { conflict, notFound, rateLimited } from "@/server/http/errors";
import { routeErrorResponse } from "@/app/api/_lib/route-error";
import { getClientIp } from "@/server/http/rate-limit";
import { getAgentDeps, getMessageRateLimiter, parseConversationId, parseWith, readJson } from "@/server/http/request";
import { createSseResponse } from "@/server/http/sse";
import { getRepositories } from "@/server/repositories";

type Context = { params: Promise<{ id: string }> };

/** Upper bound on one turn; the lock also expires if the process dies mid-turn. */
const TURN_LOCK_TTL_MS = 120_000;

/**
 * The `conversation` event goes out first so the UI can store the id before
 * any text arrives. Dependencies are resolved inside the generator so a
 * misconfigured server (no API key) surfaces as a terminal `error` event in
 * the same stream instead of a bare 5xx.
 */
async function* turnEvents(
  conversationId: string,
  userText: string,
  locale: Locale,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
  yield { type: "conversation", conversationId };
  const deps = getAgentDeps();
  yield* runTurn({ conversationId, userText, locale, deps: { ...deps, signal } });
}

export async function POST(request: Request, { params }: Context): Promise<Response> {
  try {
    const id = parseConversationId((await params).id);
    const body = parseWith(postMessageSchema, await readJson(request));

    const { conversations } = getRepositories();
    if (!(await conversations.get(id))) throw notFound("Conversation not found");

    const limit = getMessageRateLimiter().check(getClientIp(request));
    if (!limit.allowed) throw rateLimited(limit.retryAfterMs / 1000);

    if (!(await conversations.tryAcquireTurnLock(id, TURN_LOCK_TTL_MS))) throw conflict();

    return createSseResponse(turnEvents(id, body.content, body.locale, request.signal), {
      signal: request.signal,
      onFinish: () => conversations.releaseTurnLock(id),
    });
  } catch (err) {
    return routeErrorResponse(err);
  }
}
