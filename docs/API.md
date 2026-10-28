# HTTP API

All endpoints are JSON unless noted. Errors use one shape:

```json
{ "error": { "code": "validation_error", "message": "content must be 1–2000 characters", "details": [] } }
```

Codes: `validation_error` (400), `not_found` (404), `rate_limited` (429), `payload_too_large` (413), `upstream_error` (502), `internal_error` (500).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness + which repository/model are active |
| GET | `/api/providers` | Provider search (same query as the agent tool) |
| POST | `/api/conversations` | Create a conversation |
| GET | `/api/conversations/:id` | UI projection of a conversation |
| POST | `/api/conversations/:id/messages` | Send a message; responds with an SSE stream |

## GET /api/health

```json
{ "ok": true, "repository": "memory" | "postgres", "model": "claude-opus-5-5", "version": "0.1.0" }
```

## GET /api/providers

Query: `specialty` (required, enum), `city`, `country`, `language`, `emergencyCapable` (`true|false`), `telemedicine`, `limit` (1–20, default 10).

```json
{ "results": [ { "id": "…", "kind": "hospital", "nameEn": "…", "nameAr": "…", "specialties": ["cardiology"], "city": "Istanbul", "country": "TR", "languages": ["en","ar","tr"], "emergencyCapable": true, "telemedicine": false, "rating": 4.6, "priceTier": "mid" } ], "total": 1 }
```

## POST /api/conversations

Body: `{ "locale": "en" | "ar" }` → `201 { "id": "<uuid>", "locale": "en" }`.

## GET /api/conversations/:id

```json
{ "id": "…", "locale": "en", "messages": [ { "role": "user", "text": "…" }, { "role": "assistant", "text": "…", "toolCalls": [ { "name": "assess_urgency", "ok": true, "summary": "urgent" } ], "recommendation": { … } } ] }
```

## POST /api/conversations/:id/messages  (SSE)

Body: `{ "content": "I have chest pain…", "locale": "en" }` (`content` 1–2000 chars).
Response: `200 text/event-stream`. Events are `AgentEvent`s from `src/shared/contracts.ts`:

```
event: text_delta
data: {"text":"Thanks — a couple of quick questions"}

event: tool_call
data: {"id":"toolu_01…","name":"assess_urgency","input":{"symptoms":["chest pain"],"red_flags":["shortness_of_breath"]}}

event: tool_result
data: {"id":"toolu_01…","name":"assess_urgency","ok":true,"summary":"emergency"}

event: recommendation
data: {"nextStep":"emergency_now","urgency":"emergency","rationale":"…","providers":[{…}],"questionsRemaining":[]}

event: done
data: {"stopReason":"end_turn","usage":{"inputTokens":1234,"outputTokens":210,"cacheReadInputTokens":1100}}
```

An `error` event ends the stream: `{"code":"step_limit","message":"…","retryable":false}`.

Concurrency: one in-flight turn per conversation. A second POST while a turn is running returns `409 { code: "turn_in_progress" }`.

## Limits and protections

- Body ≤ 16 KB, `content` ≤ 2000 chars, `limit` ≤ 20.
- Rate limit: 20 messages / minute / IP (in-memory; swap for Redis in production).
- Security headers set in `next.config.ts` (CSP, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`).
- No authentication in the prototype; conversation ids are v4 UUIDs (unguessable, not a substitute for auth — see SECURITY.md).
