/**
 * Drizzle schema: the source of truth for the Postgres database.
 * Enumerations are derived from src/shared/contracts.ts so the DB, the zod
 * schemas and the tool JSON schemas can never disagree.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  LANGUAGES,
  NEXT_STEPS,
  PRICE_TIERS,
  PROVIDER_KINDS,
  SPECIALTIES,
  URGENCY_LEVELS,
} from "@/shared/contracts";

export const providerKindEnum = pgEnum("provider_kind", PROVIDER_KINDS);
export const specialtyEnum = pgEnum("specialty", SPECIALTIES);
export const languageEnum = pgEnum("language", LANGUAGES);
export const priceTierEnum = pgEnum("price_tier", PRICE_TIERS);
export const urgencyEnum = pgEnum("urgency", URGENCY_LEVELS);
export const nextStepEnum = pgEnum("next_step", NEXT_STEPS);
export const localeEnum = pgEnum("locale", ["en", "ar"]);
export const conversationStatusEnum = pgEnum("conversation_status", ["open", "closed"]);
export const messageRoleEnum = pgEnum("message_role", ["user", "assistant"]);

export const providers = pgTable(
  "providers",
  {
    id: uuid("id").primaryKey(),
    kind: providerKindEnum("kind").notNull(),
    // Self-reference: doctors belong to a hospital or clinic.
    parentProviderId: uuid("parent_provider_id"),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar").notNull(),
    specialties: specialtyEnum("specialties").array().notNull(),
    city: text("city").notNull(),
    country: text("country").notNull(),
    languages: languageEnum("languages").array().notNull(),
    emergencyCapable: boolean("emergency_capable").notNull().default(false),
    telemedicine: boolean("telemedicine").notNull().default(false),
    acceptsInternational: boolean("accepts_international").notNull().default(true),
    rating: numeric("rating", { precision: 2, scale: 1, mode: "number" }).notNull(),
    priceTier: priceTierEnum("price_tier").notNull(),
    accreditations: text("accreditations").array().notNull().default([]),
    descriptionEn: text("description_en").notNull(),
    descriptionAr: text("description_ar").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("providers_city_idx").on(table.city),
    // GIN makes the `specialties @> ARRAY[$1]` containment filter indexable.
    index("providers_specialties_gin").using("gin", table.specialties),
  ],
);

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  locale: localeEnum("locale").notNull().default("en"),
  status: conversationStatusEnum("status").notNull().default("open"),
  /**
   * Turn lock: one in-flight agent turn per conversation. NULL or a past
   * timestamp means unlocked; the TTL guards against crashed turns.
   */
  turnLockedUntil: timestamp("turn_locked_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: messageRoleEnum("role").notNull(),
    // Anthropic content blocks, verbatim, so history replays byte-identically.
    content: jsonb("content").$type<unknown[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("messages_conversation_seq_uq").on(table.conversationId, table.seq)],
);

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    toolUseId: text("tool_use_id").notNull(),
    toolName: text("tool_name").notNull(),
    input: jsonb("input").$type<unknown>().notNull(),
    output: jsonb("output").$type<unknown>().notNull(),
    isError: boolean("is_error").notNull().default(false),
    latencyMs: integer("latency_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("tool_calls_conversation_idx").on(table.conversationId)],
);

export const recommendations = pgTable(
  "recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    nextStep: nextStepEnum("next_step").notNull(),
    urgency: urgencyEnum("urgency").notNull(),
    specialty: specialtyEnum("specialty"),
    providerIds: uuid("provider_ids").array().notNull().default([]),
    rationale: text("rationale").notNull(),
    questionsRemaining: jsonb("questions_remaining").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("recommendations_conversation_idx").on(table.conversationId)],
);

export const schema = { providers, conversations, messages, toolCalls, recommendations };
export type Schema = typeof schema;
