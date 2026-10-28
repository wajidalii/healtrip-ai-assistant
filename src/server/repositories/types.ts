/**
 * Repository interfaces. Two implementations exist: Postgres (Drizzle) and
 * in-memory (tests and zero-setup demo). Both must behave identically; the
 * shared test suite in tests/repositories.test.ts enforces that.
 */
import type {
  Locale,
  NextStep,
  Provider,
  ProviderSearch,
  ProviderSummary,
  Recommendation,
  Specialty,
  Urgency,
} from "@/shared/contracts";

export type MessageRole = "user" | "assistant";

/** A persisted conversation turn. `content` is the Anthropic content block array, verbatim. */
export type StoredMessage = {
  id: string;
  conversationId: string;
  seq: number;
  role: MessageRole;
  content: unknown[];
  createdAt: Date;
};

export type StoredToolCall = {
  id: string;
  conversationId: string;
  toolUseId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  isError: boolean;
  latencyMs: number;
  createdAt: Date;
};

export type StoredConversation = {
  id: string;
  locale: Locale;
  status: "open" | "closed";
  createdAt: Date;
  updatedAt: Date;
};

export type NewRecommendation = {
  conversationId: string;
  nextStep: NextStep;
  urgency: Urgency;
  specialty: Specialty | null;
  providerIds: string[];
  rationale: string;
  questionsRemaining: string[];
};

export interface ProviderRepository {
  search(query: ProviderSearch): Promise<{ results: ProviderSummary[]; total: number }>;
  getById(id: string): Promise<Provider | null>;
  getManyByIds(ids: string[]): Promise<ProviderSummary[]>;
}

export interface ConversationRepository {
  create(locale: Locale): Promise<StoredConversation>;
  get(id: string): Promise<StoredConversation | null>;
  /** Appends a turn; `seq` is assigned by the repository (monotonic per conversation). */
  appendMessage(conversationId: string, role: MessageRole, content: unknown[]): Promise<StoredMessage>;
  listMessages(conversationId: string): Promise<StoredMessage[]>;
  recordToolCall(call: Omit<StoredToolCall, "id" | "createdAt">): Promise<StoredToolCall>;
  listToolCalls(conversationId: string): Promise<StoredToolCall[]>;
  /** Persists a validated recommendation and returns it hydrated with provider summaries. */
  saveRecommendation(rec: NewRecommendation): Promise<Recommendation>;
  listRecommendations(conversationId: string): Promise<Recommendation[]>;
  /** Returns false if another turn is already running for this conversation. */
  tryAcquireTurnLock(conversationId: string, ttlMs: number): Promise<boolean>;
  releaseTurnLock(conversationId: string): Promise<void>;
}

export type Repositories = {
  kind: "memory" | "postgres";
  providers: ProviderRepository;
  conversations: ConversationRepository;
};
