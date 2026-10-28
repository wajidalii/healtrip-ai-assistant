/**
 * Shared contracts between the server layer and the UI.
 *
 * This file is the single source of truth for enumerations, DTOs and the
 * streaming event union. It must stay free of server-only imports so the
 * browser bundle can use it.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Enumerations (used by the DB schema, zod schemas and tool JSON schemas)
// ---------------------------------------------------------------------------

export const LOCALES = ["en", "ar"] as const;
export type Locale = (typeof LOCALES)[number];

export const PROVIDER_KINDS = ["hospital", "clinic", "doctor"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const SPECIALTIES = [
  "cardiology",
  "neurology",
  "orthopedics",
  "oncology",
  "dermatology",
  "gastroenterology",
  "general_practice",
  "emergency_medicine",
  "pediatrics",
  "psychiatry",
  "ophthalmology",
  "dentistry",
  "pulmonology",
  "endocrinology",
] as const;
export type Specialty = (typeof SPECIALTIES)[number];

export const LANGUAGES = ["en", "ar", "tr", "de", "fr"] as const;
export type Language = (typeof LANGUAGES)[number];

export const PRICE_TIERS = ["low", "mid", "high"] as const;
export type PriceTier = (typeof PRICE_TIERS)[number];

export const URGENCY_LEVELS = ["emergency", "urgent", "routine", "self_care"] as const;
export type Urgency = (typeof URGENCY_LEVELS)[number];

export const NEXT_STEPS = [
  "emergency_now",
  "urgent_care_24h",
  "specialist_consultation",
  "second_opinion",
  "primary_care",
  "self_care_monitor",
] as const;
export type NextStep = (typeof NEXT_STEPS)[number];

/** Red flags the model can extract from the patient's description. */
export const RED_FLAGS = [
  "shortness_of_breath",
  "pain_radiating_arm_or_jaw",
  "sweating_or_nausea_with_pain",
  "fainting_or_near_fainting",
  "face_droop",
  "arm_weakness",
  "speech_difficulty",
  "sudden_severe_headache",
  "severe_bleeding",
  "difficulty_breathing",
  "high_fever_with_stiff_neck",
  "suicidal_thoughts",
  "pregnancy",
  "known_heart_disease",
  "vision_loss",
  "severe_abdominal_pain",
] as const;
export type RedFlag = (typeof RED_FLAGS)[number];

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export const providerSummarySchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(PROVIDER_KINDS),
  nameEn: z.string(),
  nameAr: z.string(),
  specialties: z.array(z.enum(SPECIALTIES)),
  city: z.string(),
  country: z.string().length(2),
  languages: z.array(z.enum(LANGUAGES)),
  emergencyCapable: z.boolean(),
  telemedicine: z.boolean(),
  acceptsInternational: z.boolean(),
  rating: z.number().min(0).max(5),
  priceTier: z.enum(PRICE_TIERS),
});
export type ProviderSummary = z.infer<typeof providerSummarySchema>;

export const providerSchema = providerSummarySchema.extend({
  parentProviderId: z.string().uuid().nullable(),
  accreditations: z.array(z.string()),
  descriptionEn: z.string(),
  descriptionAr: z.string(),
  isActive: z.boolean(),
});
export type Provider = z.infer<typeof providerSchema>;

export const providerSearchSchema = z.object({
  specialty: z.enum(SPECIALTIES),
  city: z.string().trim().min(1).max(80).optional(),
  country: z.string().trim().length(2).toUpperCase().optional(),
  language: z.enum(LANGUAGES).optional(),
  emergencyCapable: z.boolean().optional(),
  telemedicine: z.boolean().optional(),
  limit: z.number().int().min(1).max(20).default(10),
});
export type ProviderSearch = z.infer<typeof providerSearchSchema>;

export const recommendationSchema = z.object({
  id: z.string().uuid(),
  nextStep: z.enum(NEXT_STEPS),
  urgency: z.enum(URGENCY_LEVELS),
  specialty: z.enum(SPECIALTIES).nullable(),
  rationale: z.string(),
  providers: z.array(providerSummarySchema),
  questionsRemaining: z.array(z.string()),
  createdAt: z.string(),
});
export type Recommendation = z.infer<typeof recommendationSchema>;

// ---------------------------------------------------------------------------
// HTTP request/response shapes
// ---------------------------------------------------------------------------

export const createConversationSchema = z.object({
  locale: z.enum(LOCALES).default("en"),
});

export const postMessageSchema = z.object({
  content: z.string().trim().min(1).max(2000),
  locale: z.enum(LOCALES).default("en"),
});
export type PostMessageInput = z.infer<typeof postMessageSchema>;

export type ToolCallView = {
  id: string;
  name: string;
  ok: boolean;
  summary: string;
};

export type ConversationMessageView =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      toolCalls: ToolCallView[];
      recommendation: Recommendation | null;
    };

export type ConversationView = {
  id: string;
  locale: Locale;
  messages: ConversationMessageView[];
};

export type ApiErrorCode =
  | "validation_error"
  | "not_found"
  | "rate_limited"
  | "payload_too_large"
  | "turn_in_progress"
  | "upstream_error"
  | "internal_error";

export type ApiErrorBody = {
  error: { code: ApiErrorCode; message: string; details?: unknown };
};

// ---------------------------------------------------------------------------
// Streaming events (SSE) emitted by the agent loop
// ---------------------------------------------------------------------------

export type AgentErrorCode =
  | "step_limit"
  | "max_tokens"
  | "refusal"
  | "upstream_error"
  | "internal_error";

export type AgentEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string }
  | { type: "recommendation"; recommendation: Recommendation }
  | {
      type: "done";
      stopReason: string;
      usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number };
    }
  | { type: "error"; code: AgentErrorCode; message: string; retryable: boolean };

export type AgentEventType = AgentEvent["type"];
