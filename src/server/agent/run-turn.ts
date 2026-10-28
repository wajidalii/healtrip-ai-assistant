/**
 * The agent loop. See docs/AGENT.md and docs/ARCHITECTURE.md.
 *
 * One user turn = persist the user message, then up to `maxSteps` model calls.
 * Each call streams text to the caller, is persisted verbatim, and either
 * ends the turn or requests tools, whose results are persisted and sent back.
 *
 * Invariants:
 * - exactly one terminal event (`done` or `error`), never a throw for expected failures;
 * - history is append-only and stored byte-identical to what the API returned;
 * - the turn lock is owned by the HTTP layer, nothing is released here.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AgentEvent, Locale } from "@/shared/contracts";
import type { Repositories } from "@/server/repositories/types";
import type { ClaudeClient, ClaudeStreamOptions, ClaudeStreamParams } from "@/server/agent/claude";
import { GroundingSet } from "@/server/agent/grounding";
import { buildSystem } from "@/server/agent/prompt";
import { TOOL_DEFINITIONS, executeTool, type ToolContext } from "@/server/agent/tools";

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

/** Chat turns are short; thinking counts toward this budget, so 4096 leaves room for tool calls. */
const MAX_TOKENS = 4096;
/** Required for the scalar `fallbacks: "default"` form (see docs/AGENT.md). */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

type ErrorEvent = Extract<AgentEvent, { type: "error" }>;
type ModelCallOutcome = { message: Anthropic.Beta.BetaMessage } | { error: ErrorEvent };

const errorEvent = (
  code: ErrorEvent["code"],
  message: string,
  retryable: boolean,
): ErrorEvent => ({ type: "error", code, message, retryable });

/** Maps SDK errors to a user-safe event; never leaks keys, URLs or stack traces. */
function classifyError(err: unknown): ErrorEvent {
  if (err instanceof Anthropic.AuthenticationError) {
    return errorEvent("upstream_error", "AI service is not configured", false);
  }
  if (err instanceof Anthropic.APIUserAbortError) {
    return errorEvent("internal_error", "Request was cancelled", false);
  }
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.APIConnectionError) {
    return errorEvent("upstream_error", "AI service is busy or unreachable; please try again", true);
  }
  if (err instanceof Anthropic.APIError) {
    const serverSide = typeof err.status === "number" && err.status >= 500;
    return serverSide
      ? errorEvent("upstream_error", "AI service failed; please try again", true)
      : errorEvent("upstream_error", "AI service rejected the request", false);
  }
  return errorEvent("internal_error", "Unexpected error while running the assistant", false);
}

/**
 * The SDK rejects `finalMessage()` with a plain `AnthropicError` (not an
 * `APIError`) when a tool input could not be parsed as JSON; that is the one
 * failure worth re-issuing the request for.
 */
const isToolJsonError = (err: unknown): boolean =>
  err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError);

/**
 * Persisted content is exactly what we sent to or received from the API
 * (see docs/DATABASE.md), so reading it back as content blocks is sound.
 */
const toMessageParam = (
  role: "user" | "assistant",
  content: unknown[],
): Anthropic.Beta.BetaMessageParam => ({
  role,
  content: content as Anthropic.Beta.BetaContentBlockParam[],
});

/**
 * One model call: yields text deltas as they arrive and returns the final
 * message, or an error event. Re-issues once on an unparseable tool input.
 */
async function* streamModel(
  client: ClaudeClient,
  params: ClaudeStreamParams,
  options: ClaudeStreamOptions | undefined,
): AsyncGenerator<AgentEvent, ModelCallOutcome> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const stream = client.beta.messages.stream(params, options);
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text_delta", text: event.delta.text };
        }
      }
      return { message: await stream.finalMessage() };
    } catch (err) {
      if (attempt === 0 && isToolJsonError(err)) continue;
      return { error: classifyError(err) };
    }
  }
}

/**
 * Runs one user turn: persists the user message, calls Claude in a loop with
 * tools, persists every assistant/tool turn verbatim, and yields AgentEvents.
 * Always ends with exactly one `done` or `error` event and never throws for
 * expected failures.
 */
export async function* runTurn(input: RunTurnInput): AsyncGenerator<AgentEvent> {
  const { conversationId, userText, locale, deps } = input;
  const { repos, client, signal } = deps;
  const conversations = repos.conversations;

  try {
    const conversation = await conversations.get(conversationId);
    if (!conversation) {
      yield errorEvent("internal_error", "Conversation not found", false);
      return;
    }

    const grounding = GroundingSet.fromToolCalls(await conversations.listToolCalls(conversationId));
    const history = await conversations.listMessages(conversationId);
    const messages = history.map((m) => toMessageParam(m.role, m.content));

    // Persist before pushing so a crash can never leave the API history ahead of the DB.
    const userBlocks: Anthropic.Beta.BetaContentBlockParam[] = [{ type: "text", text: userText }];
    await conversations.appendMessage(conversationId, "user", userBlocks);
    messages.push({ role: "user", content: userBlocks });

    const toolCtx: ToolContext = { conversationId, repos, grounding, locale };
    const system = buildSystem(locale);
    const streamOptions: ClaudeStreamOptions | undefined = signal ? { signal } : undefined;

    for (let step = 1; step <= deps.maxSteps; step += 1) {
      if (signal?.aborted) {
        yield errorEvent("internal_error", "Request was cancelled", false);
        return;
      }

      const startedAt = Date.now();
      const outcome = yield* streamModel(
        client,
        {
          model: deps.model,
          max_tokens: MAX_TOKENS,
          system,
          tools: [...TOOL_DEFINITIONS],
          messages,
          output_config: { effort: deps.effort },
          betas: [FALLBACK_BETA],
          fallbacks: "default",
        },
        streamOptions,
      );
      if ("error" in outcome) {
        yield outcome.error;
        return;
      }
      const { message } = outcome;
      const latencyMs = Date.now() - startedAt;

      await conversations.appendMessage(conversationId, "assistant", message.content);
      messages.push({ role: "assistant", content: message.content });

      const toolUses = message.content.filter(
        (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
      );
      const usage = {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
      };
      console.info(
        JSON.stringify({
          event: "agent.step",
          conversationId,
          step,
          stopReason: message.stop_reason,
          toolNames: toolUses.map((t) => t.name),
          latencyMs,
          usage,
        }),
      );

      if (message.stop_reason === "refusal") {
        yield errorEvent("refusal", "The assistant cannot help with this request", false);
        return;
      }
      if (message.stop_reason === "max_tokens") {
        // A tool input cut off by max_tokens can still parse; never run it.
        yield errorEvent("max_tokens", "The reply was cut short; please send a follow-up message", false);
        return;
      }
      if (message.stop_reason === "pause_turn") continue;
      if (toolUses.length === 0 || message.stop_reason === "end_turn") {
        yield { type: "done", stopReason: message.stop_reason ?? "end_turn", usage };
        return;
      }

      const toolResults: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        yield { type: "tool_call", id: toolUse.id, name: toolUse.name, input: toolUse.input };
        const toolStartedAt = Date.now();
        const execution = await executeTool(toolUse.name, toolUse.input, toolCtx);
        const output = execution.ok ? execution.output : { error: execution.error };
        await conversations.recordToolCall({
          conversationId,
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          input: toolUse.input,
          output,
          isError: !execution.ok,
          latencyMs: Date.now() - toolStartedAt,
        });
        yield {
          type: "tool_result",
          id: toolUse.id,
          name: toolUse.name,
          ok: execution.ok,
          summary: execution.summary,
        };
        if (execution.ok && execution.recommendation) {
          yield { type: "recommendation", recommendation: execution.recommendation };
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          is_error: !execution.ok,
          content: execution.ok ? JSON.stringify(execution.output) : execution.error,
        });
      }

      // All results for one assistant turn go back in a single user message, in order.
      await conversations.appendMessage(conversationId, "user", toolResults);
      messages.push({ role: "user", content: toolResults });
    }

    yield errorEvent("step_limit", "The assistant took too many steps; please rephrase or start again", false);
  } catch (err) {
    console.error(JSON.stringify({ event: "agent.turn_failed", conversationId, error: String(err) }));
    yield classifyError(err);
  }
}
