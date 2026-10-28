/**
 * Agent tools: definitions sent to Claude (strict JSON schema) and the
 * executors that run them server-side.
 *
 * Every executor validates its input with zod *again* even though the API
 * enforces the JSON schema (`strict: true`): the SDK's tolerant JSON parser
 * can hand back a truncated-but-valid object, and defence in depth is cheap.
 * Executors never throw for expected failures; they return `ok: false` so the
 * model gets an `is_error` tool_result and can recover.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  LANGUAGES,
  NEXT_STEPS,
  RED_FLAGS,
  SPECIALTIES,
  URGENCY_LEVELS,
  providerSearchSchema,
  type Locale,
  type Recommendation,
} from "@/shared/contracts";
import { assessUrgency, triageInputSchema } from "@/server/triage";
import type { Repositories } from "@/server/repositories/types";
import type { GroundingSet } from "@/server/agent/grounding";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const TOOL_NAMES = [
  "assess_urgency",
  "search_providers",
  "get_provider_details",
  "recommend_next_step",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolContext = {
  conversationId: string;
  repos: Repositories;
  grounding: GroundingSet;
  locale: Locale;
};

export type ToolExecution =
  | {
      ok: true;
      /** JSON-serialisable payload sent back to the model. */
      output: unknown;
      /** Short human string for UI chips, e.g. "3 providers found". */
      summary: string;
      /** Set by `recommend_next_step` so the loop can emit the event without re-querying. */
      recommendation?: Recommendation;
    }
  | { ok: false; error: string; summary: string };

type InputSchema = Anthropic.Beta.BetaTool.InputSchema;

type RegisteredTool = {
  name: ToolName;
  definition: Anthropic.Beta.BetaTool;
  execute: (rawInput: unknown, ctx: ToolContext) => Promise<ToolExecution>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** zod issues -> one line the model can act on ("symptoms: Too small; age: ..."). */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

const enumProp = (values: readonly string[], description: string) => ({
  type: "string",
  enum: [...values],
  description,
});

/**
 * Binds a zod schema to a JSON schema and an executor. Validation happens here
 * so the registry can hold tools with different input types without `any`.
 */
function defineTool<S extends z.ZodType>(spec: {
  name: ToolName;
  description: string;
  inputSchema: S;
  jsonSchema: InputSchema;
  run: (input: z.output<S>, ctx: ToolContext) => Promise<ToolExecution>;
}): RegisteredTool {
  return {
    name: spec.name,
    definition: {
      name: spec.name,
      description: spec.description,
      input_schema: spec.jsonSchema,
      strict: true,
    },
    execute: async (rawInput, ctx) => {
      const parsed = spec.inputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return {
          ok: false,
          error: `Invalid input for ${spec.name}: ${formatIssues(parsed.error)}`,
          summary: "Invalid tool input",
        };
      }
      return spec.run(parsed.data, ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// assess_urgency
// ---------------------------------------------------------------------------

const assessUrgencyTool = defineTool({
  name: "assess_urgency",
  description:
    "Deterministic triage rule engine. Call it as soon as you know the main symptom(s); call it again if new " +
    "red flags or facts appear. You extract the facts, the engine decides the urgency - never decide urgency " +
    "yourself. Returns { urgency, must_call_emergency_services, matched_rules, suggested_specialties }. " +
    "If must_call_emergency_services is true you must immediately call recommend_next_step with " +
    "next_step 'emergency_now' and ask no further questions.",
  inputSchema: triageInputSchema,
  jsonSchema: {
    type: "object",
    properties: {
      symptoms: {
        type: "array",
        description: "Main complaints in plain English, e.g. ['chest pain', 'shortness of breath']. 1-10 items.",
        items: { type: "string" },
      },
      red_flags: {
        type: "array",
        description: "Red flags the patient explicitly reported. Empty if none.",
        items: enumProp(RED_FLAGS, "A red-flag symptom or risk factor."),
      },
      duration_hours: { type: "number", description: "How long the symptom has been present, in hours." },
      severity_1_to_10: { type: "integer", description: "Patient-reported severity, 1 (mild) to 10 (worst)." },
      age: { type: "integer", description: "Patient age in years, if known." },
    },
    required: ["symptoms", "red_flags"],
    additionalProperties: false,
  },
  run: async (input) => {
    const result = assessUrgency(input);
    const output = {
      urgency: result.urgency,
      must_call_emergency_services: result.mustCallEmergencyServices,
      matched_rules: result.matchedRules,
      suggested_specialties: result.suggestedSpecialties,
    };
    const summary = result.mustCallEmergencyServices
      ? "emergency - call emergency services"
      : `${result.urgency} - ${result.suggestedSpecialties[0] ?? "general_practice"}`;
    return { ok: true, output, summary };
  },
});

// ---------------------------------------------------------------------------
// search_providers
// ---------------------------------------------------------------------------

const searchProvidersInput = z.object({
  specialty: z.enum(SPECIALTIES),
  city: z.string().trim().min(1).max(80).optional(),
  country: z.string().trim().length(2).optional(),
  language: z.enum(LANGUAGES).optional(),
  emergency_capable: z.boolean().optional(),
  telemedicine: z.boolean().optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

function describeSearch(input: z.output<typeof searchProvidersInput>): string {
  const parts: string[] = [input.specialty];
  if (input.city) parts.push(`in ${input.city}`);
  if (input.country) parts.push(`(${input.country.toUpperCase()})`);
  if (input.language) parts.push(`speaking ${input.language}`);
  if (input.emergency_capable) parts.push("emergency-capable");
  if (input.telemedicine) parts.push("telemedicine");
  return parts.join(" ");
}

const searchProvidersTool = defineTool({
  name: "search_providers",
  description:
    "Searches the HealTrip provider database (hospitals, clinics, doctors). This is the ONLY source of " +
    "provider information you have; you know nothing about providers otherwise. Returns { results, total, note? } " +
    "where each result has id, kind, nameEn, nameAr, specialties, city, country, languages, emergencyCapable, " +
    "telemedicine, acceptsInternational, rating and priceTier. Use the ids from results when calling " +
    "get_provider_details or recommend_next_step. If results is empty, say so and widen the search " +
    "(drop city/country, try telemedicine) or ask the patient - never invent a provider.",
  inputSchema: searchProvidersInput,
  jsonSchema: {
    type: "object",
    properties: {
      specialty: enumProp(SPECIALTIES, "Medical specialty to search for."),
      city: { type: "string", description: "City name, e.g. 'Istanbul'. Case-insensitive." },
      country: { type: "string", description: "ISO-3166 alpha-2 country code, e.g. 'TR'." },
      language: enumProp(LANGUAGES, "Language the provider must speak (ISO-639-1)."),
      emergency_capable: { type: "boolean", description: "Only providers with an emergency department." },
      telemedicine: { type: "boolean", description: "Only providers offering video consultations." },
      limit: { type: "integer", description: "Max results, 1-20 (default 10)." },
    },
    required: ["specialty"],
    additionalProperties: false,
  },
  run: async (input, ctx) => {
    const query = providerSearchSchema.parse({
      specialty: input.specialty,
      city: input.city,
      country: input.country,
      language: input.language,
      emergencyCapable: input.emergency_capable,
      telemedicine: input.telemedicine,
      limit: input.limit,
    });
    const { results, total } = await ctx.repos.providers.search(query);
    ctx.grounding.add(results.map((p) => p.id));
    if (results.length === 0) {
      return {
        ok: true,
        output: {
          results,
          total,
          note:
            `No active providers match ${describeSearch(input)}. Do not invent one. Tell the patient, then ` +
            "either widen the search (drop the city or country filter, set telemedicine to true, or try a " +
            "related specialty) or ask where they are able to travel.",
        },
        summary: "No providers found",
      };
    }
    const summary = results.length === 1 ? "1 provider found" : `${results.length} providers found`;
    return { ok: true, output: { results, total }, summary };
  },
});

// ---------------------------------------------------------------------------
// get_provider_details
// ---------------------------------------------------------------------------

const getProviderDetailsTool = defineTool({
  name: "get_provider_details",
  description:
    "Returns the full record of one provider (adds parentProviderId, accreditations and a short description " +
    "to the search fields). provider_id must be an id returned by search_providers in this conversation. " +
    "Use it when the patient asks about a specific provider or you need details to justify a choice.",
  inputSchema: z.object({ provider_id: z.string().uuid() }),
  jsonSchema: {
    type: "object",
    properties: {
      provider_id: { type: "string", format: "uuid", description: "Provider id from search_providers results." },
    },
    required: ["provider_id"],
    additionalProperties: false,
  },
  run: async (input, ctx) => {
    const provider = await ctx.repos.providers.getById(input.provider_id);
    if (!provider || !provider.isActive) {
      return {
        ok: false,
        error: `No active provider with id ${input.provider_id}. Only use ids returned by search_providers.`,
        summary: "Provider not found",
      };
    }
    ctx.grounding.add([provider.id]);
    return {
      ok: true,
      output: provider,
      summary: ctx.locale === "ar" ? provider.nameAr : provider.nameEn,
    };
  },
});

// ---------------------------------------------------------------------------
// recommend_next_step
// ---------------------------------------------------------------------------

const MAX_RECOMMENDED_PROVIDERS = 3;

const recommendNextStepInput = z.object({
  next_step: z.enum(NEXT_STEPS),
  urgency: z.enum(URGENCY_LEVELS),
  specialty: z.enum(SPECIALTIES).nullable(),
  provider_ids: z.array(z.string().uuid()).max(MAX_RECOMMENDED_PROVIDERS),
  rationale_for_patient: z.string().trim().min(20).max(1200),
  questions_remaining: z.array(z.string().trim().min(1).max(200)).max(3).default([]),
});

const recommendNextStepTool = defineTool({
  name: "recommend_next_step",
  description:
    "Records the final recommendation for the patient. This is the ONLY way to give a final answer; free text " +
    "is treated as an interim message. Call it once per decision, after assess_urgency and (unless the case is " +
    "an emergency or self-care) after search_providers. urgency must be the value assess_urgency returned. " +
    "provider_ids may only contain ids returned by search_providers or get_provider_details in this " +
    "conversation (0-3 ids); anything else is rejected. rationale_for_patient is shown to the patient verbatim " +
    "in their language: explain the step in plain words, name the chosen providers (name and id), and end with " +
    "a one-line note that this is not medical advice. Returns { ok, recommendation_id } or an error listing " +
    "the allowed provider ids.",
  inputSchema: recommendNextStepInput,
  jsonSchema: {
    type: "object",
    properties: {
      next_step: enumProp(
        NEXT_STEPS,
        "emergency_now: call emergency services now; urgent_care_24h: be seen within 24h; " +
          "specialist_consultation: book a specialist; second_opinion: review of an existing diagnosis/plan; " +
          "primary_care: see a GP first; self_care_monitor: rest, monitor, return if worse.",
      ),
      urgency: enumProp(URGENCY_LEVELS, "The urgency returned by assess_urgency."),
      specialty: {
        anyOf: [enumProp(SPECIALTIES, "Specialty the patient should see."), { type: "null" }],
        description: "Specialty the patient should see, or null when no specialist is needed.",
      },
      provider_ids: {
        type: "array",
        description: "0-3 provider ids returned by search_providers/get_provider_details in this conversation.",
        items: { type: "string", format: "uuid" },
      },
      rationale_for_patient: {
        type: "string",
        description: "20-1200 characters, in the patient's language, ending with a not-medical-advice note.",
      },
      questions_remaining: {
        type: "array",
        description: "Up to 3 things the patient should still clarify with a clinician. Empty if none.",
        items: { type: "string" },
      },
    },
    required: ["next_step", "urgency", "specialty", "provider_ids", "rationale_for_patient"],
    additionalProperties: false,
  },
  run: async (input, ctx) => {
    const providerIds = [...new Set(input.provider_ids)];
    const unknown = providerIds.filter((id) => !ctx.grounding.has(id));
    if (unknown.length > 0) {
      return {
        ok: false,
        error:
          `Unknown provider ids: [${unknown.join(", ")}]. You may only recommend providers returned by ` +
          `search_providers/get_provider_details in this conversation. Allowed ids: [${ctx.grounding
            .allowedIds()
            .join(", ")}]`,
        summary: "Rejected: unknown provider ids",
      };
    }
    // The step and the urgency must agree on emergencies: a stored record saying
    // "emergency" but "book a specialist" would be dangerous either way.
    const emergencyStep = input.next_step === "emergency_now";
    const emergencyUrgency = input.urgency === "emergency";
    if (emergencyStep !== emergencyUrgency) {
      return {
        ok: false,
        error:
          "next_step 'emergency_now' and urgency 'emergency' must be used together. Use the urgency returned " +
          "by assess_urgency and pick the matching next_step.",
        summary: "Rejected: urgency and next step disagree",
      };
    }
    const recommendation = await ctx.repos.conversations.saveRecommendation({
      conversationId: ctx.conversationId,
      nextStep: input.next_step,
      urgency: input.urgency,
      specialty: input.specialty,
      providerIds,
      rationale: input.rationale_for_patient,
      questionsRemaining: input.questions_remaining,
    });
    return {
      ok: true,
      output: { ok: true, recommendation_id: recommendation.id },
      summary: "Recommendation saved",
      recommendation,
    };
  },
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Fixed order: the tool list is part of the cached prompt prefix, so any
 * reordering between requests would invalidate the prompt cache.
 */
const TOOLS: readonly RegisteredTool[] = [
  assessUrgencyTool,
  searchProvidersTool,
  getProviderDetailsTool,
  recommendNextStepTool,
];

const TOOLS_BY_NAME: ReadonlyMap<string, RegisteredTool> = new Map(TOOLS.map((t) => [t.name, t]));

export const TOOL_DEFINITIONS: readonly Anthropic.Beta.BetaTool[] = TOOLS.map((t) => t.definition);

/**
 * Validates and runs one tool. Never throws: infrastructure failures become
 * `ok: false` with a short reason (no stack traces reach the model).
 */
export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolExecution> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) {
    return { ok: false, error: `Unknown tool '${name}'.`, summary: "Unknown tool" };
  }
  try {
    return await tool.execute(rawInput, ctx);
  } catch (err) {
    // Driver errors can embed connection details; log them server-side only.
    console.error(JSON.stringify({ event: "agent.tool_failed", conversationId: ctx.conversationId, tool: name, error: String(err) }));
    return {
      ok: false,
      error: `${name} failed because of a temporary server problem. You may retry once or tell the patient.`,
      summary: "Tool failed",
    };
  }
}
