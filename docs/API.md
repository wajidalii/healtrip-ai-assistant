# HTTP API

All endpoints are JSON unless noted. Errors use one shape (`ApiErrorBody` in `src/shared/contracts.ts`):

```json
{ "error": { "code": "validation_error", "message": "content: Too big: expected string to have <=2000 characters", "details": { "formErrors": [], "fieldErrors": { "content": ["…"] } } } }
```

`details` is optional: for zod failures it is the flattened issue list; for `429` it is `{ retryAfterSeconds }`; for `413` it is `{ maxBytes }`.

| Code | Status | When |
| --- | --- | --- |
| `validation_error` | 400 | Body/query failed zod, invalid or empty JSON |
| `not_found` | 404 | Unknown conversation, or an id that is not a v4 UUID (reported as 404 so Postgres never sees a bad cast and ids cannot be probed) |
| `payload_too_large` | 413 | Body over 16 KB (declared `Content-Length` or actual bytes) |
| `rate_limited` | 429 | Per-IP message limit; `Retry-After` header set |
| `turn_in_progress` | 409 | Another turn is running for this conversation |
| `upstream_error` | 502 | Reserved for AI-service failures outside a stream (inside a stream they are `error` events) |
| `internal_error` | 500 | Anything unexpected; message is generic, details are logged server-side only |

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness + which repository/model are active |
| GET | `/api/providers` | Provider search (same query as the agent tool) |
| POST | `/api/conversations` | Create a conversation |
| GET | `/api/conversations/:id` | UI projection of a conversation |
| POST | `/api/conversations/:id/messages` | Send a message; responds with an SSE stream |

Route handlers live in `src/app/api/**/route.ts` and are thin: parse → call `src/server` → encode. Every handler wraps its body in `try/catch` → `toErrorResponse` (`src/server/http/errors.ts`).

## GET /api/health

```json
{ "ok": true, "repository": "memory" | "postgres", "model": "claude-opus-5-5", "version": "0.1.0" }
```

## GET /api/providers

Query: `specialty` (required, enum), `city` (case-insensitive), `country` (ISO-3166 alpha-2, upper-cased), `language` (enum), `emergencyCapable` (`true|false`), `telemedicine` (`true|false`), `limit` (1–20, default 10). Only active providers are returned, ordered by rating desc, name asc; `total` counts all matches regardless of `limit`.

```json
{ "results": [ { "id": "…", "kind": "hospital", "nameEn": "…", "nameAr": "…", "specialties": ["cardiology"], "city": "Istanbul", "country": "TR", "languages": ["en","ar","tr"], "emergencyCapable": true, "telemedicine": false, "acceptsInternational": true, "rating": 4.6, "priceTier": "mid" } ], "total": 1 }
```

## POST /api/conversations

Body: `{ "locale": "en" | "ar" }` (a JSON body is required; `{}` defaults to `en`) → `201 { "id": "<uuid>", "locale": "en" }`.

## GET /api/conversations/:id

One assistant entry per agent turn: all text the model wrote between two patient messages is merged, tool-result plumbing is hidden, and the recommendation is attached from the `recommendations` table (matched by the `recommendation_id` in the tool output).

```json
{ "id": "…", "locale": "en", "messages": [
  { "role": "user", "text": "…" },
  { "role": "assistant", "text": "…",
    "toolCalls": [ { "id": "toolu_01…", "name": "assess_urgency", "ok": true, "summary": "urgent" } ],
    "recommendation": { "id": "…", "nextStep": "specialist_consultation", "urgency": "urgent", "specialty": "cardiology", "rationale": "…", "providers": [ { "…": "ProviderSummary" } ], "questionsRemaining": [], "createdAt": "2026-…" } }
] }
```

`recommendation` is `null` for turns that ended in a question or an error.

## POST /api/conversations/:id/messages  (SSE)

Body: `{ "content": "I have chest pain…", "locale": "en" }` (`content` 1–2000 chars after trimming; `locale` defaults to `en`).

Checks, in order: id format (404) → body (400/413) → conversation exists (404) → rate limit (429) → turn lock (409). Then the response is `200 text/event-stream; charset=utf-8` (`Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`).

Each frame is `event: <type>` + `data: <the whole AgentEvent as JSON>`; types and payloads are the `AgentEvent` union in `src/shared/contracts.ts`. The `conversation` event is always first. A `: heartbeat` comment is sent every 15 s of silence so proxies and the browser's 90 s inactivity timeout do not drop a long tool call.

```
event: conversation
data: {"type":"conversation","conversationId":"…"}

event: text_delta
data: {"type":"text_delta","text":"Thanks — a couple of quick questions"}

event: tool_call
data: {"type":"tool_call","id":"toolu_01…","name":"assess_urgency","input":{"symptoms":["chest pain"],"red_flags":["shortness_of_breath"]}}

event: tool_result
data: {"type":"tool_result","id":"toolu_01…","name":"assess_urgency","ok":true,"summary":"emergency - call emergency services"}

event: recommendation
data: {"type":"recommendation","recommendation":{"id":"…","nextStep":"emergency_now","urgency":"emergency","specialty":"cardiology","rationale":"…","providers":[{…}],"questionsRemaining":[],"createdAt":"…"}}

event: done
data: {"type":"done","stopReason":"end_turn","usage":{"inputTokens":1234,"outputTokens":210,"cacheReadInputTokens":1100}}
```

Exactly one terminal event ends every stream: `done`, or `error` with `code` ∈ {`step_limit`, `max_tokens`, `refusal`, `upstream_error`, `internal_error`} and `retryable`. A server without `ANTHROPIC_API_KEY` still answers `200` and emits `conversation` then a terminal `error` (`upstream_error`, not retryable), so the UI handles it like any other failure. If the stream is interrupted without a terminal event the UI treats it as a retryable error.

The user message is persisted before the model is called. A turn that fails after that point leaves the message in history, and the UI's **Retry** re-sends the same text, so the stored history can contain it twice (the UI shows one bubble). Acceptable for the prototype; production would make the retry idempotent.

Concurrency: one in-flight turn per conversation, enforced by `tryAcquireTurnLock` (a timestamp on the conversation row, 120 s TTL as a crash backstop). A second POST while a turn is running returns `409 { "error": { "code": "turn_in_progress", … } }`. The lock is released in the stream's `finally`, including when the client disconnects (the agent generator is wound down).

## Limits and protections

- Body ≤ 16 KB, `content` ≤ 2000 chars, `limit` ≤ 20.
- Rate limit: `RATE_LIMIT_PER_MINUTE` (default 20) messages / minute / IP, sliding window, in memory (swap for Redis in production). The IP is the first `x-forwarded-for` entry, then `x-real-ip`, else `"unknown"`.
- Security headers set in `next.config.ts` (CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`).
- No authentication in the prototype; conversation ids are v4 UUIDs (unguessable, not a substitute for auth — see SECURITY.md).
