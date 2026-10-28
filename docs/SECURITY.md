# Security and error handling

## Threat model for this prototype

Inputs we do not trust: the browser (any JSON), the model (tool arguments and prose), and provider descriptions once they come from a database that could be edited by staff. Secrets: the Anthropic API key and the database URL. Sensitive data: patient messages (treat as PHI).

## Controls in the prototype

| Area | Control |
| --- | --- |
| Input validation | zod on every HTTP body/query and on every tool input before execution. Enums for specialty/urgency/next_step, bounded numbers, bounded array lengths. |
| Model output | Tool arguments are validated (strict JSON schema + zod). Free text is displayed as text only. Provider cards come from DB rows by id. |
| Grounding | `recommend_next_step` rejects provider ids not returned by tools in this conversation (see AGENT.md). |
| Prompt injection | Tool results are JSON from our own DB, serialised with a fixed shape; user text is only ever placed in `user` turns, never in the system prompt. The model has no tools that write anything except the recommendation record, and no network tools. |
| Database | Parameterised queries via Drizzle; the model never writes SQL. The search tool exposes a fixed set of filters. |
| Secrets | Server-only env vars (`src/server/config.ts`), never sent to the client; `.env` is git-ignored; `.env.example` documents shape only. |
| Abuse | Per-IP rate limit on message posting; body size cap; max 6 model steps and bounded `max_tokens` per turn; one in-flight turn per conversation. |
| Transport/browser | Security headers (CSP without `unsafe-eval`, nosniff, frame deny, referrer policy). Same-origin API; no CORS. |
| Logging | Structured logs with conversation id, tool name, latency and token usage. **Message text is not logged.** |
| Safety | Not-medical-advice disclaimer on every recommendation; emergencies instruct to call local emergency services immediately; the model's safety fallbacks are enabled and `refusal` is handled. |

## What production would add

- Authentication (patients own conversations) and authorization checks on every conversation route; conversation ids alone are not an access control.
- Encryption at rest for `messages`, data-retention and deletion workflows, audit logging for staff access (HIPAA/GDPR style obligations).
- Redis-backed rate limiting and turn locking; WAF/bot protection at the edge.
- Secrets in a managed vault; rotated keys; separate API keys per environment with spend limits.
- Clinical review of the triage rule table and a release process for changing it.
- Evals in CI against fixed scenarios so a prompt change cannot silently change triage behaviour.

## Error handling model

Errors are typed at each layer and translated once at the boundary:

- `AppError(code, status, message, details?)` in `src/server/http/errors.ts`. Route handlers catch everything, log, and return the shared error shape; unexpected errors become `internal_error` without leaking internals.
- Inside the agent loop, tool failures are **not exceptions**: they are returned to the model as `tool_result` with `is_error: true` and a short human-readable reason, so the model can recover (ask again, widen the search). Only infrastructure failures (API down after retries, DB unreachable) abort the turn, emitting an `error` SSE event with `retryable`.
- The SDK's typed errors (`RateLimitError`, `APIConnectionError`, `APIError` with status) decide `retryable` and the HTTP status for non-streaming endpoints.
- The UI distinguishes "assistant is still thinking", "tool running", "recoverable error (retry button)" and "unrecoverable error (start new conversation)".
- Streams always end with exactly one terminal event (`done` or `error`), so the client never waits forever; the client also applies a 90s inactivity timeout.
