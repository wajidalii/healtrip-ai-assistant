import { beforeEach, describe, expect, it } from "vitest";
import {
  LANGUAGES,
  NEXT_STEPS,
  RED_FLAGS,
  SPECIALTIES,
  URGENCY_LEVELS,
} from "@/shared/contracts";
import { createMemoryRepositories } from "@/server/repositories/memory";
import type { Repositories } from "@/server/repositories/types";
import { GroundingSet } from "@/server/agent/grounding";
import { TOOL_DEFINITIONS, TOOL_NAMES, executeTool, type ToolContext } from "@/server/agent/tools";

const CARDIOLOGIST_ISTANBUL = "41d456cd-2271-48aa-a326-fbf9818757b3"; // Dr. Elif Kaya
const INACTIVE_DERMATOLOGIST = "485acef4-d0c4-4293-b244-d6e162a0a60b"; // Dr. Sarah Collins
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
const RATIONALE = "Please book a cardiology appointment within 24 hours. This is not medical advice.";

type JsonSchema = Record<string, unknown>;

/** Walks a property schema and returns its enum, looking through anyOf for nullable enums. */
function enumOf(schema: unknown): string[] | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const s = schema as JsonSchema;
  if (Array.isArray(s.enum)) return s.enum as string[];
  if (Array.isArray(s.items)) return undefined;
  if (s.items) return enumOf(s.items);
  if (Array.isArray(s.anyOf)) {
    for (const branch of s.anyOf) {
      const found = enumOf(branch);
      if (found) return found;
    }
  }
  return undefined;
}

function propertiesOf(toolName: string): Record<string, unknown> {
  const def = TOOL_DEFINITIONS.find((t) => t.name === toolName);
  if (!def) throw new Error(`missing tool ${toolName}`);
  return def.input_schema.properties as Record<string, unknown>;
}

describe("TOOL_DEFINITIONS", () => {
  it("has the four tools in a fixed order, strict, with additionalProperties false", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const def of TOOL_DEFINITIONS) {
      expect(def.strict).toBe(true);
      expect(def.input_schema.type).toBe("object");
      expect(def.input_schema.additionalProperties).toBe(false);
      expect(def.description?.length ?? 0).toBeGreaterThan(40);
      expect(def.eager_input_streaming).toBeUndefined();
    }
  });

  it("spells every enum exactly as the shared contracts", () => {
    const assess = propertiesOf("assess_urgency");
    expect(enumOf(assess.red_flags)).toEqual([...RED_FLAGS]);

    const search = propertiesOf("search_providers");
    expect(enumOf(search.specialty)).toEqual([...SPECIALTIES]);
    expect(enumOf(search.language)).toEqual([...LANGUAGES]);

    const recommend = propertiesOf("recommend_next_step");
    expect(enumOf(recommend.next_step)).toEqual([...NEXT_STEPS]);
    expect(enumOf(recommend.urgency)).toEqual([...URGENCY_LEVELS]);
    expect(enumOf(recommend.specialty)).toEqual([...SPECIALTIES]);
  });

  it("lists required fields that exist as properties", () => {
    for (const def of TOOL_DEFINITIONS) {
      const props = Object.keys(def.input_schema.properties as Record<string, unknown>);
      for (const key of def.input_schema.required ?? []) expect(props).toContain(key);
    }
  });
});

describe("executeTool", () => {
  let repos: Repositories;
  let ctx: ToolContext;

  beforeEach(async () => {
    repos = createMemoryRepositories();
    const conversation = await repos.conversations.create("en");
    ctx = { conversationId: conversation.id, repos, grounding: new GroundingSet(), locale: "en" };
  });

  it("rejects unknown tools and invalid input with ok:false", async () => {
    const unknown = await executeTool("nope", {}, ctx);
    expect(unknown.ok).toBe(false);

    const invalid = await executeTool("assess_urgency", { symptoms: [] }, ctx);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error).toContain("symptoms");
      expect(invalid.summary).toBe("Invalid tool input");
    }
  });

  describe("assess_urgency", () => {
    it("returns the engine result in snake_case with a chip summary", async () => {
      const res = await executeTool(
        "assess_urgency",
        { symptoms: ["chest pain"], red_flags: ["shortness_of_breath"] },
        ctx,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.output).toMatchObject({ urgency: "emergency", must_call_emergency_services: true });
      expect(res.summary).toBe("emergency - call emergency services");
    });

    it("summarises non-emergencies as urgency - specialty", async () => {
      const res = await executeTool(
        "assess_urgency",
        { symptoms: ["chest pain"], red_flags: [], severity_1_to_10: 8 },
        ctx,
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.summary).toMatch(/^urgent - /);
    });
  });

  describe("search_providers", () => {
    it("maps snake_case filters, returns summaries and grounds the ids", async () => {
      const res = await executeTool(
        "search_providers",
        { specialty: "cardiology", city: "istanbul", emergency_capable: false, limit: 5 },
        ctx,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const output = res.output as { results: { id: string; city: string }[]; total: number; note?: string };
      expect(output.results.length).toBeGreaterThan(0);
      expect(output.results.length).toBeLessThanOrEqual(5);
      expect(output.results.every((p) => p.city === "Istanbul")).toBe(true);
      expect(output.note).toBeUndefined();
      expect(res.summary).toMatch(/^\d+ providers? found$/);
      for (const p of output.results) expect(ctx.grounding.has(p.id)).toBe(true);
    });

    it("explains an empty result with a note and never invents", async () => {
      const res = await executeTool("search_providers", { specialty: "dentistry", city: "Atlantis" }, ctx);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const output = res.output as { results: unknown[]; total: number; note?: string };
      expect(output.results).toEqual([]);
      expect(output.total).toBe(0);
      expect(output.note).toMatch(/Do not invent/);
      expect(output.note).toContain("Atlantis");
      expect(res.summary).toBe("No providers found");
      expect(ctx.grounding.size).toBe(0);
    });

    it("rejects an unknown specialty", async () => {
      const res = await executeTool("search_providers", { specialty: "astrology" }, ctx);
      expect(res.ok).toBe(false);
    });
  });

  describe("get_provider_details", () => {
    it("returns the full record and grounds the id", async () => {
      const res = await executeTool("get_provider_details", { provider_id: CARDIOLOGIST_ISTANBUL }, ctx);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.output).toMatchObject({ id: CARDIOLOGIST_ISTANBUL, nameEn: "Dr. Elif Kaya" });
      expect(res.summary).toBe("Dr. Elif Kaya");
      expect(ctx.grounding.has(CARDIOLOGIST_ISTANBUL)).toBe(true);
    });

    it("uses the Arabic name as summary for ar locale", async () => {
      const res = await executeTool("get_provider_details", { provider_id: CARDIOLOGIST_ISTANBUL }, {
        ...ctx,
        locale: "ar",
      });
      expect(res.ok && res.summary).toBe("د. إيليف كايا");
    });

    it("fails for unknown or inactive providers without grounding them", async () => {
      const missing = await executeTool("get_provider_details", { provider_id: UNKNOWN_ID }, ctx);
      expect(missing.ok).toBe(false);
      const inactive = await executeTool("get_provider_details", { provider_id: INACTIVE_DERMATOLOGIST }, ctx);
      expect(inactive.ok).toBe(false);
      expect(ctx.grounding.size).toBe(0);
      const badFormat = await executeTool("get_provider_details", { provider_id: "abc" }, ctx);
      expect(badFormat.ok).toBe(false);
    });
  });

  describe("recommend_next_step", () => {
    const base = {
      next_step: "urgent_care_24h",
      urgency: "urgent",
      specialty: "cardiology",
      rationale_for_patient: RATIONALE,
    };

    it("rejects ungrounded provider ids and lists the allowed ones", async () => {
      ctx.grounding.add([CARDIOLOGIST_ISTANBUL]);
      const res = await executeTool("recommend_next_step", { ...base, provider_ids: [UNKNOWN_ID] }, ctx);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toContain(`Unknown provider ids: [${UNKNOWN_ID}]`);
      expect(res.error).toContain(`Allowed ids: [${CARDIOLOGIST_ISTANBUL}]`);
      expect(await repos.conversations.listRecommendations(ctx.conversationId)).toEqual([]);
    });

    it("saves a grounded recommendation, hydrates providers and attaches it", async () => {
      ctx.grounding.add([CARDIOLOGIST_ISTANBUL]);
      const res = await executeTool(
        "recommend_next_step",
        { ...base, provider_ids: [CARDIOLOGIST_ISTANBUL, CARDIOLOGIST_ISTANBUL], questions_remaining: ["Any allergies?"] },
        ctx,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.summary).toBe("Recommendation saved");
      expect(res.recommendation?.providers.map((p) => p.id)).toEqual([CARDIOLOGIST_ISTANBUL]);
      expect(res.recommendation?.questionsRemaining).toEqual(["Any allergies?"]);
      expect(res.output).toEqual({ ok: true, recommendation_id: res.recommendation?.id });
      const stored = await repos.conversations.listRecommendations(ctx.conversationId);
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe(res.recommendation?.id);
    });

    it("accepts zero providers and a null specialty (e.g. self-care)", async () => {
      const res = await executeTool(
        "recommend_next_step",
        {
          next_step: "self_care_monitor",
          urgency: "self_care",
          specialty: null,
          provider_ids: [],
          rationale_for_patient: RATIONALE,
        },
        ctx,
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.recommendation?.questionsRemaining).toEqual([]);
    });

    it("requires emergency_now and urgency emergency to agree", async () => {
      const mismatch = await executeTool(
        "recommend_next_step",
        { ...base, next_step: "emergency_now", provider_ids: [] },
        ctx,
      );
      expect(mismatch.ok).toBe(false);
      const mismatch2 = await executeTool(
        "recommend_next_step",
        { ...base, urgency: "emergency", provider_ids: [] },
        ctx,
      );
      expect(mismatch2.ok).toBe(false);
    });

    it("validates bounds: too many ids, short rationale, too many questions", async () => {
      ctx.grounding.add([CARDIOLOGIST_ISTANBUL]);
      const ids = Array.from({ length: 4 }, () => CARDIOLOGIST_ISTANBUL);
      expect((await executeTool("recommend_next_step", { ...base, provider_ids: ids }, ctx)).ok).toBe(false);
      expect(
        (await executeTool("recommend_next_step", { ...base, provider_ids: [], rationale_for_patient: "short" }, ctx))
          .ok,
      ).toBe(false);
      expect(
        (
          await executeTool(
            "recommend_next_step",
            { ...base, provider_ids: [], questions_remaining: ["a", "b", "c", "d"] },
            ctx,
          )
        ).ok,
      ).toBe(false);
    });
  });
});
