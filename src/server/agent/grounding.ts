/**
 * Grounding set: the provider ids the model has actually *seen* in this
 * conversation, i.e. ids returned by `search_providers` / `get_provider_details`.
 *
 * `recommend_next_step` may only reference ids in this set, which is the
 * server-side guarantee that a recommendation never points at an invented
 * provider (docs/AGENT.md, "Preventing hallucinated providers", layer 2 + 3).
 *
 * The set is rebuilt from the persisted `tool_calls` audit trail on every turn,
 * so it survives restarts and multi-instance deployments without extra state.
 */
import { z } from "zod";
import type { StoredToolCall } from "@/server/repositories/types";

/** Tools whose successful outputs contribute provider ids to the grounding set. */
export const GROUNDING_TOOL_NAMES = ["search_providers", "get_provider_details"] as const;

const searchOutputSchema = z.object({ results: z.array(z.object({ id: z.string() })) });
const detailsOutputSchema = z.object({ id: z.string() });

/**
 * Pulls provider ids out of a persisted tool output. Parsing is deliberately
 * tolerant: a row written by an older version of the tool (or a hand-edited
 * row) must never crash a turn, it simply contributes nothing.
 */
export function extractProviderIds(output: unknown): string[] {
  const search = searchOutputSchema.safeParse(output);
  if (search.success) return search.data.results.map((r) => r.id);
  const details = detailsOutputSchema.safeParse(output);
  if (details.success) return [details.data.id];
  return [];
}

export class GroundingSet {
  private readonly ids = new Set<string>();

  add(ids: Iterable<string>): void {
    for (const id of ids) this.ids.add(id);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** Insertion order, which matches the order the model first saw each id. */
  allowedIds(): string[] {
    return [...this.ids];
  }

  get size(): number {
    return this.ids.size;
  }

  static fromToolCalls(calls: readonly StoredToolCall[]): GroundingSet {
    const set = new GroundingSet();
    const grounding: readonly string[] = GROUNDING_TOOL_NAMES;
    for (const call of calls) {
      // Failed calls carry an error payload, never provider rows.
      if (call.isError || !grounding.includes(call.toolName)) continue;
      set.add(extractProviderIds(call.output));
    }
    return set;
  }
}
