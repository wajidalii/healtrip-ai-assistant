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
 * - stored history is always valid to replay: every `tool_use` the model
 *   emitted is answered by a `tool_result` in the next message, even when the
 *   turn is cut short (max_tokens, refusal, client disconnect, crash);
 * - the turn lock is owned by the HTTP layer, nothing is released here.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AgentEvent, Locale } from "@/shared/contracts";
import type { ConversationRepository, Repositories, StoredMessage } from "@/server/repositories/types";
import type { ClaudeClient, ClaudeStreamOptions, ClaudeStreamParams } from "@/server/agent/claude";
import { GroundingSet } from "@/server/agent/grounding";
import { UrgencyRecord } from "@/server/agent/urgency-record";
import { buildSystem } from "@/server/agent/prompt";
import { TOOL_DEFINITIONS, executeTool, type ToolContext } from "@/server/agent/tools";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type RunTurnInput = {
  conversationId: string;
  userText: string;
  locale: Locale;
  deps: {
    repos: Repositories;
    client: ClaudeClient;
    /** Effective model id (`ProviderProfile.model`): an Anthropic id or a gateway slug. */
    model: string;
    effort: Effort;
    maxSteps: number;
    /**
     * Send the direct-API-only request parameters: `betas` + `fallbacks: "default"`
     * and the top-level `cache_control` (`ProviderProfile.useServerFallbacks`).
     * Defaults to true, the direct-API behaviour; false through the gateway.
     */
    useServerFallbacks?: boolean;
    /** Optional abort signal from the HTTP request. */
    signal?: AbortSignal;
  };
};

/**
 * Output cap per step. Thinking is always on for this model and counts toward
 * it, so the cap scales with effort; it is a ceiling, not a cost, and the
 * request is streamed so a large value has no timeout risk.
 */
export const MAX_TOKENS_BY_EFFORT: Readonly<Record<Effort, number>> = {
  low: 8192,
  medium: 16_000,
  high: 32_000,
  xhigh: 64_000,
  max: 64_000,
};
/** Required for the scalar `fallbacks: "default"` form (see docs/AGENT.md). */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** `tool_result` content for a `tool_use` the loop never ran (see `settlePendingToolUses`). */
const UNANSWERED_TOOL_RESULT =
  "This tool call was not executed: the turn was interrupted before it ran (output cut short, refused or " +
  "cancelled). Do not assume it ran; call it again if you still need it.";

type ErrorEvent = Extract<AgentEvent, { type: "error" }>;
type ModelCallOutcome = { message: Anthropic.Beta.BetaMessage } | { error: ErrorEvent };
type ToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
type ToolResultParam = Anthropic.Beta.BetaToolResultBlockParam;

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

const isToolUseBlock = (block: unknown): block is ToolUseBlock =>
  typeof block === "object" && block !== null && (block as { type?: unknown }).type === "tool_use";

const unansweredResult = (toolUse: ToolUseBlock): ToolResultParam => ({
  type: "tool_result",
  tool_use_id: toolUse.id,
  is_error: true,
  content: UNANSWERED_TOOL_RESULT,
});

/** `tool_use` blocks of the last stored message when it is an assistant message, i.e. with no result after it. */
function trailingToolUses(history: readonly StoredMessage[]): ToolUseBlock[] {
  const last = history.at(-1);
  if (!last || last.role !== "assistant") return [];
  return last.content.filter(isToolUseBlock);
}

/**
 * Tool uses of the current step that have no persisted `tool_result` yet. The
 * executed results are kept in order; the rest get an `is_error` result so the
 * stored history stays valid for the API without editing what the model said.
 */
type PendingToolUses = { toolUses: ToolUseBlock[]; results: ToolResultParam[] };

async function settlePendingToolUses(
  conversations: ConversationRepository,
  conversationId: string,
  pending: PendingToolUses,
): Promise<void> {
  const executed = new Map(pending.results.map((r) => [r.tool_use_id, r]));
  const results = pending.toolUses.map((toolUse) => executed.get(toolUse.id) ?? unansweredResult(toolUse));
  try {
    await conversations.appendMessage(conversationId, "user", results);
  } catch (err) {
    // The next turn repairs a trailing tool_use again (see runTurn); nothing more to do here.
    console.error(JSON.stringify({ event: "agent.settle_failed", conversationId, error: String(err) }));
  }
}

/**
 * One model call: yields text deltas as they arrive and returns the final
 * message, or an error event. Re-issues once on an unparseable tool input,
 * but only if nothing was streamed yet: a second attempt would otherwise
 * repeat the already-displayed text (the SDK raises the JSON error after any
 * preceding text block has streamed).
 */
async function* streamModel(
  client: ClaudeClient,
  params: ClaudeStreamParams,
  options: ClaudeStreamOptions | undefined,
): AsyncGenerator<AgentEvent, ModelCallOutcome> {
  for (let attempt = 0; ; attempt += 1) {
    let streamedText = false;
    try {
      const stream = client.beta.messages.stream(params, options);
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          streamedText = true;
          yield { type: "text_delta", text: event.delta.text };
        }
      }
      return { message: await stream.finalMessage() };
    } catch (err) {
      if (isToolJsonError(err)) {
        if (attempt === 0 && !streamedText) continue;
        return { error: errorEvent("internal_error", "The assistant produced an unreadable reply; please try again", true) };
      }
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
  let pending: PendingToolUses | null = null;

  try {
    const conversation = await conversations.get(conversationId);
    if (!conversation) {
      yield errorEvent("internal_error", "Conversation not found", false);
      return;
    }

    const toolCalls = await conversations.listToolCalls(conversationId);
    const grounding = GroundingSet.fromToolCalls(toolCalls);
    const urgency = UrgencyRecord.fromToolCalls(toolCalls);
    const history = await conversations.listMessages(conversationId);
    // A refusal can leave an assistant message with no content; it stays in the
    // audit trail but the API rejects empty content in history, so it is not replayed.
    const messages = history.filter((m) => m.content.length > 0).map((m) => toMessageParam(m.role, m.content));

    // Crash backstop: a turn killed before its tool results were stored leaves a
    // trailing tool_use, which the API would reject on every later request.
    const dangling = trailingToolUses(history);
    if (dangling.length > 0) {
      const results = dangling.map(unansweredResult);
      await conversations.appendMessage(conversationId, "user", results);
      messages.push({ role: "user", content: results });
    }

    // Persist before pushing so a crash can never leave the API history ahead of the DB.
    const userBlocks: Anthropic.Beta.BetaContentBlockParam[] = [{ type: "text", text: userText }];
    await conversations.appendMessage(conversationId, "user", userBlocks);
    messages.push({ role: "user", content: userBlocks });

    const toolCtx: ToolContext = { conversationId, repos, grounding, urgency, locale };
    const system = buildSystem(locale);
    const streamOptions: ClaudeStreamOptions | undefined = signal ? { signal } : undefined;
    // Mode-specific request parameters are decided once here; the loop below is
    // provider-agnostic. The top-level cache_control adds an automatic breakpoint
    // on the last block of the growing history (the explicit marker on the static
    // system block stays), so each step and turn re-reads the previous one from cache.
    const providerParams: Pick<ClaudeStreamParams, "betas" | "fallbacks" | "cache_control"> =
      deps.useServerFallbacks === false
        ? {}
        : { betas: [FALLBACK_BETA], fallbacks: "default", cache_control: { type: "ephemeral" } };

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
          max_tokens: MAX_TOKENS_BY_EFFORT[deps.effort],
          system,
          tools: [...TOOL_DEFINITIONS],
          messages,
          output_config: { effort: deps.effort },
          ...providerParams,
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

      const toolUses = message.content.filter(isToolUseBlock);
      // From here until they are stored, these tool uses are unanswered; results
      // are collected in `toolResults` as each tool runs.
      const toolResults: ToolResultParam[] = [];
      if (toolUses.length > 0) pending = { toolUses, results: toolResults };

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
          // Category only: it tells a prompt problem from a policy decline; the explanation may echo user text.
          stopDetails: message.stop_details ? { category: message.stop_details.category } : null,
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
      if (toolUses.length > 0 && message.stop_reason !== "tool_use") {
        // compaction / model_context_window_exceeded / stop_sequence with a pending
        // tool_use: like max_tokens, the input may be incomplete, so it is not run.
        console.error(JSON.stringify({ event: "agent.unexpected_stop", conversationId, stopReason: message.stop_reason }));
        yield errorEvent("internal_error", "The assistant stopped unexpectedly; please send a follow-up message", false);
        return;
      }
      if (message.stop_reason === "pause_turn") continue;
      if (toolUses.length === 0) {
        yield { type: "done", stopReason: message.stop_reason ?? "end_turn", usage };
        return;
      }

      for (const toolUse of toolUses) {
        yield { type: "tool_call", id: toolUse.id, name: toolUse.name, input: toolUse.input };
        const toolStartedAt = Date.now();
        const execution = await executeTool(toolUse.name, toolUse.input, toolCtx);
        // Failures keep the model-facing text and the chip summary apart (see tool-summary.ts).
        const output = execution.ok ? execution.output : { error: execution.error, summary: execution.summary };
        await conversations.recordToolCall({
          conversationId,
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          input: toolUse.input,
          output,
          isError: !execution.ok,
          latencyMs: Date.now() - toolStartedAt,
        });
        // Buffered before the yields below: a cancel between them is settled from this record.
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          is_error: !execution.ok,
          content: execution.ok ? JSON.stringify(execution.output) : execution.error,
        });
        yield {
          type: "tool_result",
          id: toolUse.id,
          name: toolUse.name,
          ok: execution.ok,
          summary: execution.summary,
          // The engine's verdict rides on the assess_urgency result so the UI can
          // raise the emergency banner before a recommendation exists.
          ...(execution.ok && execution.urgency ? { urgency: execution.urgency } : {}),
        };
        if (execution.ok && execution.recommendation) {
          yield { type: "recommendation", recommendation: execution.recommendation };
        }
      }

      // All results for one assistant turn go back in a single user message, in order.
      await conversations.appendMessage(conversationId, "user", toolResults);
      messages.push({ role: "user", content: toolResults });
      pending = null;
    }

    yield errorEvent("step_limit", "The assistant took too many steps; please rephrase or start again", false);
  } catch (err) {
    console.error(JSON.stringify({ event: "agent.turn_failed", conversationId, error: String(err) }));
    yield classifyError(err);
  } finally {
    // Runs on every exit, including `iterator.return()` when the client disconnects:
    // whatever the model asked for and did not get an answer to is answered now.
    if (pending) await settlePendingToolUses(conversations, conversationId, pending);
  }
}
