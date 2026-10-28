import { describe, expect, it } from "vitest";
import { GroundingSet, extractProviderIds } from "@/server/agent/grounding";
import type { StoredToolCall } from "@/server/repositories/types";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

function call(
  toolName: string,
  output: unknown,
  isError = false,
): StoredToolCall {
  return {
    id: crypto.randomUUID(),
    conversationId: "conv",
    toolUseId: `toolu_${toolName}`,
    toolName,
    input: {},
    output,
    isError,
    latencyMs: 1,
    createdAt: new Date(),
  };
}

describe("GroundingSet", () => {
  it("starts empty and records ids in insertion order without duplicates", () => {
    const set = new GroundingSet();
    expect(set.size).toBe(0);
    expect(set.allowedIds()).toEqual([]);
    set.add([A, B]);
    set.add([B, C]);
    expect(set.has(A)).toBe(true);
    expect(set.has("nope")).toBe(false);
    expect(set.allowedIds()).toEqual([A, B, C]);
    expect(set.size).toBe(3);
  });

  it("rebuilds from search_providers and get_provider_details outputs", () => {
    const set = GroundingSet.fromToolCalls([
      call("search_providers", { results: [{ id: A, nameEn: "x" }, { id: B }], total: 2 }),
      call("get_provider_details", { id: C, nameEn: "y", isActive: true }),
    ]);
    expect(set.allowedIds()).toEqual([A, B, C]);
  });

  it("ignores failed calls, other tools and malformed outputs", () => {
    const set = GroundingSet.fromToolCalls([
      call("search_providers", { error: "boom" }, true),
      call("search_providers", { results: [{ id: A }] }, true),
      call("recommend_next_step", { ok: true, recommendation_id: B }),
      call("assess_urgency", { urgency: "urgent" }),
      call("search_providers", null),
      call("search_providers", "not an object"),
      call("search_providers", { results: "not an array" }),
      call("get_provider_details", { id: 42 }),
    ]);
    expect(set.allowedIds()).toEqual([]);
  });
});

describe("extractProviderIds", () => {
  it("handles both output shapes and returns [] otherwise", () => {
    expect(extractProviderIds({ results: [{ id: A }], total: 1 })).toEqual([A]);
    expect(extractProviderIds({ results: [], total: 0 })).toEqual([]);
    expect(extractProviderIds({ id: B })).toEqual([B]);
    expect(extractProviderIds(undefined)).toEqual([]);
    expect(extractProviderIds([A])).toEqual([]);
  });
});
