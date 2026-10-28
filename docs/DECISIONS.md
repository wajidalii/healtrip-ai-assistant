# Technical decisions (lightweight ADRs) and assumptions

## ADR-1: Single Next.js deployable with a framework-free `src/server` layer
**Context.** The brief allows "Node.js/NestJS or what you prefer" and asks for a clear API architecture and a demo link within 24–48h.
**Decision.** One Next.js app. Route handlers are thin adapters; all business logic lives in `src/server` with no framework imports and is tested directly.
**Consequences.** One deployment, streaming works on the Node runtime, and the backend remains portable. We lose NestJS's module/DI conventions, which this prototype does not need.

## ADR-2: Hand-written agent loop over the SDK tool runner
**Context.** We need to emit UI events per step, enforce a step cap, rebuild grounding state from persistence and reject ungrounded recommendations *inside* the loop.
**Decision.** A small loop (`src/server/agent/run-turn.ts`) over `client.beta.messages.stream(...)` + `finalMessage()`, with tools defined as strict JSON schemas and executed by us.
**Consequences.** Full control and visibility for reviewers; we own re-issuing malformed tool input and stop-reason handling. The loop depends only on `(repositories, a narrow ClaudeClient, config)`, so tests inject a scripted fake client.

## ADR-3: Deterministic rule engine decides urgency; the model extracts facts
**Context.** Consistency and reviewability matter more than nuance for red-flag triage.
**Decision.** `assess_urgency` is a data-driven rule table (`src/server/triage/rules.ts`). The model must call it and cannot override its result: `recommend_next_step` is rejected unless `assess_urgency` has run in the conversation and `input.urgency` equals the engine's latest value, which `UrgencyRecord` (`src/server/agent/urgency-record.ts`) rebuilds from the `tool_calls` audit table on every turn, the same way the grounding set is rebuilt. The only way for the model to change the urgency is to call the engine again with new facts.
**Consequences.** Clinically reviewable, unit-testable, and enforced rather than requested: patient text or a provider description cannot talk a red-flag case down to self-care. Some edge cases will be conservative (over-triage), which is the safer failure mode. Symptom matching is regex-based on the model's English paraphrase, which is good enough for a prototype and obviously replaceable.

## ADR-4: Grounding enforced at the single exit tool, and cards rendered from DB rows
**Context.** The brief explicitly asks how we stop the model inventing data.
**Decision.** Only `recommend_next_step` can produce a recommendation; its provider ids must be in the set the model fetched (rebuilt from the `tool_calls` audit table each turn); `get_provider_details` accepts only ids already in that set, so a guessed or user-pasted id cannot be laundered into it; the server hydrates providers by id and the UI renders only those rows.
**Consequences.** A hallucinated provider can at most appear as prose, never as a card or stored recommendation.

## ADR-5: Postgres via Drizzle plus an in-memory repository with the same seed data
**Context.** Reviewers may not want to run Docker; tests should be fast; the demo should not depend on DB uptime.
**Decision.** Repository interfaces with two implementations selected by the presence of `DATABASE_URL`.
**Consequences.** Slight duplication of query logic (kept tiny: filter + sort). Postgres is the reference implementation; memory mirrors it and shares the same test suite (the Postgres half runs only when `DATABASE_URL` is set).

## ADR-6: Claude `claude-opus-5-5`, low effort, prompt caching, server-side fallbacks
**Context.** Chat latency matters; safety classifiers can decline medical content; cost should be predictable.
**Decision.** Opus 5.5 with `output_config.effort = "low"` (configurable), `max_tokens` scaled by effort (`MAX_TOKENS_BY_EFFORT`: 8192 at `low` up to 64 000 at `xhigh`/`max`, since thinking counts toward it), a static cached system block with the tool list in a fixed order plus a top-level `cache_control` breakpoint on the growing history, `fallbacks: "default"`.
**Consequences.** Good reasoning quality with low time-to-first-token; a declined request is served by a fallback model rather than failing; model and effort are swappable by env var, and raising the effort raises the output ceiling and the turn-lock TTL budget with it rather than truncating replies.

## ADR-7: Server-side conversation state
**Context.** Append-only history is required for caching and preserved-thinking; the UI should be reload-safe; auditability of tool calls is a requirement of the brief.
**Decision.** Store verbatim API content blocks and tool calls per conversation; the client holds only the conversation id (in `sessionStorage`) and rehydrates from `GET /api/conversations/:id`.
**Consequences.** Slightly more code than a stateless echo-the-history API, but a real data flow and audit trail. The one-turn-per-conversation lock is a timestamp on the conversation row so it works across instances.

## ADR-8: Credential modes — direct API, gateway key, or Vercel OIDC
**Context.** The demo runs on Vercel and we would rather not store an Anthropic key there; Vercel's AI Gateway can bill the team instead, and on Vercel a deployment can authenticate to the gateway with its own short-lived OIDC token (verified: the gateway accepts the token as a bearer through the Anthropic SDK and the request reaches billing). Local development and the eval script still use a plain key.
**Decision.** `resolveProviderMode(env)` (`src/server/agent/claude.ts`) is a pure function of the environment returning `{ mode, baseURL?, model, useServerFallbacks }`, in precedence order `anthropic` (`ANTHROPIC_API_KEY`) → `gateway-key` (`AI_GATEWAY_API_KEY`) → `gateway-oidc` (no key, `VERCEL` set) → `unconfigured`. `createClaudeClientForMode(mode)` builds the SDK client: `new Anthropic()` with the key, or `baseURL: https://ai-gateway.vercel.sh` with the gateway key, or the same URL with `authToken` from `getVercelOidcToken()` and `apiKey: null`. The OIDC token is short-lived, so that client is built per turn and never cached; key-mode clients are cached per process. In the gateway modes the model id is mapped to a `provider/model` slug (explicit table, then `anthropic/` + id with a trailing `-N-N` → `-N.N`), and the Anthropic-only `betas` + `fallbacks: "default"` parameters are omitted because gateway support for them is unknown; effort, strict tools and `cache_control` are kept. The loop stays mode-agnostic: it receives `{ model, useServerFallbacks }` through its deps. `/api/health` reports `mode` and the effective model id and nothing else.
**Consequences.** The production demo needs no Anthropic secret; the behaviour difference between modes is confined to one factory and one conditional in the request builder, and is unit-tested with env objects (`tests/provider-modes.test.ts`). Through the gateway a safety-classifier decline ends the turn as `refusal` instead of being served by a fallback model. A `VERCEL`-only selection cannot be reproduced off-platform without `vercel env pull` (which writes `VERCEL_OIDC_TOKEN`) plus `VERCEL=1`.

## ADR-9: OpenAI mode behind the loop's client interface, not a second loop
**Context.** The reviewer's demo needs a working model call, and the only credential at hand was an OpenAI key. The loop, the persisted history (ADR-7) and the tests are written against the Anthropic Messages shape: content blocks, `tool_use`/`tool_result`, `stop_reason`, replayed thinking. Supporting a second provider by branching inside the loop would double the paths that enforce grounding (ADR-4) and urgency (ADR-3).
**Decision.** `src/server/agent/openai.ts` implements the loop's `ClaudeClient` slice over the OpenAI Responses API and translates at the edge only: `system` → `instructions`, blocks → input items (`text` → message, `tool_use` → `function_call` with `call_id` as the block id, `tool_result` → `function_call_output`), strict tool definitions → function tools, `max_tokens` → `max_output_tokens`, `output_config.effort` → `reasoning.effort`; responses come back as `text` / `tool_use` blocks with `stop_reason` derived from `status`, `incomplete_details` and refusal parts, and OpenAI SDK errors are re-raised as the equivalent Anthropic SDK classes so `classifyError` is unchanged. Requests are stateless (`store: false`); the model's reasoning items are stored as `redacted_thinking` blocks whose `data` carries the encrypted reasoning, and replayed verbatim on the next step because the API requires the reasoning that preceded a function call to accompany it. Tools are sent with `strict: false`: OpenAI's strict mode rejects optional properties, which `search_providers` has, and the zod validation in `tools.ts` already rejects any malformed input with an actionable message. The mode is selected by `OPENAI_API_KEY` (precedence after `ANTHROPIC_API_KEY`, before the gateway modes), the model by `OPENAI_MODEL` (default `gpt-6.1-sol`).
**Consequences.** The loop, grounding, urgency enforcement, persistence, projection and UI do not know which provider answered; `tests/openai-adapter.test.ts` drives the real `runTurn` through the adapter and checks the replayed history, the persisted shape, and error mapping. Lost in this mode: Anthropic-only `fallbacks`, explicit prompt-cache breakpoints (OpenAI caches prefixes on its own; `cached_tokens` is reported as `cacheReadInputTokens`), and strict schema enforcement at the model (replaced by validation at execution). The system prompt and the eval expectations were written for Claude; `npm run eval` runs in this mode too, but its expectations may need tuning for a different model. A history created in one mode is replayed in another with the foreign reasoning blocks dropped, which is valid for both APIs.

## Assumptions

- Synthetic provider data; no real hospitals or doctors are represented.
- Locations are matched by city/country strings in the seed (no geocoding).
- English and Arabic UI; the agent answers in the user's language and can handle other languages in free text.
- No authentication, payments, booking or medical records in scope.
- "Second opinion" is modelled as a next step that routes to a specialist of the same specialty, flagged `second_opinion` so a product could later attach records-review workflows.
- Rate limiting is per process; the turn lock is per conversation row (DB) or per process (memory mode), with a TTL of `AGENT_MAX_STEPS` × 60 s.
- Memory mode keeps at most 1000 conversations and drops ones idle for over an hour; Postgres keeps everything until a retention job exists.
- A retried turn re-sends the user message; the stored history may then contain it twice (see API.md).

## Deployment

Live at **<https://healtrip.wajidali.dev>**: Vercel (Node runtime; SSE streaming supported), git-connected to `main` so every push deploys, with a Neon Postgres database from the Vercel Marketplace (`DATABASE_URL` injected by the integration; the schema and seed are applied with `npm run db:push` / `npm run db:seed` against that URL). Model credentials per ADR-8/ADR-9; with no key set the deployment runs in `gateway-oidc` mode, which has no secret to store.

What works live today: the bilingual UI, conversation creation and reload, provider search against Postgres (`GET /api/providers`), `GET /api/health` (`repository: "postgres"`, `mode: "gateway-oidc"`), and the full SSE path up to the model call: a message opens the stream, the `conversation` event arrives, and the turn ends with a graceful terminal `error` (`upstream_error`, not retryable) that the UI shows in the user's language. What is missing is the model call itself: the AI Gateway returns "not configured / rejected" for the deployment's OIDC token until the Vercel team has AI Gateway billing enabled (or a key is set).

To enable the assistant, set exactly one of these in the Vercel project (*Settings → Environment Variables*, Production scope) and redeploy:

- `anthropic` mode: `ANTHROPIC_API_KEY` (mark it Sensitive). Highest precedence; direct API with server-side fallbacks.
- `gateway-key` mode: `AI_GATEWAY_API_KEY` from the team's AI Gateway settings. Bills the team, no Anthropic secret on the project.
- `gateway-oidc` mode: no variable; enable *Settings → Security → Secure Backend Access with OIDC Federation* on the project and AI Gateway billing on the team. This is the current configuration.

Optional in every mode: `CLAUDE_MODEL`, `CLAUDE_EFFORT`, `AGENT_MAX_STEPS`, `RATE_LIMIT_PER_MINUTE`. Without `DATABASE_URL` the deployment would run on the in-memory repository, acceptable for a demo but losing conversations on cold starts. Local setup steps are in the README.

CI: `.github/workflows/ci.yml` runs lint, typecheck, tests and build on every push and pull request to `main`; the tests need neither an API key nor a database. The GitHub-hosted runs are currently refused by GitHub ("job was not started because recent account payments have failed"), so the Vercel build on every push is the effective gate until billing is sorted; the same four commands run locally in under a minute.
