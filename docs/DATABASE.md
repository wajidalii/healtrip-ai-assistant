# Database

PostgreSQL via Drizzle ORM. The schema in `src/server/db/schema.ts` is the source of truth; `npm run db:push` applies it, `npm run db:seed` loads synthetic data. When `DATABASE_URL` is unset the same seed data backs an in-memory repository with identical behaviour.

```mermaid
erDiagram
    providers {
        uuid id PK
        text kind "hospital | clinic | doctor"
        uuid parent_provider_id FK "doctor -> hospital/clinic (nullable)"
        text name_en
        text name_ar
        text[] specialties "enum values"
        text city
        text country "ISO-3166 alpha-2"
        text[] languages "ISO-639-1"
        boolean emergency_capable
        boolean telemedicine
        boolean accepts_international
        numeric rating "0.0-5.0"
        text price_tier "low | mid | high"
        text[] accreditations
        text description_en
        text description_ar
        boolean is_active
        timestamptz created_at
    }
    conversations {
        uuid id PK
        text locale "en | ar"
        text status "open | closed"
        timestamptz created_at
        timestamptz updated_at
    }
    messages {
        uuid id PK
        uuid conversation_id FK
        integer seq "ordering within conversation"
        text role "user | assistant"
        jsonb content "Anthropic content blocks, verbatim"
        timestamptz created_at
    }
    tool_calls {
        uuid id PK
        uuid conversation_id FK
        text tool_use_id "Anthropic block id"
        text tool_name
        jsonb input
        jsonb output
        boolean is_error
        integer latency_ms
        timestamptz created_at
    }
    recommendations {
        uuid id PK
        uuid conversation_id FK
        text next_step
        text urgency
        text specialty
        uuid[] provider_ids
        text rationale
        jsonb questions_remaining
        timestamptz created_at
    }
    providers ||--o{ providers : "parent_provider_id"
    conversations ||--o{ messages : has
    conversations ||--o{ tool_calls : has
    conversations ||--o{ recommendations : has
```

## Notes

- `messages.content` stores the API content blocks **verbatim** (including `thinking` and `tool_use` / `tool_result` blocks) so history can be replayed byte-identically. The UI projection is computed from these, never stored separately.
- `tool_calls` is the audit trail and the source for rebuilding the **grounding set** (provider ids the model has seen) on each turn.
- `recommendations.provider_ids` are validated against the grounding set before insert — a recommendation row can only reference providers the model fetched.
- Enumerations (`kind`, specialties, `price_tier`, `urgency`, `next_step`) are declared once in `src/shared/contracts.ts` and used for the Drizzle columns, the zod schemas and the tool JSON schemas.
- Indexes: `providers (city)`, GIN on `providers (specialties)`, `messages (conversation_id, seq)`, `tool_calls (conversation_id)`.
- Seed: ~30 providers across Istanbul, Ankara, Antalya, Dubai, Riyadh, Amman, Cairo, Berlin and London, covering cardiology, neurology, orthopedics, oncology, dermatology, gastroenterology, general practice, emergency medicine, pediatrics, psychiatry, ophthalmology and dentistry, with mixed languages (en/ar/tr/de) and a few telemedicine-only doctors. Names are fictional.
