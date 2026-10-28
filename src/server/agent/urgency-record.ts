/**
 * The urgency the deterministic rule engine last decided for this conversation.
 *
 * `recommend_next_step` must store exactly that value (docs/AGENT.md: "the
 * stored `urgency` is the engine's"); the executor checks it here instead of
 * trusting the model. Like `GroundingSet`, the record is rebuilt from the
 * persisted `tool_calls` audit trail on every turn, so it survives restarts and
 * multi-instance deployments. The latest successful `assess_urgency` wins,
 * which is what lets the model escalate by calling the engine again with new
 * facts, but never by asserting a different urgency itself.
 */
import { z } from "zod";
import { URGENCY_LEVELS, type Urgency } from "@/shared/contracts";
import type { StoredToolCall } from "@/server/repositories/types";

export const URGENCY_TOOL_NAME = "assess_urgency";

const outputSchema = z.object({ urgency: z.enum(URGENCY_LEVELS) });

export class UrgencyRecord {
  private urgency: Urgency | null = null;

  /** The engine's latest decision, or null when `assess_urgency` has not run successfully. */
  get latest(): Urgency | null {
    return this.urgency;
  }

  record(urgency: Urgency): void {
    this.urgency = urgency;
  }

  static fromToolCalls(calls: readonly StoredToolCall[]): UrgencyRecord {
    const record = new UrgencyRecord();
    // Tolerant like the grounding set: a malformed row contributes nothing rather than crashing a turn.
    for (const call of calls) {
      if (call.isError || call.toolName !== URGENCY_TOOL_NAME) continue;
      const parsed = outputSchema.safeParse(call.output);
      if (parsed.success) record.record(parsed.data.urgency);
    }
    return record;
  }
}
