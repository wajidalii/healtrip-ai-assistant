# HealTrip — AI Patient Decision Assistant (Prototype)

[![CI](https://github.com/wajidalii/healtrip-ai-assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/wajidalii/healtrip-ai-assistant/actions/workflows/ci.yml)

A small, clean prototype of an AI assistant that helps a patient decide **what to do next**:
see a specialist, go to the ER, get a second opinion, or monitor at home — and which
real providers (from our own database) fit that decision.

> Example input: *"I have chest pain and I'm not sure whether I should see a cardiologist,
> go to the ER, or seek a second opinion."*

The focus of this prototype is **engineering thinking**, not visual polish:
architecture, agent design, tool calling, data flow, security, error handling, and
preventing the model from inventing providers that do not exist in the database.

- **Repository layout, data flow and agent loop:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Agent design and anti-hallucination strategy:** [docs/AGENT.md](docs/AGENT.md)
- **HTTP API contract (SSE streaming):** [docs/API.md](docs/API.md)
- **Database schema and seed data:** [docs/DATABASE.md](docs/DATABASE.md)
- **Security and error handling:** [docs/SECURITY.md](docs/SECURITY.md)
- **Technical decisions (ADRs) and assumptions:** [docs/DECISIONS.md](docs/DECISIONS.md)

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| UI | Next.js 16 (App Router), React 19, Tailwind 4 | Chat UI with streaming; bilingual AR/EN with RTL (`src/i18n`, `src/components`) |
| Backend | Next.js Route Handlers (Node runtime) over a framework-independent `src/server` layer | One deployable; the domain layer has no Next.js imports and could be lifted into NestJS/Hono unchanged |
| AI | Claude (`@anthropic-ai/sdk`, model `claude-opus-5-5` by default) with strict tool definitions and a hand-written, append-only agent loop | Full control over step limits, grounding checks and streaming events |
| Data | PostgreSQL via Drizzle ORM, with an in-memory repository fallback using the same seed data | Real DB locally/in prod; zero-setup demo and fast tests without a DB |
| Validation | zod on every boundary (HTTP input, tool input, persisted tool output, SSE events in the browser) | Never trust the client or the model |
| Tests | vitest: rule engine, tools, grounding set, repositories (memory always, Postgres when `DATABASE_URL` is set), HTTP layer, agent loop with a scripted fake Claude client | Deterministic tests that do not need an API key |

## Quick start

```bash
cp .env.example .env            # add ANTHROPIC_API_KEY (or AI_GATEWAY_API_KEY); DATABASE_URL is optional
npm install
npm run dev                     # http://localhost:3000  (in-memory DB if DATABASE_URL is unset)
```

With PostgreSQL:

```bash
docker compose up -d            # local Postgres on :5432 (user/password/db: healtrip)
npm run db:push                 # create tables from the Drizzle schema
npm run db:seed                 # load providers (hospitals, clinics, doctors); idempotent
npm run dev
```

Other scripts: `npm test` (or `npm run test:watch`), `npm run lint`, `npm run typecheck`, `npm run build`,
`npm run eval` (runs scripted patient scenarios against the real model and prints the transcript).

Environment variables (all parsed once by `src/server/config.ts`; see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | unset | Direct Anthropic API (`mode: anthropic`). Only the agent needs credentials; everything else runs without them |
| `AI_GATEWAY_API_KEY` | unset | Vercel AI Gateway key (`mode: gateway-key`), used when `ANTHROPIC_API_KEY` is unset |
| `VERCEL` | set by Vercel | With neither key set, selects `mode: gateway-oidc` (AI Gateway with the deployment's OIDC token); not meant to be set by hand |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model id; mapped to a `provider/model` slug in the gateway modes (see below) |
| `CLAUDE_EFFORT` | `low` | `output_config.effort`: `low`, `medium`, `high`, `xhigh`, `max` |
| `AGENT_MAX_STEPS` | `6` | Model calls per user message (1–10) |
| `DATABASE_URL` | unset | Postgres URL; unset selects the in-memory repository |
| `RATE_LIMIT_PER_MINUTE` | `20` | Messages per IP per minute |

### Credential modes

`src/server/agent/claude.ts` picks one of three ways to reach the model from the environment, in this order; `GET /api/health` reports the chosen `mode` and the effective `model` (never a credential):

| Mode | When | Request | Vercel env vars needed |
| --- | --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` set | `api.anthropic.com`, `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta | `ANTHROPIC_API_KEY` |
| `gateway-key` | else `AI_GATEWAY_API_KEY` set | `https://ai-gateway.vercel.sh` with the key; no `betas`/`fallbacks` | `AI_GATEWAY_API_KEY` |
| `gateway-oidc` | else running on Vercel | same URL, bearer token from `getVercelOidcToken()` (`@vercel/functions`) resolved per turn; no `betas`/`fallbacks` | none (enable "Secure Backend Access with OIDC Federation" in the project settings and AI Gateway on the team) |
| `unconfigured` | none of the above | the agent refuses with a generic `upstream_error`; the rest of the app works | — |

In the gateway modes `CLAUDE_MODEL` is mapped to a gateway slug: a fixed table (`claude-opus-5-5` → `anthropic/claude-opus-5.5`, same for `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-opus-5`, `claude-sonnet-5`), otherwise `anthropic/` + the id with a trailing `-N-N` rewritten to `-N.N`; a value containing `/` is used verbatim. `output_config.effort`, strict tools and prompt caching are unchanged in every mode. Local OIDC: `vercel env pull` writes a short-lived `VERCEL_OIDC_TOKEN`; set `VERCEL=1` as well to select the mode off-platform. `npm run eval` still requires `ANTHROPIC_API_KEY`.

## How it works (30-second version)

1. The patient types a message. The browser `POST`s it to `/api/conversations/:id/messages` and reads a **Server-Sent Events** stream.
2. The route validates the body, checks the per-IP rate limit and takes a **per-conversation turn lock**; then the **agent loop** loads the history, appends the message and calls Claude with a fixed, cached system prompt and four **strict tools**.
3. Claude either asks a **clarifying question** (plain text), or calls tools:
   - `assess_urgency` — a deterministic red-flag rule engine (chest pain + shortness of breath → emergency, FAST stroke signs → emergency, …).
   - `search_providers` / `get_provider_details` — parameterised queries against the providers table.
   - `recommend_next_step` — the only way to produce a final recommendation.
4. The server **validates every tool input with zod** and executes it. For `recommend_next_step`, every `provider_id` must be one the model actually received from a search tool in this conversation; otherwise the call is rejected and the model is told which ids are allowed.
5. The UI renders provider cards from **database rows attached by the server**, never from model text.

## How to review this repo

Open these six files first, in this order:

1. `src/shared/contracts.ts` — every enum, DTO, zod schema and the `AgentEvent` SSE union; shared by server and UI.
2. `src/server/agent/run-turn.ts` — the agent loop: streaming call, stop-reason handling, tool execution, append-only persistence, exactly one terminal event.
3. `src/server/agent/tools.ts` — the four tool definitions (strict JSON schema + zod) and their executors; `recommend_next_step` is the single validated exit.
4. `src/server/agent/grounding.ts` — the set of provider ids the model has actually seen, rebuilt from the `tool_calls` audit table on every turn.
5. `src/server/triage/rules.ts` — the red-flag rule table that decides urgency; data, not prose.
6. `src/server/http/sse.ts` — SSE encoding, heartbeats, terminal-event guarantee and lock release on disconnect.

Then `tests/run-turn.test.ts` shows the loop end-to-end with a scripted fake Claude client.

## Notes and assumptions

- **Decision support, not diagnosis.** The assistant triages and routes; it never names a condition as fact or prescribes. Every recommendation ends with a not-medical-advice line and emergencies short-circuit to "call local emergency services now".
- **Synthetic data.** The 33 providers (hospitals, clinics, doctors across nine cities) are fictional: names, ratings, accreditations and languages are invented. No real hospital or doctor is represented.
- **No authentication.** Conversations are stored server-side keyed by an unguessable v4 UUID. That is not access control; [docs/SECURITY.md](docs/SECURITY.md) lists what production adds.
- **Model and cost knobs.** `CLAUDE_MODEL`, `CLAUDE_EFFORT` (default `low` for chat latency) and `AGENT_MAX_STEPS` (default 6) are env vars. The static prompt and tool list are prompt-cached; `fallbacks: "default"` lets a safety-classifier decline be served by Anthropic's fallback model (direct-API mode only; see "Credential modes").
- **Memory vs Postgres.** Without `DATABASE_URL` the app runs on an in-memory repository seeded with the same data, so the UI, API and tests work with zero setup; conversations then live only as long as the process. With Postgres the same repository interface is backed by Drizzle, and the shared repository test suite runs against both.
- **What the eval covers.** `npm run eval` runs scripted scenarios (chest pain with red flags, chest pain without, a routine dermatology case, a city with no coverage) against the real model and checks urgency/next-step/specialty expectations and provider grounding (every recommended id came from a tool; prose names no provider the tools did not return), and prints the transcript (`--json`, `--only <id>`). It needs `ANTHROPIC_API_KEY`; the vitest suite does not.
- **Where the time went.** The backend (agent loop, grounding, rule engine, HTTP layer) and its tests, plus the docs, over UI polish. The UI is functional, bilingual and RTL-aware but deliberately plain.
- **Known limitations.** Rate limiting and the turn lock are per process (Redis in production); the user message is persisted before the model is called, so a turn that fails mid-way leaves it in history and a UI retry sends it again; the rule table is a reviewable starting point, not a clinically validated triage protocol.

## Demo

See the **Deployment** section of [docs/DECISIONS.md](docs/DECISIONS.md) and the repository description for the live URL once deployed.
