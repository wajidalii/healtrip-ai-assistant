# Agent design

## Role

The agent is a **triage-and-routing assistant**, not a diagnostician. Its job per conversation:

1. Understand the patient's situation (symptom, duration, severity, red flags, location, language, constraints).
2. Ask **clarifying questions** when the next step genuinely depends on missing information — at most two at a time, none when the case is already an emergency.
3. Determine urgency with the deterministic `assess_urgency` tool (never by itself).
4. Find matching providers with `search_providers` / `get_provider_details`.
5. Produce the final answer **only** through `recommend_next_step`, which the server validates and stores.

The full prompt is `STATIC_SYSTEM_PROMPT` in `src/server/agent/prompt.ts`; the loop is `src/server/agent/run-turn.ts`.

## Model and request shape

- Model: `claude-opus-5-5` (configurable via `CLAUDE_MODEL`). Thinking is always on for this model; we control latency/cost with `output_config.effort` (`CLAUDE_EFFORT`, default `low`). `max_tokens` is 4096 per step; thinking counts toward it, which is enough for a question or a tool call.
- Streaming (`client.beta.messages.stream`) so text reaches the UI as it is generated; `finalMessage()` gives us `stop_reason` and the content blocks.
- `betas: ["server-side-fallback-2026-07-01"]` + `fallbacks: "default"` so a safety-classifier decline is re-run on Anthropic's recommended fallback model instead of producing an empty reply. We still handle `stop_reason: "refusal"` explicitly.
- Tools are declared with `strict: true` and `additionalProperties: false`, so arguments are schema-valid; we validate again with zod before executing (defence in depth: the SDK's tolerant parser can hand back truncated input). Range constraints (string lengths, array sizes, numeric bounds) live only in zod; the JSON schema carries types, enums and descriptions.
- `tool_choice` stays `auto` (forced tool use is rejected on this model). The system prompt steers: "the only way to give a final recommendation is `recommend_next_step`". If the model ends its turn with free text, that text is treated as a question/interim message, not a recommendation.
- The system prompt has two blocks: the static prompt with `cache_control: { type: "ephemeral" }`, then a one-line locale note (`en`/`ar`) with no cache marker. The tool list precedes the system blocks in the API request and is kept in a fixed order, so the cache breakpoint covers tools + static prompt and hits across turns and users.
- History is **append-only** (see ARCHITECTURE.md). We pass `thinking` blocks back unchanged.
- The loop depends on a narrow `ClaudeClient` type (`claude.ts`) rather than the SDK class, so tests inject a scripted fake (`tests/helpers/fake-claude.ts`).

## Tools

Defined in `src/server/agent/tools.ts`, in this fixed order (part of the cached prefix).

| Tool | Deterministic? | Purpose | Input (strict) | Output |
| --- | --- | --- | --- | --- |
| `assess_urgency` | yes | Red-flag rule engine | `symptoms[]` (1–10 strings), `red_flags[]` (enum, may be empty), `duration_hours?`, `severity_1_to_10?`, `age?` | `{ urgency, must_call_emergency_services, matched_rules: [{ id, description }], suggested_specialties[] }` |
| `search_providers` | yes (DB) | Find providers | `specialty` (enum), `city?`, `country?` (ISO-2), `language?` (enum), `emergency_capable?`, `telemedicine?`, `limit?` (1–20, default 10) | `{ results: ProviderSummary[], total, note? }` — `note` only when `results` is empty, telling the model to widen or ask, never invent |
| `get_provider_details` | yes (DB) | Full record | `provider_id` (uuid) | `Provider` (adds `parentProviderId`, `accreditations`, descriptions, `isActive`), or `is_error` for unknown/inactive ids |
| `recommend_next_step` | validated | Final structured answer | `next_step` (enum), `urgency` (enum), `specialty` (enum or `null`), `provider_ids[]` (0–3 uuids), `rationale_for_patient` (20–1200 chars), `questions_remaining[]?` (≤3) | `{ ok: true, recommendation_id }`, or `is_error` listing the allowed provider ids |

`next_step` enum: `emergency_now`, `urgent_care_24h`, `specialist_consultation`, `second_opinion`, `primary_care`, `self_care_monitor`.
`urgency` enum: `emergency`, `urgent`, `routine`, `self_care`.

`recommend_next_step` also rejects a mismatch between `next_step: emergency_now` and `urgency: emergency` (they must be used together) so a stored record can never say "emergency" and "book a specialist" at once. On success it saves the row, hydrates the providers by id and the loop emits the `recommendation` event without re-querying.

Each `tool_result` sent back to the model is the JSON of the output, or on failure the plain error text with `is_error: true`. Every call (input, output or `{ error }`, latency) is recorded in `tool_calls`.

### Why a rule engine for urgency

LLMs are good at understanding a messy description and bad at being consistent about thresholds. So the model's job is to *extract* structured facts (symptoms, red flags, duration, severity, age) and the rule table's job is to *decide* the urgency. Rules are data (`src/server/triage/rules.ts`) so a clinician can review them, and `tests/triage.test.ts` pins each one down. The model may add nuance in its prose but the stored `urgency` is the engine's.

How the engine works (`src/server/triage/engine.ts`): symptoms are matched against small regex "concepts" (`CHEST_PAIN`, `HEADACHE`, `RASH`) so paraphrases like "pain in my chest" or "chest tightness" count; every rule is evaluated; the highest urgency wins; only the rules at the winning level are reported in `matched_rules`, and their specialties are unioned (deduped, max 3) into `suggested_specialties`. `must_call_emergency_services` is simply `urgency === "emergency"`.

The rule table today:

| Rule id | Trigger | Urgency | Specialties |
| --- | --- | --- | --- |
| `chest_pain_red_flags` | chest pain + any of {shortness of breath, pain radiating to arm/jaw, sweating/nausea, fainting}, or known heart disease with severity ≥ 7 | emergency | cardiology, emergency_medicine |
| `chest_pain_risk_factors` | chest pain + (severity ≥ 7 or age ≥ 40 or known heart disease) | urgent | cardiology, emergency_medicine |
| `chest_pain` | chest pain alone (never self-care) | routine | cardiology, general_practice |
| `stroke_signs` | face droop, arm weakness, speech difficulty or sudden severe headache (FAST) | emergency | neurology, emergency_medicine |
| `meningitis_signs` | high fever with stiff neck | emergency | emergency_medicine, neurology |
| `severe_or_persistent_headache` | headache with severity ≥ 8 or lasting > 72 h | urgent | neurology |
| `vision_loss` | vision loss | urgent | ophthalmology |
| `severe_bleeding` | severe bleeding | emergency | emergency_medicine |
| `difficulty_breathing` | difficulty breathing | emergency | emergency_medicine, pulmonology |
| `suicidal_thoughts` | suicidal thoughts | emergency | psychiatry, emergency_medicine |
| `abdominal_pain_pregnancy` | severe abdominal pain + pregnancy | emergency | emergency_medicine |
| `severe_abdominal_pain` | severe abdominal pain | urgent | gastroenterology, emergency_medicine |
| `skin_complaint` | rash, itching, hives, mole/skin changes | routine | dermatology |
| `mild_short_lived` | severity ≤ 3 and duration ≤ 72 h (both known) and no red flags | self_care | general_practice |
| `fallback` | nothing else matched | routine | general_practice |

`pregnancy` and `known_heart_disease` are modifiers: alone they never raise urgency. Missing facts fall toward the conservative side (routine rather than self-care).

## Preventing hallucinated providers (grounding)

Four layers, each independent:

1. **Prompt:** the model is told it has no knowledge of HealTrip providers and must only reference ones returned by tools; if the search is empty it must say so and widen the search or ask, never invent. The empty-result `note` from `search_providers` repeats this at the moment it matters.
2. **Grounding set:** `grounding.ts` records every provider id returned by `search_providers` / `get_provider_details` in this conversation. It is rebuilt from the persisted `tool_calls` rows (successful calls only) at the start of every turn, so it survives restarts and multi-instance deployments.
3. **Validation at the only exit:** `recommend_next_step` rejects any `provider_id` not in the grounding set and returns `is_error` with the allowed ids. The model can correct itself within the remaining step budget; if it never does, the turn ends with `done` (free text) or `step_limit` and no recommendation is stored.
4. **Rendering from the database:** the UI never shows provider names taken from model text. The `recommendation` SSE event carries provider rows loaded by id from the repository, and the GET projection attaches recommendations from the `recommendations` table. If a name appears only in prose, it is just prose with no card, link or booking action.

A fifth, softer layer: provider rows include `id` and the model is instructed to refer to providers by name *and* id in its rationale, which makes drift visible in logs and evals (the eval also checks prose for provider names that no tool returned).

## Clarifying questions

The prompt lists the facts needed to route (main symptom, onset/duration, severity, red flags, age range, city/country, language, whether already under treatment). The model asks only for what is missing *and* decision-relevant, max two per message, in the user's language, and proceeds with stated assumptions if the patient cannot answer. For an emergency the loop short-circuits: `assess_urgency` returns `must_call_emergency_services: true`, the prompt requires an immediate `recommend_next_step(emergency_now)` with no further questions, and the UI shows a red banner.

## Loop control and failure modes

All of these end the turn with exactly one terminal SSE event; the loop never throws for expected failures.

- `AGENT_MAX_STEPS` (default 6, max 10) bounds model calls per user message. Hitting the cap emits `error` (`code: step_limit`, not retryable); the partial text stays visible.
- Invalid tool input → `is_error` tool_result with the zod issues; the model retries. Unknown tool name → `is_error`.
- Tool execution throws (e.g. DB down) → the error is logged server-side and the model gets a generic "temporary server problem" message, never driver details.
- `stop_reason: max_tokens` → `error` (`max_tokens`) asking the user to send a follow-up; any pending `tool_use` is **not** executed because its input may be truncated.
- `stop_reason: refusal` (after fallbacks) → `error` (`refusal`); the UI shows a localized message.
- `stop_reason: pause_turn` → loop continues with the same history.
- Unparseable tool JSON (the SDK rejects `finalMessage()` with a plain `AnthropicError`) → the request is re-issued once.
- API errors use the SDK's typed classes (the SDK already retries connection errors, 429 and 5xx twice): `AuthenticationError` → `upstream_error` "AI service is not configured" (not retryable); `RateLimitError`, `APIConnectionError`, any 5xx → `upstream_error` retryable; other 4xx → `upstream_error` not retryable; a cancelled request or any unknown throw → `internal_error`.
- One JSON log line per step (`agent.step`: conversation id, step, stop reason, tool names, latency, token usage). Message text is never logged. Everything the model did is auditable in `tool_calls`.

## Evaluation

`npm run eval` (`scripts/eval.ts` + `scripts/scenarios.ts`) runs scripted scenarios against the real model — chest pain with red flags, chest pain without red flags in a 45-year-old, a mild rash in Arabic, and endocrinology in a city with no coverage — feeding scripted answers whenever the agent asks a question. It runs the production `runTurn` unchanged against the in-memory repository, prints the tool calls and final recommendation (`--json` for a machine-readable report, `--only <id>` for a subset; exit code 1 on any failure) and checks loose expectations (acceptable urgency/next-step sets, specialty, provider count) plus grounding: every recommended id must have come from a tool, and prose must not name providers the tools never returned. The vitest suite covers the same loop with a fake client and needs no API key.
