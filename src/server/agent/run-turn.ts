/**
 * The agent loop. See docs/AGENT.md and docs/ARCHITECTURE.md.
 *
 * NOTE: this file is a signature stub so that HTTP adapters and tests can be
 * written in parallel; issue #5 replaces the body.
 */
import type { AgentEvent, Locale } from "@/shared/contracts";
import type { Repositories } from "@/server/repositories/types";
import type { ClaudeClient } from "@/server/agent/claude";

export type RunTurnInput = {
  conversationId: string;
  userText: string;
  locale: Locale;
  deps: {
    repos: Repositories;
    client: ClaudeClient;
    model: string;
    effort: "low" | "medium" | "high" | "xhigh" | "max";
    maxSteps: number;
    /** Optional abort signal from the HTTP request. */
    signal?: AbortSignal;
  };
};

/**
 * Runs one user turn: persists the user message, calls Claude in a loop with
 * tools, persists every assistant/tool turn verbatim, and yields AgentEvents.
 * Always ends with exactly one `done` or `error` event and never throws for
 * expected failures.
 */
export async function* runTurn(_input: RunTurnInput): AsyncGenerator<AgentEvent> {
  yield { type: "error", code: "internal_error", message: "runTurn not implemented", retryable: false };
}
