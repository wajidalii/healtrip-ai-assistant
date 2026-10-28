/**
 * In-memory repositories. Used for tests and for the zero-setup demo when
 * DATABASE_URL is unset. Semantics mirror postgres.ts exactly; the shared
 * suite in tests/repositories.test.ts runs against both.
 */
import { randomUUID } from "node:crypto";
import type {
  Locale,
  Provider,
  ProviderSearch,
  ProviderSummary,
  Recommendation,
} from "@/shared/contracts";
import { SEED_PROVIDERS } from "@/server/db/seed-data";
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

export function toSummary(p: Provider): ProviderSummary {
  return {
    id: p.id,
    kind: p.kind,
    nameEn: p.nameEn,
    nameAr: p.nameAr,
    specialties: [...p.specialties],
    city: p.city,
    country: p.country,
    languages: [...p.languages],
    emergencyCapable: p.emergencyCapable,
    telemedicine: p.telemedicine,
    acceptsInternational: p.acceptsInternational,
    rating: p.rating,
    priceTier: p.priceTier,
  };
}

/** Deterministic ordering shared with the SQL `ORDER BY rating DESC, name_en ASC`. */
function compareProviders(a: Provider, b: Provider): number {
  if (b.rating !== a.rating) return b.rating - a.rating;
  return a.nameEn < b.nameEn ? -1 : a.nameEn > b.nameEn ? 1 : 0;
}

export class MemoryProviderRepository implements ProviderRepository {
  private readonly byId: Map<string, Provider>;

  constructor(providers: readonly Provider[] = SEED_PROVIDERS) {
    this.byId = new Map(providers.map((p) => [p.id, structuredClone(p)]));
  }

  async search(query: ProviderSearch): Promise<{ results: ProviderSummary[]; total: number }> {
    const city = query.city?.toLowerCase();
    const matches = [...this.byId.values()]
      .filter(
        (p) =>
          p.isActive &&
          p.specialties.includes(query.specialty) &&
          (city === undefined || p.city.toLowerCase() === city) &&
          (query.country === undefined || p.country === query.country) &&
          (query.language === undefined || p.languages.includes(query.language)) &&
          (query.emergencyCapable === undefined || p.emergencyCapable === query.emergencyCapable) &&
          (query.telemedicine === undefined || p.telemedicine === query.telemedicine),
      )
      .sort(compareProviders);
    return { results: matches.slice(0, query.limit).map(toSummary), total: matches.length };
  }

  async getById(id: string): Promise<Provider | null> {
    const found = this.byId.get(id);
    return found ? structuredClone(found) : null;
  }

  async getManyByIds(ids: string[]): Promise<ProviderSummary[]> {
    // Input order is preserved; unknown ids are skipped rather than failing.
    return ids.flatMap((id) => {
      const found = this.byId.get(id);
      return found ? [toSummary(found)] : [];
    });
  }
}

type ConversationRow = StoredConversation & { turnLockedUntil: number | null };

export class MemoryConversationRepository implements ConversationRepository {
  private readonly conversations = new Map<string, ConversationRow>();
  private readonly messages = new Map<string, StoredMessage[]>();
  private readonly toolCalls = new Map<string, StoredToolCall[]>();
  private readonly recommendations = new Map<string, Recommendation[]>();

  constructor(private readonly providers: ProviderRepository) {}

  async create(locale: Locale): Promise<StoredConversation> {
    const now = new Date();
    const row: ConversationRow = {
      id: randomUUID(),
      locale,
      status: "open",
      createdAt: now,
      updatedAt: now,
      turnLockedUntil: null,
    };
    this.conversations.set(row.id, row);
    this.messages.set(row.id, []);
    this.toolCalls.set(row.id, []);
    this.recommendations.set(row.id, []);
    return this.publicConversation(row);
  }

  async get(id: string): Promise<StoredConversation | null> {
    const row = this.conversations.get(id);
    return row ? this.publicConversation(row) : null;
  }

  async appendMessage(
    conversationId: string,
    role: MessageRole,
    content: unknown[],
  ): Promise<StoredMessage> {
    const row = this.requireConversation(conversationId);
    const list = this.messages.get(conversationId) ?? [];
    const message: StoredMessage = {
      id: randomUUID(),
      conversationId,
      seq: list.length,
      role,
      content: structuredClone(content),
      createdAt: new Date(),
    };
    list.push(message);
    this.messages.set(conversationId, list);
    row.updatedAt = message.createdAt;
    return structuredClone(message);
  }

  async listMessages(conversationId: string): Promise<StoredMessage[]> {
    return structuredClone(this.messages.get(conversationId) ?? []);
  }

  async recordToolCall(call: Omit<StoredToolCall, "id" | "createdAt">): Promise<StoredToolCall> {
    this.requireConversation(call.conversationId);
    const stored: StoredToolCall = { ...structuredClone(call), id: randomUUID(), createdAt: new Date() };
    this.toolCalls.get(call.conversationId)?.push(stored);
    return structuredClone(stored);
  }

  async listToolCalls(conversationId: string): Promise<StoredToolCall[]> {
    return structuredClone(this.toolCalls.get(conversationId) ?? []);
  }

  async saveRecommendation(rec: NewRecommendation): Promise<Recommendation> {
    this.requireConversation(rec.conversationId);
    const providers = await this.providers.getManyByIds(rec.providerIds);
    const stored: Recommendation = {
      id: randomUUID(),
      nextStep: rec.nextStep,
      urgency: rec.urgency,
      specialty: rec.specialty,
      rationale: rec.rationale,
      providers,
      questionsRemaining: [...rec.questionsRemaining],
      createdAt: new Date().toISOString(),
    };
    this.recommendations.get(rec.conversationId)?.push(stored);
    return structuredClone(stored);
  }

  async listRecommendations(conversationId: string): Promise<Recommendation[]> {
    return structuredClone(this.recommendations.get(conversationId) ?? []);
  }

  async tryAcquireTurnLock(conversationId: string, ttlMs: number): Promise<boolean> {
    const row = this.conversations.get(conversationId);
    if (!row) return false;
    const now = Date.now();
    if (row.turnLockedUntil !== null && row.turnLockedUntil >= now) return false;
    row.turnLockedUntil = now + ttlMs;
    return true;
  }

  async releaseTurnLock(conversationId: string): Promise<void> {
    const row = this.conversations.get(conversationId);
    if (row) row.turnLockedUntil = null;
  }

  private requireConversation(id: string): ConversationRow {
    const row = this.conversations.get(id);
    if (!row) throw new Error(`Conversation ${id} not found`);
    return row;
  }

  private publicConversation(row: ConversationRow): StoredConversation {
    return {
      id: row.id,
      locale: row.locale,
      status: row.status,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }
}

export function createMemoryRepositories(
  providers: readonly Provider[] = SEED_PROVIDERS,
): Repositories {
  const providerRepo = new MemoryProviderRepository(providers);
  return {
    kind: "memory",
    providers: providerRepo,
    conversations: new MemoryConversationRepository(providerRepo),
  };
}
