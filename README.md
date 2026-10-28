# HealTrip — AI Patient Decision Assistant (Prototype)

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
| UI | Next.js 16 (App Router), React 19, Tailwind 4 | Chat UI with streaming; bilingual AR/EN with RTL |
| Backend | Next.js Route Handlers (Node runtime) over a framework-independent `src/server` layer | One deployable; the domain layer has no Next.js imports and could be lifted into NestJS/Hono unchanged |
| AI | Claude (`@anthropic-ai/sdk`, model `claude-opus-5-5` by default) with strict tool definitions and a hand-written, append-only agent loop | Full control over step limits, grounding checks and streaming events |
| Data | PostgreSQL via Drizzle ORM, with an in-memory repository fallback using the same seed data | Real DB locally/in prod; zero-setup demo and fast tests without a DB |
| Validation | zod on every boundary (HTTP input, tool input, tool output) | Never trust the client or the model |
| Tests | vitest (rule engine, grounding validator, repositories, agent loop with a fake Claude client) | Deterministic tests that do not need an API key |

## Quick start

```bash
cp .env.example .env            # add ANTHROPIC_API_KEY; DATABASE_URL is optional
npm install
npm run dev                     # http://localhost:3000  (in-memory DB if DATABASE_URL is unset)
```

With PostgreSQL:

```bash
docker compose up -d            # local Postgres on :5432
npm run db:push                 # create tables from the Drizzle schema
npm run db:seed                 # load providers (hospitals, clinics, doctors)
npm run dev
```

Other scripts: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`,
`npm run eval` (runs scripted patient scenarios against the real model and prints the transcript).

## How it works (30-second version)

1. The patient types a message. The browser `POST`s it to `/api/conversations/:id/messages` and reads a **Server-Sent Events** stream.
2. The server loads the conversation history, appends the message and runs the **agent loop**: Claude is called with a fixed system prompt and four **strict tools**.
3. Claude either asks a **clarifying question** (plain text), or calls tools:
   - `assess_urgency` — a deterministic red-flag rule engine (chest pain + shortness of breath → emergency, FAST stroke signs → emergency, …).
   - `search_providers` / `get_provider_details` — parameterised queries against the providers table.
   - `recommend_next_step` — the only way to produce a final recommendation.
4. The server **validates every tool input with zod** and executes it. For `recommend_next_step`, every `provider_id` must be one the model actually received from a search tool in this conversation; otherwise the call is rejected and the model is told to fix it.
5. The UI renders provider cards from **database rows attached by the server**, never from model text.

## Important assumptions and notes

- This is a **decision-support prototype, not a medical device**. It never diagnoses; it triages and routes. Every recommendation carries a disclaimer and emergency cases short-circuit to "call emergency services now".
- Provider data is **synthetic seed data** (names, cities, ratings are fictional).
- Conversations are stored server-side (Postgres or memory) keyed by an unguessable UUID; there is no user login in this prototype. See [docs/SECURITY.md](docs/SECURITY.md) for what production would add.
- The agent needs an `ANTHROPIC_API_KEY`. Everything else (DB, UI, tests) runs without one.

## Demo

See the **Deployment** section of [docs/DECISIONS.md](docs/DECISIONS.md) and the repository description for the live URL once deployed.
