# Agent design

## Role

The agent is a **triage-and-routing assistant**, not a diagnostician. Its job per conversation:

1. Understand the patient's situation (symptom, duration, severity, red flags, location, language, constraints).
2. Ask **clarifying questions** when the next step genuinely depends on missing information — at most two at a time, none when the case is already an emergency.
3. Determine urgency with the deterministic `assess_urgency` tool (never by itself).
4. Find matching providers with `search_providers` / `get_provider_details`.
5. Produce the final answer **only** through `recommend_next_step`, which the server validates and stores.

## Model and request shape

- Model: `claude-opus-5-5` (configurable via `CLAUDE_MODEL`). Thinking is always on for this model; we control latency/cost with `output_config.effort` (`low` for chat; configurable).
- Streaming (`client.beta.messages.stream`) so text reaches the UI as it is generated; `finalMessage()` gives us `stop_reason` and the content blocks.
- `betas: ["server-side-fallback-2026-07-01"]` + `fallbacks: "default"` so a safety-classifier decline is re-run on Anthropic's recommended fallback model instead of producing an empty reply. We still handle `stop_reason: "refusal"` explicitly.
- Tools are declared with `strict: true` and `additionalProperties: false`, so arguments are schema-valid; we validate again with zod before executing (defence in depth: the SDK's tolerant parser can hand back truncated input).
- `tool_choice` stays `auto` (forced tool use is rejected on this model). The system prompt steers: "the only way to give a final recommendation is `recommend_next_step`". The loop checks whether it was called; if the model ends its turn with free text, that text is treated as a question/interim message, not a recommendation.
- The static system prompt and the tool list come first and are marked `cache_control: ephemeral`; the volatile locale note is appended as the *last* system block so prompt caching hits across turns and users.
- History is **append-only** (see ARCHITECTURE.md). We pass `thinking` blocks back unchanged.

## Tools

| Tool | Deterministic? | Purpose | Input (strict) | Output |
| --- | --- | --- | --- | --- |
| `assess_urgency` | yes | Red-flag rule engine | `symptoms[]`, `red_flags[]` (enum), `duration_hours?`, `severity_1_to_10?`, `age?` | `{ urgency, must_call_emergency_services, matched_rules[], suggested_specialties[] }` |
| `search_providers` | yes (DB) | Find providers | `specialty` (enum), `city?`, `country?`, `language?`, `emergency_capable?`, `telemedicine?`, `limit?` | `{ results: ProviderSummary[], total }` |
| `get_provider_details` | yes (DB) | Full record | `provider_id` | `Provider` or `is_error` |
| `recommend_next_step` | validated | Final structured answer | `next_step` (enum), `urgency` (enum), `specialty?`, `provider_ids[]` (0–3), `rationale_for_patient`, `questions_remaining[]?` | `{ ok: true, recommendation_id }` or `is_error` with the list of allowed ids |

`next_step` enum: `emergency_now`, `urgent_care_24h`, `specialist_consultation`, `second_opinion`, `primary_care`, `self_care_monitor`.
`urgency` enum: `emergency`, `urgent`, `routine`, `self_care`.

### Why a rule engine for urgency

LLMs are good at understanding a messy description and bad at being consistent about thresholds. So the model's job is to *extract* structured facts (symptoms, red flags, duration, severity) and the rule table's job is to *decide* the urgency. Rules are data (`src/server/triage/rules.ts`) so a clinician can review them, and tests pin them down. The model may disagree in its prose but the stored `urgency` is the engine's.

Examples of rules (not exhaustive):

- chest pain + any of {shortness of breath, pain radiating to arm/jaw, sweating, fainting} → `emergency`
- chest pain + severity ≥ 7 or age ≥ 40 → `urgent` (same-day), suggested specialties: cardiology, emergency_medicine
- FAST stroke signs (face droop, arm weakness, speech difficulty) → `emergency`
- severe bleeding, difficulty breathing, suicidal thoughts → `emergency`
- otherwise → `routine` or `self_care` depending on severity/duration

## Preventing hallucinated providers (grounding)

Four layers, each independent:

1. **Prompt:** the model is told it has no knowledge of HealTrip providers and must only reference ones returned by tools; if the search is empty it must say so and widen the search or ask, never invent.
2. **Grounding set:** `grounding.ts` records every provider id returned by `search_providers` / `get_provider_details` in this conversation (rebuilt from persisted `tool_calls` on each turn, so it survives restarts).
3. **Validation at the only exit:** `recommend_next_step` rejects any `provider_id` not in the grounding set and returns `is_error` with the allowed ids. The model gets one more step to correct itself; if it cannot, the turn ends with an error event and no recommendation is stored.
4. **Rendering from the database:** the UI never shows provider names taken from model text. The `recommendation` SSE event carries provider rows loaded by id from the repository. If a name appears only in prose, it is just prose with no card, link or booking action.

A fifth, softer layer: provider rows include `id` and the model is instructed to refer to providers by name *and* id in its rationale, which makes drift visible in logs and evals.

## Clarifying questions

The prompt lists the facts needed to route (main symptom, onset/duration, severity, red flags, age range, city/country, language, insurance/budget if relevant). The model asks only for what is missing *and* decision-relevant, max two per turn, and in the user's language. For an emergency the loop short-circuits: `assess_urgency` returns `must_call_emergency_services: true`, the prompt requires an immediate `recommend_next_step(emergency_now)` with no further questions, and the UI shows a red banner.

## Loop control and failure modes

- `MAX_STEPS` (default 6) bounds model calls per user message. Hitting the cap emits an `error` (`code: step_limit`) and the partial text stays visible.
- Invalid tool input → `is_error` tool_result with the zod issues; the model retries.
- Tool execution throws → `is_error` with a short message (no stack traces to the model).
- `stop_reason: max_tokens` → error event asking the user to continue.
- `stop_reason: refusal` after fallbacks → friendly message in the user's language.
- API errors use the SDK's typed classes: `RateLimitError`/5xx are retried by the SDK (2 retries); on final failure we emit `error` with `retryable: true`.
- Everything the model did is auditable in `tool_calls`.

## Evaluation

`npm run eval` runs scripted scenarios (chest pain with red flags; chest pain without red flags; a routine dermatology case; an out-of-coverage city) and prints the tool calls and final recommendation so behaviour can be reviewed without clicking through the UI.
