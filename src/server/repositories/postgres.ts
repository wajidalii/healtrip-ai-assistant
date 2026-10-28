/**
 * Postgres repositories (Drizzle). All queries are parameterised; the model
 * never produces SQL, only the fixed set of filters in ProviderSearch.
 */
import { and, arrayContains, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type {
  Locale,
  Provider,
  ProviderSearch,
  ProviderSummary,
  Recommendation,
} from "@/shared/contracts";
import type { Db } from "@/server/db/client";
import { conversations, messages, providers, recommendations, toolCalls } from "@/server/db/schema";
import type {
  ConversationRepository,
  MessageRole,
  NewRecommendation,
  ProviderRepository,
  Repositories,
  StoredConversation,
  StoredMessage,
  StoredToolCall,
} from "@/server/repositories/types";

type ProviderRow = typeof providers.$inferSelect;

function toProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    kind: row.kind,
    parentProviderId: row.parentProviderId,
    nameEn: row.nameEn,
    nameAr: row.nameAr,
    specialties: row.specialties,
    city: row.city,
    country: row.country,
    languages: row.languages,
    emergencyCapable: row.emergencyCapable,
    telemedicine: row.telemedicine,
    acceptsInternational: row.acceptsInternational,
    rating: row.rating,
    priceTier: row.priceTier,
    accreditations: row.accreditations,
    descriptionEn: row.descriptionEn,
    descriptionAr: row.descriptionAr,
    isActive: row.isActive,
  };
}

function toSummary(row: ProviderRow): ProviderSummary {
  const p = toProvider(row);
  return {
    id: p.id,
    kind: p.kind,
    nameEn: p.nameEn,
    nameAr: p.nameAr,
    specialties: p.specialties,
    city: p.city,
    country: p.country,
    languages: p.languages,
    emergencyCapable: p.emergencyCapable,
    telemedicine: p.telemedicine,
    acceptsInternational: p.acceptsInternational,
    rating: p.rating,
    priceTier: p.priceTier,
  };
}

export class PostgresProviderRepository implements ProviderRepository {
  constructor(private readonly db: Db) {}

  async search(query: ProviderSearch): Promise<{ results: ProviderSummary[]; total: number }> {
    const where = and(
      eq(providers.isActive, true),
      // `@>` (containment) is the GIN-indexable form of `specialty = ANY(specialties)`.
      arrayContains(providers.specialties, [query.specialty]),
      query.city !== undefined
        ? eq(sql`lower(${providers.city})`, query.city.toLowerCase())
        : undefined,
      query.country !== undefined ? eq(providers.country, query.country) : undefined,
      query.language !== undefined
        ? arrayContains(providers.languages, [query.language])
        : undefined,
      query.emergencyCapable !== undefined
        ? eq(providers.emergencyCapable, query.emergencyCapable)
        : undefined,
      query.telemedicine !== undefined ? eq(providers.telemedicine, query.telemedicine) : undefined,
    );

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(providers)
        .where(where)
        .orderBy(desc(providers.rating), asc(providers.nameEn))
        .limit(query.limit),
      this.db.select({ total: sql<number>`count(*)::int` }).from(providers).where(where),
    ]);
    return { results: rows.map(toSummary), total };
  }

  async getById(id: string): Promise<Provider | null> {
    const [row] = await this.db.select().from(providers).where(eq(providers.id, id)).limit(1);
    return row ? toProvider(row) : null;
  }

  async getManyByIds(ids: string[]): Promise<ProviderSummary[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.select().from(providers).where(inArray(providers.id, ids));
    const byId = new Map(rows.map((row) => [row.id, toSummary(row)]));
    // Preserve the caller's order (the model's ranking); drop unknown ids.
    return ids.flatMap((id) => {
      const found = byId.get(id);
      return found ? [found] : [];
    });
  }
}

export class PostgresConversationRepository implements ConversationRepository {
  constructor(
    private readonly db: Db,
    private readonly providers: ProviderRepository,
  ) {}

  async create(locale: Locale): Promise<StoredConversation> {
    const [row] = await this.db.insert(conversations).values({ locale }).returning();
    return this.toConversation(row);
  }

  async get(id: string): Promise<StoredConversation | null> {
    const [row] = await this.db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    return row ? this.toConversation(row) : null;
  }

  async appendMessage(
    conversationId: string,
    role: MessageRole,
    content: unknown[],
  ): Promise<StoredMessage> {
    // seq is computed in the same statement; the unique (conversation_id, seq)
    // index turns a lost race into an error instead of a silent duplicate.
    const nextSeq = sql<number>`(select coalesce(max(${messages.seq}), -1) + 1 from ${messages} where ${messages.conversationId} = ${conversationId})`;
    const [row] = await this.db
      .insert(messages)
      .values({ conversationId, role, content, seq: nextSeq })
      .returning();
    await this.db
      .update(conversations)
      .set({ updatedAt: sql`now()` })
      .where(eq(conversations.id, conversationId));
    return row;
  }

  async listMessages(conversationId: string): Promise<StoredMessage[]> {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.seq));
  }

  async recordToolCall(call: Omit<StoredToolCall, "id" | "createdAt">): Promise<StoredToolCall> {
    const [row] = await this.db.insert(toolCalls).values(call).returning();
    return row;
  }

  async listToolCalls(conversationId: string): Promise<StoredToolCall[]> {
    return this.db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.conversationId, conversationId))
      .orderBy(asc(toolCalls.createdAt), asc(toolCalls.id));
  }

  async saveRecommendation(rec: NewRecommendation): Promise<Recommendation> {
    const [row] = await this.db
      .insert(recommendations)
      .values({
        conversationId: rec.conversationId,
        nextStep: rec.nextStep,
        urgency: rec.urgency,
        specialty: rec.specialty,
        providerIds: rec.providerIds,
        rationale: rec.rationale,
        questionsRemaining: rec.questionsRemaining,
      })
      .returning();
    return this.hydrate(row);
  }

  async listRecommendations(conversationId: string): Promise<Recommendation[]> {
    const rows = await this.db
      .select()
      .from(recommendations)
      .where(eq(recommendations.conversationId, conversationId))
      .orderBy(asc(recommendations.createdAt), asc(recommendations.id));
    return Promise.all(rows.map((row) => this.hydrate(row)));
  }

  async tryAcquireTurnLock(conversationId: string, ttlMs: number): Promise<boolean> {
    // Single atomic UPDATE: only one concurrent caller can see the row unlocked.
    const updated = await this.db
      .update(conversations)
      .set({ turnLockedUntil: sql`now() + make_interval(secs => ${ttlMs / 1000})` })
      .where(
        and(
          eq(conversations.id, conversationId),
          or(isNull(conversations.turnLockedUntil), lt(conversations.turnLockedUntil, sql`now()`)),
        ),
      )
      .returning({ id: conversations.id });
    return updated.length > 0;
  }

  async releaseTurnLock(conversationId: string): Promise<void> {
    await this.db
      .update(conversations)
      .set({ turnLockedUntil: null })
      .where(eq(conversations.id, conversationId));
  }

  private async hydrate(row: typeof recommendations.$inferSelect): Promise<Recommendation> {
    return {
      id: row.id,
      nextStep: row.nextStep,
      urgency: row.urgency,
      specialty: row.specialty,
      rationale: row.rationale,
      providers: await this.providers.getManyByIds(row.providerIds),
      questionsRemaining: row.questionsRemaining,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toConversation(row: typeof conversations.$inferSelect): StoredConversation {
    return {
      id: row.id,
      locale: row.locale,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

export function createPostgresRepositories(db: Db): Repositories {
  const providerRepo = new PostgresProviderRepository(db);
  return {
    kind: "postgres",
    providers: providerRepo,
    conversations: new PostgresConversationRepository(db, providerRepo),
  };
}
