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
**Decision.** `assess_urgency` is a data-driven rule table (`src/server/triage/rules.ts`). The model must call it and must not override its result in the stored recommendation.
**Consequences.** Clinically reviewable, unit-testable; some edge cases will be conservative (over-triage), which is the safer failure mode. Symptom matching is regex-based on the model's English paraphrase, which is good enough for a prototype and obviously replaceable.

## ADR-4: Grounding enforced at the single exit tool, and cards rendered from DB rows
**Context.** The brief explicitly asks how we stop the model inventing data.
**Decision.** Only `recommend_next_step` can produce a recommendation; its provider ids must be in the set the model fetched (rebuilt from the `tool_calls` audit table each turn); the server hydrates providers by id and the UI renders only those rows.
**Consequences.** A hallucinated provider can at most appear as prose, never as a card or stored recommendation.

## ADR-5: Postgres via Drizzle plus an in-memory repository with the same seed data
**Context.** Reviewers may not want to run Docker; tests should be fast; the demo should not depend on DB uptime.
**Decision.** Repository interfaces with two implementations selected by the presence of `DATABASE_URL`.
**Consequences.** Slight duplication of query logic (kept tiny: filter + sort). Postgres is the reference implementation; memory mirrors it and shares the same test suite (the Postgres half runs only when `DATABASE_URL` is set).

## ADR-6: Claude `claude-opus-5-5`, low effort, prompt caching, server-side fallbacks
**Context.** Chat latency matters; safety classifiers can decline medical content; cost should be predictable.
**Decision.** Opus 5.5 with `output_config.effort = "low"` (configurable), a static cached system block with the tool list in a fixed order, `fallbacks: "default"`.
**Consequences.** Good reasoning quality with low time-to-first-token; a declined request is served by a fallback model rather than failing; model and effort are swappable by env var.

## ADR-7: Server-side conversation state
**Context.** Append-only history is required for caching and preserved-thinking; the UI should be reload-safe; auditability of tool calls is a requirement of the brief.
**Decision.** Store verbatim API content blocks and tool calls per conversation; the client holds only the conversation id (in `sessionStorage`) and rehydrates from `GET /api/conversations/:id`.
**Consequences.** Slightly more code than a stateless echo-the-history API, but a real data flow and audit trail. The one-turn-per-conversation lock is a timestamp on the conversation row so it works across instances.

## Assumptions

- Synthetic provider data; no real hospitals or doctors are represented.
- Locations are matched by city/country strings in the seed (no geocoding).
- English and Arabic UI; the agent answers in the user's language and can handle other languages in free text.
- No authentication, payments, booking or medical records in scope.
- "Second opinion" is modelled as a next step that routes to a specialist of the same specialty, flagged `second_opinion` so a product could later attach records-review workflows.
- Rate limiting is per process; the turn lock is per conversation row (DB) or per process (memory mode).
- A retried turn re-sends the user message; the stored history may then contain it twice (see API.md).

## Deployment

Target: Vercel (Node runtime; SSE streaming supported) with a Neon Postgres database from the Vercel Marketplace, `ANTHROPIC_API_KEY` set as a server env var. Without `DATABASE_URL` the deployment runs on the in-memory repository, which is acceptable for a demo but loses conversations on cold starts. Steps are in the README. GitHub Actions (`.github/workflows/ci.yml`) runs lint, typecheck, tests and build on every push and pull request to `main`; the tests need neither an API key nor a database.
