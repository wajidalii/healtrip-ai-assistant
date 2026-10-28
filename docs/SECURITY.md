# Security and error handling

## Threat model for this prototype

Inputs we do not trust: the browser (any JSON), the model (tool arguments and prose), and provider descriptions once they come from a database that could be edited by staff. Secrets: the model credential (Anthropic API key, AI Gateway key or the deployment's OIDC token) and the database URL. Sensitive data: patient messages (treat as PHI).

## Controls in the prototype

| Area | Control |
| --- | --- |
| Input validation | zod on every HTTP body/query (`src/shared/contracts.ts`) and on every tool input before execution (`src/server/agent/tools.ts`). Enums for specialty/urgency/next_step/red flags, bounded numbers, bounded array and string lengths. Conversation ids must be v4 UUIDs before they reach a query. |
| Model output | Tool arguments are validated (strict JSON schema + zod). Free text is displayed as text only. Provider cards come from DB rows by id; the browser additionally re-validates `recommendation` events with the shared zod schema and drops anything off-contract. |
| Grounding | `recommend_next_step` rejects provider ids not returned by tools in this conversation, and rejects an `emergency_now` / `emergency` mismatch (see AGENT.md). |
| Prompt injection | Tool results are JSON from our own DB, serialised with a fixed shape; user text is only ever placed in `user` turns, never in the system prompt (the static block is never interpolated). The model has no tools that write anything except the recommendation record, and no network tools. |
| Database | Parameterised queries via Drizzle; the model never writes SQL. The search tool exposes a fixed set of filters. Enum columns reject values outside the contracts. |
| Secrets | Server-only env vars parsed once in `src/server/config.ts`, never sent to the client; `.env*` is git-ignored except `.env.example`, which documents shape only. Driver/SDK errors are logged server-side and replaced by generic messages before they reach the model or the browser. |
| Model credentials | Three modes (`docs/DECISIONS.md` ADR-8): `ANTHROPIC_API_KEY`, `AI_GATEWAY_API_KEY`, or no stored key on Vercel where a short-lived OIDC token is fetched per turn and never cached across turns. The resolved profile that reaches logs and `/api/health` holds only `mode` and `model`, never a key or token; a failure to obtain credentials is logged server-side (variable name / cause, not a value) and reaches the client as the generic "not configured" `upstream_error`. |
| Abuse | Per-IP sliding-window rate limit on message posting (`RATE_LIMIT_PER_MINUTE`, default 20); 16 KB body cap checked on `Content-Length` and on actual bytes; `content` ≤ 2000 chars; `AGENT_MAX_STEPS` (default 6, max 10) model calls and `max_tokens: 4096` per step; one in-flight turn per conversation with a 120 s lock TTL. |
| Transport/browser | Security headers on every response (`next.config.ts`): CSP (`default-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`; `script-src 'self' 'unsafe-inline'` because Next's bootstrap and the pre-paint locale script are inline and un-nonced; `'unsafe-eval'` only under `next dev`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` denying camera/microphone/geolocation. Same-origin API; no CORS. |
| Logging | One JSON line per agent step (`agent.step`: conversation id, step, stop reason, tool names, latency, token usage) plus `agent.tool_failed` / `agent.turn_failed` with the error string. **Message text is not logged.** The repository choice is logged once at startup without the URL. |
| Safety | Not-medical-advice line required at the end of every rationale; emergencies instruct to call local emergency services immediately and the UI shows a `role="alert"` banner; the model's server-side safety fallbacks are enabled and `refusal` is handled; the prompt forbids asking for personal identifiers. |

## What production would add

- Authentication (patients own conversations) and authorization checks on every conversation route; conversation ids alone are not an access control.
- Encryption at rest for `messages`, data-retention and deletion workflows, audit logging for staff access (HIPAA/GDPR style obligations).
- Redis-backed rate limiting; WAF/bot protection at the edge. (The turn lock already lives in the database.)
- A nonce-based CSP so `'unsafe-inline'` can be dropped from `script-src`.
- Secrets in a managed vault; rotated keys; separate API keys per environment with spend limits.
- Clinical review of the triage rule table and a release process for changing it.
- Evals in CI against fixed scenarios so a prompt change cannot silently change triage behaviour.

## Error handling model

Errors are typed at each layer and translated once at the boundary:

- `AppError(code, status, message, details?, headers?)` in `src/server/http/errors.ts`, with helpers `badRequest`, `notFound`, `payloadTooLarge`, `rateLimited` (sets `Retry-After`), `conflict` (409 `turn_in_progress`), `upstream`, `internal`. Route handlers catch everything and call `toErrorResponse`: `AppError` → its status and body; `ZodError` → 400 `validation_error` with the first issue as the message and the flattened issues as `details`; anything else → logged and returned as a generic 500 `internal_error` without leaking internals.
- Inside the agent loop, tool failures are **not exceptions**: they are returned to the model as `tool_result` with `is_error: true` and a short human-readable reason, so the model can recover (ask again, widen the search). Only model-call failures abort the turn, emitting an `error` SSE event with `retryable`.
- The SDK's typed errors decide `retryable`: `AuthenticationError` → `upstream_error` not retryable; `RateLimitError`, `APIConnectionError` and 5xx → `upstream_error` retryable (the SDK itself has already retried twice); other 4xx → not retryable; cancellation and unknown throws → `internal_error`.
- Streams always end with exactly one terminal event (`done` or `error`): the SSE writer appends an `error` if the generator ends without one, converts a thrown `AppError` into an `error` event with its safe message, masks unknown throws, and runs `onFinish` (lock release) exactly once — also when the client disconnects, in which case the agent generator is wound down. Heartbeat comments every 15 s keep idle connections open through proxies; they are not events and do not reset the UI's inactivity timer.
- The UI distinguishes "assistant is still thinking", "tool running", "recoverable error (retry button)" and "unrecoverable error (start a new conversation)". It applies a 90 s inactivity timeout measured between decoded SSE events (comment frames such as heartbeats are ignored, so a model step that is silent for 90 s is aborted as retryable), treats an EOF without a terminal event as retryable, and clears a stored conversation id the server no longer knows (404 — e.g. a memory-mode restart).
