/**
 * Request parsing helpers and lazily-built dependencies shared by the route
 * handlers. Framework-free: works on the web `Request` so the same code runs
 * under Next.js, Hono or tests.
 */
import type { z } from "zod";
import { providerSearchSchema, type ProviderSearch } from "@/shared/contracts";
import { getConfig } from "@/server/config";
import {
  createClaudeClientForMode,
  resolveProviderProfile,
  type ClaudeClient,
  type ProviderProfile,
} from "@/server/agent/claude";
import type { RunTurnInput } from "@/server/agent/run-turn";
import { getRepositories } from "@/server/repositories";
import { badRequest, notFound, payloadTooLarge, upstream } from "@/server/http/errors";
import { SlidingWindowRateLimiter } from "@/server/http/rate-limit";

export const MAX_JSON_BODY_BYTES = 16 * 1024;

/** Conversation ids are generated server-side as v4 UUIDs (docs/API.md); nothing else can exist. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Reads and parses a JSON body, enforcing the size cap both on the declared
 * `Content-Length` (cheap early reject) and on the bytes actually received
 * (the header can lie or be absent with chunked encoding).
 */
export async function readJson(request: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw payloadTooLarge(maxBytes);

  const reader = request.body?.getReader();
  if (!reader) throw badRequest("Request body must be JSON.");

  const chunks: Uint8Array[] = [];
  let received = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    received += next.value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw payloadTooLarge(maxBytes);
    }
    chunks.push(next.value);
  }
  if (received === 0) throw badRequest("Request body must be JSON.");

  const text = new TextDecoder().decode(concat(chunks, received));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Thin wrapper so handlers read uniformly; a `ZodError` is mapped by `toErrorResponse`. */
export function parseWith<T>(schema: z.ZodType<T>, data: unknown): T {
  return schema.parse(data);
}

/** Malformed ids are reported as 404: the resource cannot exist and Postgres would reject the cast. */
export function parseConversationId(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!UUID_RE.test(id)) throw notFound("Conversation not found");
  return id;
}

/** `?emergencyCapable=true` style flags; unknown spellings are left for zod to report. */
function queryBoolean(raw: string | null): boolean | string | undefined {
  if (raw === null) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

function queryNumber(raw: string | null): number | string | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) ? n : raw;
}

/** Same filters the agent's `search_providers` tool accepts (docs/API.md GET /api/providers). */
export function parseProviderSearchQuery(params: URLSearchParams): ProviderSearch {
  return providerSearchSchema.parse({
    specialty: params.get("specialty") ?? undefined,
    city: params.get("city") ?? undefined,
    country: params.get("country") ?? undefined,
    language: params.get("language") ?? undefined,
    emergencyCapable: queryBoolean(params.get("emergencyCapable")),
    telemedicine: queryBoolean(params.get("telemedicine")),
    limit: queryNumber(params.get("limit")),
  });
}

export type AgentDeps = Omit<RunTurnInput["deps"], "signal">;

let providerProfile: ProviderProfile | undefined;

/** The provider mode for this process, resolved once from the environment (no credential inside). */
export function getProviderProfile(): ProviderProfile {
  providerProfile ??= resolveProviderProfile(getConfig());
  return providerProfile;
}

/** Cached only for the key modes; an OIDC client carries a short-lived token and is built per turn. */
let cachedClient: ClaudeClient | undefined;

async function getClaudeClientForProfile(profile: ProviderProfile): Promise<ClaudeClient> {
  if (profile.mode === "gateway-oidc") return createClaudeClientForMode(profile.mode);
  cachedClient ??= await createClaudeClientForMode(profile.mode);
  return cachedClient;
}

let loggedProvider = false;

/**
 * Dependencies for `runTurn`. The model client is created on first use so
 * that every other endpoint (and the whole UI) works without credentials.
 * Async because the OIDC mode resolves a token per turn.
 */
export async function getAgentDeps(): Promise<AgentDeps> {
  const config = getConfig();
  const profile = getProviderProfile();
  if (profile.mode === "unconfigured") {
    // The variable names are operator information; the client only learns that the feature is off.
    console.error("[agent] no model credentials (ANTHROPIC_API_KEY, AI_GATEWAY_API_KEY or Vercel OIDC); refusing to run the assistant");
    throw upstream("The AI assistant is not configured on this server.");
  }
  if (!loggedProvider) {
    loggedProvider = true;
    console.info(JSON.stringify({ event: "agent.provider", mode: profile.mode, model: profile.model }));
  }
  let client: ClaudeClient;
  try {
    client = await getClaudeClientForProfile(profile);
  } catch (err) {
    // ConfigError messages name env vars / token sources, never a token value; keep them server-side.
    console.error(`[agent] could not create the model client (${profile.mode}): ${String(err)}`);
    throw upstream("The AI assistant is not configured on this server.");
  }
  return {
    repos: getRepositories(),
    client,
    model: profile.model,
    effort: config.claudeEffort,
    maxSteps: config.agentMaxSteps,
    useServerFallbacks: profile.useServerFallbacks,
  };
}

let messageLimiter: SlidingWindowRateLimiter | undefined;

/** Per-IP limiter for POST /api/conversations/:id/messages (RATE_LIMIT_PER_MINUTE per 60s). */
export function getMessageRateLimiter(): SlidingWindowRateLimiter {
  messageLimiter ??= new SlidingWindowRateLimiter(getConfig().rateLimitPerMinute, 60_000);
  return messageLimiter;
}

/** Conversations one IP may create per minute: a chat needs one; this only bounds storage growth. */
export const CONVERSATIONS_PER_MINUTE = 10;

let conversationLimiter: SlidingWindowRateLimiter | undefined;

/** Per-IP limiter for POST /api/conversations (separate window from message posting). */
export function getConversationRateLimiter(): SlidingWindowRateLimiter {
  conversationLimiter ??= new SlidingWindowRateLimiter(CONVERSATIONS_PER_MINUTE, 60_000);
  return conversationLimiter;
}

/** Per model call the lock may need: a high-effort step with thinking can run well over a minute. */
const TURN_LOCK_MS_PER_STEP = 60_000;

/**
 * Turn-lock TTL derived from the step budget, so a legitimately long turn
 * cannot outlive its own lock and let a second turn interleave; the lock is
 * released in the stream's `finally`, the TTL only frees it after a crash.
 */
export function getTurnLockTtlMs(): number {
  return getConfig().agentMaxSteps * TURN_LOCK_MS_PER_STEP;
}
